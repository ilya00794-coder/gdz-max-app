import { Router } from "express";
import { recognizeFromPhotos } from "../services/vision.js";
import { solveTask } from "../services/solver.js";
import { compareWithReference, crossCheckVerdicts, answerNoteFor } from "../services/compare.js";
import { verifyAnswer } from "../services/verify.js";
import { isSubjectAllowedForGrade, getSubjectsForGrade } from "../services/subjects.js";
import { recordVerifyEvent } from "../services/telemetry.js";
import { isLocalRequest } from "../middleware/maxInitData.js";
import { ConfigError, InputError, describeApiError } from "../services/anthropicClient.js";
import { detectMisread } from "../services/misread.js";

const router = Router();

/**
 * ВРЕМЕННАЯ ЗАГЛУШКА многозадачности — два правила. Правильный слой — vision:
 * studentWork-схема должна размечать tasks[], как это уже делает task-режим
 * (см. backlog «многозадачность в check-пути»).
 *
 * Правило 1: ПОМЕЧЕННЫЕ списки — «а) … б) …», «№8: …», «2) …».
 * Правило 2: столбики примеров — две и более частей списка, где слева от «=»
 *   стоит вычислимое выражение из цифр и операторов («8+2−5=5; 4−2+7=9»),
 *   а не имя переменной. Корни «x = 5; x = 2» и системы «x = 5; y = 3»
 *   не задеваются: слева имена.
 *
 * НЕ покрывается ничем, кроме vision-слоя: одиночный ответ без меток от
 * ДРУГОЙ задачи листа (ma-10: «a = 8 1/6» при reference по соседней задаче) —
 * риск ложного FALSE остаётся. На 29 однозадачных формах ложных срабатываний
 * нет (проверено на заходе 3.2).
 */
const MULTI_TASK_MARKS = /(?:^|;)\s*(?:№\s*\d+|[абвгдежз]\)|\d+\))/i;

