// Решение задачи "с нуля" — собственным AI-пайплайном, БЕЗ использования текстов чужих ГДЗ.
//
// Ключевое отличие от "просто спросить модель": решение ограничено программой класса.
// Список методов, доступных ученику к этому моменту, берётся из curriculum.js
// (данные — официальные ФРП, см. backend/src/data/curriculum/SOURCES.md) и передаётся
// модели как белый список. Шестикласснику нельзя объяснять через дискриминант,
// даже если так короче: он его ещё не проходил.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getClient, InputError, SOLVER_MODEL, SOLVER_EFFORT } from "./anthropicClient.js";
import { getAllowedMethods, getStudiedTopics, isSubjectSupported } from "./curriculum.js";

const SolutionSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().describe("Короткий заголовок шага, 2–5 слов — он выносится на экран свайпа."),
        content: z
          .string()
          .describe("Один шаг решения: одна мысль, 1–4 предложения. Формулы — в LaTeX внутри $...$."),
      })
    )
    .describe("Решение по шагам для свайпового интерфейса. От 2 до 8 шагов."),
  finalAnswer: z
    .string()
    .describe("Только финальный ответ, без объяснений. Например: '4,5 см' или 'x = 3; x = -7'."),
  formalExpression: z
    .string()
    .describe(
      "Задача в формальной записи для автоматической проверки через SymPy. Это должен быть " +
        "корректный Python/SymPy-код: знак равенства уравнения записывается как Eq(левая, правая) " +
        "или переносом всего в одну часть, но НИКОГДА как одиночное '='. " +
        "Правильно: 'solve(Eq(2*x + 5, 17), x)' или 'solve(2*x + 5 - 17, x)'. " +
        "Неправильно: 'solve(2*x + 5 = 17, x)'. " +
        "Если задача не формализуется — пустая строка."
    ),
  usedMethods: z
    .array(z.string())
    .describe("Какие методы из разрешённого списка использованы. Дословно, как в списке."),
  programWarning: z
    .string()
    .describe(
      "Если задачу нельзя решить разрешёнными методами — объясни здесь, чего не хватает. " +
        "Если всё в порядке — пустая строка."
    ),
  graph: z
    .object({
      expressions: z
        .array(
          z.string().describe(
            "ТОЛЬКО правая часть y = f(x) в SymPy-записи (Python-синтаксис, умножение звёздочкой): " +
              "'x**2 - 4*x + 3', '1/(x - 2)'. НЕ уравнение, НЕ solve(...), НЕ координаты точек."
          )
        )
        .min(1)
        .max(2)
        .describe(
          "Одна функция — один элемент. Две — только для системы двух уравнений " +
            "(каждое выражено как y = f(x)): пересечение прямых и есть решение."
        ),
      xRange: z
        .tuple([z.number(), z.number()])
        .describe("Диапазон оси x [от, до], охватывающий всё интересное: нули, вершину, асимптоты."),
      comment: z
        .string()
        .describe("Одна короткая фраза для ученика: что видно на графике. Например: 'Вершина параболы — точка минимума'."),
    })
    .nullable()
    .describe(
      "График функции, ЕСЛИ он помогает понять решение (критерий в инструкции). " +
        "Точки и координаты НЕ вычисляй — только функция, диапазон и комментарий. Обычно null."
    ),
});

const SYSTEM_BASE = `Ты — школьный репетитор в приложении-помощнике по домашним заданиям.
Ученик присылает условие задачи, ты даёшь полное верное решение по шагам.

Как ты работаешь:
- Решай задачу САМ, с нуля, рассуждая от условия. Не воспроизводи по памяти текст
  из решебников, ГДЗ или учебников — объясняй своими словами.
- Решение разбивается на шаги для свайпового интерфейса: один шаг — одна мысль.
  Ученик листает их как сторис, поэтому длинные простыни недопустимы.
- Первый шаг — всегда разбор условия: что дано, что найти.
- Последний шаг — получение ответа, а сам ответ дублируется отдельным полем.
- Формулы записывай в LaTeX внутри $...$.
- Проверь ответ до того, как его выдать: подстановкой, обратным действием, прикидкой,
  проверкой единиц измерения и здравого смысла (скорость пешехода не 200 км/ч).

Главное ограничение — программа класса:
- Тебе дают список методов, которые ученик УЖЕ прошёл. Решай только ими.
- Если знаешь более короткий способ, но его нет в списке — он запрещён. Используй разрешённый,
  даже если решение получится длиннее.
- Терминологию тоже держи в рамках списка: не называй то, чего ученик ещё не проходил.
- Если задачу вообще нельзя решить разрешёнными методами — всё равно реши её доступным
  способом настолько, насколько возможно, и опиши нехватку в поле programWarning.
  Не молчи об этом и не выходи за программу молча.

График (поле graph) — только когда он реально помогает понять:
- КРИТЕРИЙ ВАЖНЕЕ ПОЛЯ. График — редкое усиление, а не украшение каждого ответа.
- НУЖЕН: исследование функции; парабола и её вершина; система двух линейных уравнений
  как пересечение прямых; неравенство методом интервалов; область определения функции.
- НЕ НУЖЕН: линейное уравнение вида 2x + 8 = 20; арифметика и вычисления; текстовая
  задача без функции; геометрия (там нужен чертёж, а не график функции — это не твоя задача).
- Ты НЕ вычисляешь координаты, точки и таблицы значений — только называешь функцию
  (правая часть y = f(x) в SymPy-записи), диапазон x и одну фразу-комментарий.
  Все точки посчитает система автоматически.
- Для системы двух линейных уравнений выражай y из каждого уравнения и клади ДВЕ
  функции в expressions — их пересечение и есть решение системы.
- Сомневаешься — ставь null.`;

