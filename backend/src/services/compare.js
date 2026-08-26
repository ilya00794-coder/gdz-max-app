// Пошаговое сравнение работы ученика с эталонным решением.
//
// Зачем отдельный вызов модели, а не SymPy: SymPy умеет сверять финальный ответ (это делает
// verify.js), но не умеет читать ход мысли — понять, что ученик потерял знак при переносе
// на третьей строке, символьная алгебра не может. Поэтому здесь LLM, а объективная проверка
// финального ответа остаётся за SymPy.
//
// Эталон — наше собственное решение из solver.js, а не чужой решебник.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getClient, InputError, COMPARE_MODEL, COMPARE_EFFORT } from "./anthropicClient.js";

const ComparisonSchema = z.object({
  studentSteps: z
    .array(z.string())
    .describe("Работа ученика, разбитая на пронумерованные шаги, в том виде, как он её написал."),
  studentFinalAnswer: z
    .string()
    .describe(
      "Финальный ответ ученика, если он его записал: только сам ответ, без пояснений " +
        "(например 'x = 1; x = -5'). Если ученик не довёл решение до ответа — пустая строка."
    ),
  isCorrect: z
    .boolean()
    .describe("Итоговый вердикт: решение ученика математически верно (true) или содержит ошибку (false)."),
  firstMistakeStep: z
    .number()
    .describe(
      "Номер шага из studentSteps, на котором ошибка появилась ВПЕРВЫЕ (нумерация с 1). " +
        "Если ошибок нет — 0."
    ),
  mistakes: z
    .array(
      z.object({
        stepDescription: z
          .string()
          .describe("Где именно ошибка: номер шага и что на этом шаге происходило."),
        whatStudentDid: z
          .string()
          .describe("Что ученик сделал — только факт его действия, без объяснения правильного варианта."),
        whatShouldBeDone: z
          .string()
          .describe("Как надо было сделать на этом шаге. Отдельно от предыдущего поля, не смешивать."),
      })
    )
    .describe("Только реальные математические и логические ошибки. Пустой массив, если ошибок нет."),
  unreadableFragments: z
    .array(z.string())
    .describe(
      "Фрагменты работы, которые нельзя оценить: не распознаны, закрыты рукой, обрезаны. " +
        "Их НЕЛЬЗЯ считать ошибкой. Пустой массив, если всё читаемо."
    ),
  incomplete: z
    .boolean()
    .describe("true, если ученик не довёл решение до конца (нет финального ответа)."),
});

const SYSTEM = `Ты — школьный учитель, который проверяет работу ученика в тетради.

Тебе дают два текста:
1) РАБОТА УЧЕНИКА — расшифровка того, что он написал от руки, со всеми его ошибками.
2) ЭТАЛОННОЕ РЕШЕНИЕ — решение той же задачи, сделанное отдельно и независимо.

Твоя задача — найти, на каком шаге ученик ошибся, а не просто сказать «неверно».

Что считать ошибкой:
- потерянный или перепутанный знак, неверное арифметическое действие;
- неверно применённая формула, перепутанные коэффициенты;
- потерянный корень, лишний корень, невыполненная проверка ОДЗ там, где она нужна;
- логический разрыв: следующая строка не следует из предыдущей.

Что ошибкой НЕ считать:
- другой способ решения. Эталон — лишь ОДИН из верных путей. Если ученик пошёл иначе,
  но каждый его шаг математически верен, — это верное решение, ошибок нет.
- оформление: почерк, пропущенные слова, отсутствие «Ответ:», порядок записи,
  сокращения, отсутствие пояснений к действиям.
- промежуточные записи, которые ученик потом поправил сам.
- фрагменты, которые не удалось прочитать или которые закрыты рукой на фото.
  Их занеси в unreadableFragments и НЕ вменяй ученику в вину. Отсутствие данных —
  не доказательство ошибки.

Правила вердикта:
- isCorrect = true только если в читаемой части работы нет ни одной математической ошибки.
- Если ученик не дописал решение, но всё написанное верно: isCorrect = true,
  incomplete = true, mistakes = [].
- firstMistakeStep — номер первого шага с ошибкой; если ошибок нет, поставь 0.
- Ошибка, которая тянется дальше по решению (ученик ошибся на шаге 3 и дальше считал
  с неверным числом), — это ОДНА ошибка на шаге 3, а не ошибка на каждом следующем шаге.

Разделяй «что сделал ученик» и «как надо» строго по разным полям: whatStudentDid описывает
только его действие, whatShouldBeDone — только правильный ход. Не смешивай их в одном поле
и не пересказывай в whatStudentDid всё эталонное решение.`;

/**
 * Сравнивает работу ученика с эталонным решением по шагам.
 *
 * @param {object} params
 * @param {string} params.studentWork - расшифровка тетради (vision.js, режим studentWork)
 * @param {object} params.referenceSolution - результат solveTask
 * @param {number} params.grade
 * @param {string} params.subject
 * @returns {Promise<z.infer<typeof ComparisonSchema>>}
 */
export async function compareWithReference({ studentWork, referenceSolution, grade, subject }) {
  if (!studentWork || !String(studentWork).trim()) {
    throw new InputError("Пустая работа ученика — нечего сравнивать");
  }
  if (!referenceSolution?.steps?.length) {
    throw new InputError("Нет эталонного решения для сравнения");
  }

  const referenceText = [
    ...referenceSolution.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.content}`),
    `Ответ: ${referenceSolution.finalAnswer}`,
  ].join("\n");

  const client = getClient();

  const response = await client.messages.parse({
    model: COMPARE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: {
      format: zodOutputFormat(ComparisonSchema, "comparison"),
      effort: COMPARE_EFFORT,
    },
    messages: [
      {
        role: "user",
        content: `Ученик: ${grade} класс, предмет «${subject}».

=== РАБОТА УЧЕНИКА ===
${studentWork}

=== ЭТАЛОННОЕ РЕШЕНИЕ (один из верных способов) ===
${referenceText}

Проверь работу ученика и укажи, на каком шаге он ошибся.`,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("Модель не вернула структурированный разбор работы");
  }

  return {
    ...parsed,
    // 0 в схеме означает «ошибок нет» — наружу отдаём null, так честнее для UI.
    firstMistakeStep: parsed.firstMistakeStep > 0 ? parsed.firstMistakeStep : null,
    studentFinalAnswer: parsed.studentFinalAnswer.trim() || null,
  };
}

/**
 * Сверяет два независимых вердикта: пошаговый разбор (LLM) и символьную проверку
 * финального ответа (SymPy).
 *
 * Спорить имеет смысл только когда SymPy реально посчитал: method !== "sympy" означает
 * «проверить не смогли», а не «ответ неверен». При расхождении мы НЕ выбираем, кому верить,
 * — возвращаем описание конфликта, чтобы вызывающий код залогировал его и не показывал
 * ученику вердикт, которому нельзя доверять.
 *
 * @param {{isCorrect: boolean}} comparison
 * @param {{verified: boolean, method: string}} answerCheck
 * @returns {null|{reason: string, stepByStepIsCorrect: boolean, symbolicVerified: boolean}}
 */
export function crossCheckVerdicts(comparison, answerCheck) {
  if (answerCheck?.method !== "sympy") return null;
  if (answerCheck.verified === comparison.isCorrect) return null;

  return {
    reason:
      "Пошаговый разбор и символьная проверка финального ответа дали разные вердикты. " +
      "Показывать ученику вердикт нельзя, пока расхождение не разобрано.",
    stepByStepIsCorrect: comparison.isCorrect,
    symbolicVerified: answerCheck.verified,
  };
}
