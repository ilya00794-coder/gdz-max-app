import { Router } from "express";
import { recognizeFromPhotos } from "../services/vision.js";
import { solveTask } from "../services/solver.js";
import { compareWithReference, crossCheckVerdicts } from "../services/compare.js";
import { verifyAnswer } from "../services/verify.js";
import { isSubjectAllowedForGrade, getSubjectsForGrade } from "../services/subjects.js";
import { ConfigError, InputError, describeApiError } from "../services/anthropicClient.js";
import { detectMisread } from "../services/misread.js";

const router = Router();

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
  try {
    const { imagesBase64, subject, quarter } = req.body;
    const grade = Number(req.body.grade);

    if (!imagesBase64?.length || !grade || !subject) {
      return res.status(400).json({ error: "Нужно указать imagesBase64, grade и subject" });
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

    const recognized = await recognizeFromPhotos({
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

    // Проверка внутренней согласованности выкладок — в фоне, без await:
    // только лог при MISREAD_DETECTION=on, на ответ и вердикт не влияет.
    detectMisread(recognized.recognizedText, { grade, subject });

    const referenceSolution = await solveTask({
      recognizedText: recognized.recognizedText,
      grade,
      subject,
      quarter: parsedQuarter,
    });

    const comparison = await compareWithReference({
      studentWork: recognized.recognizedText,
      referenceSolution,
      grade,
      subject,
    });

    // Объективная проверка финального ответа ученика — тем же SymPy, что и в /api/solve.
    const answerCheck = comparison.studentFinalAnswer
      ? await verifyAnswer({
          subject,
          expression: referenceSolution.formalExpression,
          candidateAnswer: comparison.studentFinalAnswer,
        })
      : { verified: false, confidence: 0, method: "unsupported", details: { reason: "ученик не записал финальный ответ" } };

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

      // null — вердикты согласованы; иначе объект с обоими вердиктами.
      verdictConflict,
    });
  } catch (err) {
    console.error(err);
    if (err instanceof InputError) {
      return res.status(400).json({ error: describeApiError(err) });
    }
    if (err instanceof ConfigError) {
      return res.status(503).json({ error: describeApiError(err) });
    }
    res.status(500).json({
      error: "Внутренняя ошибка при проверке домашней работы",
      detail: describeApiError(err),
    });
  }
});

export default router;