/** Собирает блок системного промпта с белым списком методов. Вынесен отдельно ради кэширования. */
function buildProgramBlock({ grade, subject, quarter }) {
  if (!isSubjectSupported(subject)) {
    return {
      text: `ПРОГРАММА КЛАССА
Ученик: ${grade} класс, предмет «${subject}».
Программа по этому предмету пока не оцифрована, точного списка методов нет.
Ориентируйся на типичный уровень ${grade} класса и не используй методы старших классов.`,
      methods: [],
      supported: false,
    };
  }

  const methods = getAllowedMethods({ grade, subject, quarter });
  const currentGradeTopics = getStudiedTopics({ grade, subject, quarter })
    .filter((t) => t.grade === grade)
    .map((t) => `${t.quarter} четверть, ${t.course}: ${t.topic}`);

  const text = `ПРОГРАММА КЛАССА
Ученик: ${grade} класс, ${quarter} четверть, предмет «${subject}».

Темы, которые ученик проходит в этом учебном году к текущему моменту:
${currentGradeTopics.map((t) => `- ${t}`).join("\n")}

РАЗРЕШЁННЫЕ МЕТОДЫ РЕШЕНИЯ (${methods.length} шт., накопительно с 1 класса).
Использовать можно только их:
${methods.map((m) => `- ${m}`).join("\n")}`;

  return { text, methods, supported: true };
}

/**
 * Решает задачу с учётом класса, предмета и четверти.
 *
 * @param {object} params
 * @param {string} params.recognizedText - условие задачи (из vision.js или введённое текстом)
 * @param {number} params.grade - класс ученика, 1–11
 * @param {string} params.subject - предмет
 * @param {number} [params.quarter=4] - четверть; по умолчанию 4, то есть "за весь учебный год"
 * @returns {Promise<{
 *   steps: {title:string, content:string}[],
 *   finalAnswer: string,
 *   formalExpression: string|null,
 *   usedMethods: string[],
 *   programWarning: string|null,
 *   program: { supported: boolean, allowedMethodsCount: number, quarter: number }
 * }>}
 */
export async function solveTask({ recognizedText, grade, subject, quarter = 4 }) {
  if (!recognizedText || !String(recognizedText).trim()) {
    throw new InputError("Пустое условие задачи — нечего решать");
  }
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    throw new InputError(`Класс должен быть числом от 1 до 11, получено: ${grade}`);
  }
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new InputError(`Четверть должна быть числом от 1 до 4, получено: ${quarter}`);
  }

  const program = buildProgramBlock({ grade, subject, quarter });
  const client = getClient();

  const response = await client.messages.parse({
    model: SOLVER_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: SYSTEM_BASE },
      // Блок программы стабилен для пары (класс, предмет, четверть) — кэшируем префикс,
      // чтобы не платить за него на каждой задаче.
      { type: "text", text: program.text, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      format: zodOutputFormat(SolutionSchema, "solution"),
      effort: SOLVER_EFFORT,
    },
    messages: [
      {
        role: "user",
        content: `Условие задачи:\n\n${recognizedText}\n\nРеши её, соблюдая ограничения программы класса.`,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("Модель не вернула структурированное решение");
  }

  return {
    steps: parsed.steps,
    finalAnswer: parsed.finalAnswer.trim(),
    formalExpression: parsed.formalExpression.trim() || null,
    usedMethods: parsed.usedMethods ?? [],
    programWarning: parsed.programWarning?.trim() || null,
    graph: parsed.graph ?? null,
    program: {
      supported: program.supported,
      allowedMethodsCount: program.methods.length,
      quarter,
    },
  };
}