export function isMultiTaskAnswer(answer) {
  const text = String(answer ?? "");
  if (MULTI_TASK_MARKS.test(text)) return true;
  let exampleParts = 0;
  for (const part of text.split(/;|\n/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const left = part.slice(0, eq).trim();
    if (/\d/.test(left) && /^[\d\s+\-*/:.,()·×−]+$/.test(left)) exampleParts++;
  }
  return exampleParts >= 2;
}

/**
 * POST /api/check-homework
 * body: { imagesBase64: string[], grade: number, subject: string, quarter?: number }
 *
 * Поток:
 *   1) vision (режим studentWork) — расшифровываем тетрадь как есть, с ошибками;
 *   2) solver — независимо решаем ту же задачу, получаем эталон;
 *   3) compare — LLM сравнивает ход решения по шагам и находит ПЕРВЫЙ ошибочный шаг;
 *   4) verify — SymPy объективно проверяет финальный ответ ученика по формализации из эталона;
 *   5) сверка вердиктов: если LLM и SymPy расходятся, это не «выбери, кому верить»,
 *      а сигнал о баге — логируем и отдаём наружу оба вердикта с пометкой.
 *
 * В ответе «что не так у ученика» (comparison) и «как правильно» (referenceSolution)
 * лежат в РАЗНЫХ полях: UI должен показать их раздельно, а не смешивать в одном экране.
 */
router.post("/", async (req, res) => {
  const startedAt = Date.now();
  const source = isLocalRequest(req) ? "local" : "remote";
  let stage = "start";
  try {
    const { imagesBase64, subject, quarter, workText, condition } = req.body;
    const grade = Number(req.body.grade);

    // Два входа: фото тетради (обычный путь) либо workText — фрагмент работы
    // ОДНОЙ задачи, выбранной на экране «Нашли несколько задач» (vision уже
    // отработал в первом запросе и не повторяется).
    if ((!imagesBase64?.length && !String(workText ?? "").trim()) || !grade || !subject) {
      return res.status(400).json({ error: "Нужно указать grade, subject и imagesBase64 либо workText" });
    }
    if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
      return res.status(400).json({ error: "grade должен быть целым числом от 1 до 11" });
    }

    // Та же сверка пары (класс, предмет) с учебным планом, что в solve.js:
    // защита от кривого клиента, а не от пользователя.
    if (!isSubjectAllowedForGrade(grade, subject)) {
      return res.status(400).json({
        error: `Предмет «${subject}» не изучается в ${grade} классе. Доступны: ${getSubjectsForGrade(grade).join(", ")}`,
      });
    }

    const parsedQuarter = quarter === undefined ? 4 : Number(quarter);
    if (!Number.isInteger(parsedQuarter) || parsedQuarter < 1 || parsedQuarter > 4) {
      return res.status(400).json({ error: "quarter должен быть целым числом от 1 до 4" });
    }

    let recognized;
    if (!imagesBase64?.length) {
      // Фрагментный запрос: распознавание уже сделано, работаем с текстом.
      recognized = { recognizedText: String(workText).trim(), confidence: 1, issues: [], tasks: null };
    } else {
    stage = "vision";
    recognized = await recognizeFromPhotos({
      imagesBase64,
      mode: "studentWork",
      grade,
      subject,
    });

    if (!recognized.recognizedText || recognized.confidence < 0.4) {
      return res.status(422).json({
        error: "Не удалось разобрать написанное в тетради — пересними ближе и при лучшем свете",
        recognition: recognized,
      });
    }

    // На листе несколько задач: не гоняем solver+compare по всему листу
    // (60–80 с и сверка каши), а предлагаем выбрать задачу — как в solve-пути.
    // Дальше придёт фрагментный запрос с workText выбранной задачи.
    if (Array.isArray(recognized.tasks) && recognized.tasks.length > 1) {
      recordVerifyEvent({
        route: "check", source, grade, subject,
        multiTask: true, reason: "на листе несколько задач — предложен выбор",
        durationMs: Date.now() - startedAt,
      });
      return res.json({
        multipleTasks: true,
        recognizedStudentWork: recognized.recognizedText,
        recognition: recognized,
      });
    }
    }

    // Проверка внутренней согласованности выкладок — в фоне, без await:
    // только лог при MISREAD_DETECTION=on, на ответ и вердикт не влияет.
    detectMisread(recognized.recognizedText, { grade, subject });

    stage = "solver";
    const referenceSolution = await solveTask({
      // Фрагментный запрос с переписанным условием — решаем УСЛОВИЕ, а не
      // выкладки ученика: эталон чище.
      recognizedText: String(condition ?? "").trim() || recognized.recognizedText,
      grade,
      subject,
      quarter: parsedQuarter,
    });

    stage = "compare";
    const comparison = await compareWithReference({
      studentWork: recognized.recognizedText,
      referenceSolution,
      grade,
      subject,
    });

    // Объективная проверка финального ответа ученика — тем же SymPy, что и в /api/solve.
    const answerCheck = comparison.studentFinalAnswer && isMultiTaskAnswer(comparison.studentFinalAnswer)
      ? {
          verified: false, confidence: 0, method: "unsupported",
          // Причина честная по смыслу: дело в нескольких задачах на листе,
          // а не в записи ученика.
          details: { reason: "на листе несколько задач — сверка финального ответа по одной задаче не выполнялась" },
        }
      : comparison.studentFinalAnswer
      ? await verifyAnswer({
          subject,
          expression: referenceSolution.formalExpression,
          candidateAnswer: comparison.studentFinalAnswer,
        })
      : { verified: false, confidence: 0, method: "unsupported", details: { reason: "ученик не записал финальный ответ" } };

    // Любое расхождение по-прежнему полностью логируется, но на экран не идёт:
    // направление «sympy false + LLM верно» — почти всегда наш парсер (гасим),
    // «sympy true + LLM ошибка» — нормальный случай, ученику уходит answerNote.
    stage = "verify";
    const isMulti = Boolean(comparison.studentFinalAnswer && isMultiTaskAnswer(comparison.studentFinalAnswer));
    recordVerifyEvent({
      route: "check", source, grade, subject,
      verified: answerCheck.verified, method: answerCheck.method,
      reason: answerCheck.details?.reason ?? null,
      multiTask: isMulti,
      parseFailureKind: isMulti
        ? "multi_task"
        : !comparison.studentFinalAnswer
        ? "no_answer"
        : answerCheck.details?.code ?? null,
      durationMs: Date.now() - startedAt,
    }); // fire-and-forget

    const verdictConflict = crossCheckVerdicts(comparison, answerCheck);
    if (verdictConflict) {
      console.error("[check-homework] РАСХОЖДЕНИЕ ВЕРДИКТОВ", {
        grade,
        subject,
        studentFinalAnswer: comparison.studentFinalAnswer,
        referenceAnswer: referenceSolution.finalAnswer,
        formalExpression: referenceSolution.formalExpression,
        stepByStepIsCorrect: comparison.isCorrect,
        symbolicVerified: answerCheck.verified,
        symbolicDetails: answerCheck.details,
      });
    }

    res.json({
      recognizedStudentWork: recognized.recognizedText,
      recognition: recognized,

      // «Вот что у тебя» — разбор работы ученика.
      comparison: {
        isCorrect: comparison.isCorrect,
        firstMistakeStep: comparison.firstMistakeStep,
        mistakes: comparison.mistakes,
        studentSteps: comparison.studentSteps,
        studentFinalAnswer: comparison.studentFinalAnswer,
        incomplete: comparison.incomplete,
        unreadableFragments: comparison.unreadableFragments,
      },

      // Объективная проверка ответа, независимая от LLM.
      answerCheck,

      // «Вот как правильно» — отдельным полем, чтобы UI не смешал это с разбором ошибок.
      referenceSolution,

      // Заметка «ответ верный, но в решении ошибка» — либо null.
      answerNote: answerNoteFor(comparison, answerCheck),
    });
  } catch (err) {
    console.error(err);
    if (err instanceof InputError) {
      return res.status(400).json({ error: describeApiError(err) });
    }
    if (err instanceof ConfigError) {
      recordVerifyEvent({ route: "check", source, durationMs: Date.now() - startedAt, errorKind: "config", reason: String(err.message).slice(0, 200) });
      return res.status(503).json({ error: describeApiError(err) });
    }
    recordVerifyEvent({ route: "check", source, durationMs: Date.now() - startedAt, errorKind: stage, reason: String(err.message).slice(0, 200) });
    res.status(500).json({
      error: "Внутренняя ошибка при проверке домашней работы",
      detail: describeApiError(err),
    });
  }
});

export default router;
