import { Router } from "express";
import { buildCacheKey, getCached, setCached } from "../services/cache.js";
import { recognizeFromPhotos } from "../services/vision.js";
import { solveTask } from "../services/solver.js";
import { verifyAnswer } from "../services/verify.js";
import { ConfigError, InputError, describeApiError } from "../services/anthropicClient.js";

const router = Router();

/**
 * POST /api/solve
 * body: { imagesBase64?: string[], text?: string, grade: number, subject: string, quarter?: number }
 *
 * Порядок: сначала распознаём (если фото) -> строим ключ -> смотрим кэш ->
 * если нет в кэше, решаем -> верифицируем -> кладём в кэш (только если верифицировано
 * или это заглушка, помеченная как неверифицированная).
 */
router.post("/", async (req, res) => {
  try {
    const { imagesBase64, text, subject, quarter } = req.body;
    const grade = Number(req.body.grade);

    if (!grade || !subject || (!imagesBase64?.length && !text)) {
      return res.status(400).json({
        error: "Нужно указать grade, subject и (imagesBase64 или text)",
      });
    }
    if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
      return res.status(400).json({ error: "grade должен быть целым числом от 1 до 11" });
    }

    // Четверть необязательна: без неё считаем программу за весь учебный год.
    const parsedQuarter = quarter === undefined ? 4 : Number(quarter);
    if (!Number.isInteger(parsedQuarter) || parsedQuarter < 1 || parsedQuarter > 4) {
      return res.status(400).json({ error: "quarter должен быть целым числом от 1 до 4" });
    }

    let recognizedText = text;
    let textbook = null;
    let taskNumber = null;
    let recognition = null;

    if (imagesBase64?.length) {
      recognition = await recognizeFromPhotos({ imagesBase64, mode: "task", grade, subject });
      recognizedText = recognition.recognizedText;
      textbook = recognition.textbook;
      taskNumber = recognition.taskNumber;

      // Пустой результат в режиме task означает не «плохое фото», а «печатного условия нет»:
      // например, снята одна тетрадь с решением. Совет «переснимите ближе» тут был бы враньём.
      if (!recognizedText) {
        return res.status(422).json({
          error:
            "На фото не найдено печатного условия задачи. Сфотографируйте страницу учебника " +
            "с условием; чтобы проверить уже решённое в тетради, используйте /api/check-homework",
          recognition,
        });
      }

      // Плохое фото — честно просим переснять, а не решаем «что-то похожее».
      if (recognition.confidence < 0.4) {
        return res.status(422).json({
          error: "Не удалось разобрать текст на фото — переснимите ближе и при лучшем свете",
          recognition,
        });
      }
    }

    const cacheKey = buildCacheKey({ textbook, grade, subject, taskNumber, rawText: recognizedText });
    const cached = await getCached(cacheKey);

    if (cached) {
      return res.json({ ...cached, source: "cache", recognizedText, recognition });
    }

    const solution = await solveTask({ recognizedText, grade, subject, quarter: parsedQuarter });
    const verification = await verifyAnswer({
      subject,
      expression: solution.formalExpression,
      candidateAnswer: solution.finalAnswer,
    });

    const result = { ...solution, verification };

    // Кладём в кэш только реально верифицированные решения — не мок-заглушки.
    if (verification.verified) {
      await setCached(cacheKey, result);
    }

    res.json({ ...result, source: "generated", recognizedText, recognition, cacheKey });
  } catch (err) {
    console.error(err);
    if (err instanceof InputError) {
      return res.status(400).json({ error: describeApiError(err) });
    }
    if (err instanceof ConfigError) {
      return res.status(503).json({ error: describeApiError(err) });
    }
    res.status(500).json({ error: "Внутренняя ошибка при решении задачи", detail: describeApiError(err) });
  }
});

export default router;
