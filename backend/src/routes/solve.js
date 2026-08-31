import { Router } from "express";
import { buildCacheKey, getCached, setCached } from "../services/cache.js";
import { recognizeFromPhotos } from "../services/vision.js";
import { solveTask, solveTaskStream } from "../services/solver.js";
import { verifyAnswer, computeGraphPlots } from "../services/verify.js";
import { validateDrawing } from "../services/drawing.js";
import { isSubjectAllowedForGrade, getSubjectsForGrade } from "../services/subjects.js";
import { recordVerifyEvent } from "../services/telemetry.js";
import { requestSource } from "../middleware/maxInitData.js";
import { ConfigError, InputError, describeApiError } from "../services/anthropicClient.js";

const router = Router();

/**
 * Общее ядро solve-пути для обычного и потокового маршрутов — расходиться
 * им нельзя (кэш, верификация, телеметрия и тексты ошибок одни на двоих).
 *
 * Возвращает { code, body }. Ошибки бросает с err.stage для error_kind.
 * onStep(step, index) — шаги по мере генерации (только не-кэш, не-мульти путь);
 * onRecognized(recognizedText, recognition) — итог vision до начала решения.
 */
async function runSolvePipeline({ body, source, startedAt, transport, appVersion, onStep, onRecognized }) {
  const { imagesBase64, text, subject, quarter, textEdited } = body;
  const grade = Number(body.grade);

  if (!grade || !subject || (!imagesBase64?.length && !text)) {
    return { code: 400, body: { error: "Нужно указать grade, subject и (imagesBase64 или text)" } };
  }
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    return { code: 400, body: { error: "grade должен быть целым числом от 1 до 11" } };
  }

  // Пара (класс, предмет) сверяется с федеральным учебным планом (services/subjects.js).
  // Это защита от кривого клиента, а не от пользователя: штатный фронт такую пару
  // отправить не даст, но молчаливый проход «3 класс + физика» в solver ещё хуже 400.
  if (!isSubjectAllowedForGrade(grade, subject)) {
    return {
      code: 400,
      body: { error: `Предмет «${subject}» не изучается в ${grade} классе. Доступны: ${getSubjectsForGrade(grade).join(", ")}` },
    };
  }

  // Четверть необязательна: без неё считаем программу за весь учебный год.
  const parsedQuarter = quarter === undefined ? 4 : Number(quarter);
  if (!Number.isInteger(parsedQuarter) || parsedQuarter < 1 || parsedQuarter > 4) {
    return { code: 400, body: { error: "quarter должен быть целым числом от 1 до 4" } };
  }

  let recognizedText = text;
  let textbook = null;
  let taskNumber = null;
  let recognition = null;
  let stage = "start";
  const fail = (err) => { err.stage = stage; throw err; };

  if (imagesBase64?.length) {
    stage = "vision";
    try {
      recognition = await recognizeFromPhotos({ imagesBase64, mode: "task", grade, subject });
    } catch (err) { fail(err); }
    recognizedText = recognition.recognizedText;
    textbook = recognition.textbook;
    taskNumber = recognition.taskNumber;

    // Пустой результат в режиме task означает не «плохое фото», а «печатного условия нет»:
    // например, снята одна тетрадь с решением. Совет «переснимите ближе» тут был бы враньём.
    if (!recognizedText) {
      return {
        code: 422,
        body: {
          error:
            "На фото не видно текста задачи из учебника. Пересними страницу так, чтобы " +
            "напечатанное условие целиком попало в кадр. А если это уже решённая работа " +
            "из тетради — проверка домашки появится в приложении чуть позже.",
          recognition,
        },
      };
    }

    // Плохое фото — честно просим переснять, а не решаем «что-то похожее».
    if (recognition.confidence < 0.4) {
      return {
        code: 422,
        body: { error: "Не удалось разобрать текст на фото — пересними ближе и при лучшем свете", recognition },
      };
    }

    // На фото несколько заданий — решать нечего: неизвестно, какое из них нужно ученику.
    // Решение всего листа целиком было бы двойной бесполезной работой (фронт его
    // выбрасывает и перерешивает выбранную задачу) и на контрольной из 14 заданий
    // выходило за таймаут запроса. Отдаём только разметку, фронт спросит, что решать.
    if (recognition.tasks?.length > 1) {
      return { code: 200, body: { source: "recognized", multipleTasks: true, recognizedText, recognition } };
    }
  }

  onRecognized?.(recognizedText, recognition);

  const cacheKey = buildCacheKey({ textbook, grade, subject, taskNumber, rawText: recognizedText });
  const cached = await getCached(cacheKey);

  if (cached) {
    return { code: 200, body: { ...cached, source: "cache", recognizedText, recognition } };
  }

  stage = "solver";
  let solution;
  try {
    solution = onStep
      ? await solveTaskStream({ recognizedText, grade, subject, quarter: parsedQuarter }, onStep)
      : await solveTask({ recognizedText, grade, subject, quarter: parsedQuarter });
  } catch (err) { fail(err); }

  stage = "verify";
  let verification, graphPlots;
  try {
    // Верификация ответа и расчёт точек графика независимы — параллелим,
    // график не добавляет латентности к пути.
    [verification, graphPlots] = await Promise.all([
      verifyAnswer({
        subject,
        expression: solution.formalExpression,
        candidateAnswer: solution.finalAnswer,
        answerValues: solution.answerValues,
      }),
      computeGraphPlots(solution.graph),
    ]);
  } catch (err) { fail(err); }

  const result = {
    ...solution,
    // График — усиление, не условие: сбой расчёта = решение без графика.
    graph: solution.graph && graphPlots ? { ...solution.graph, plots: graphPlots } : null,
    // Чертёж — тот же принцип: противоречивые параметры = отказ, решение без чертежа.
    drawing: validateDrawing(solution.drawing),
    verification,
  };

  recordVerifyEvent({
    route: "solve", source, grade, subject,
    verified: verification.verified, method: verification.method,
    reason: verification.details?.reason ?? null,
    answerKind: solution.answerValues?.kind ?? null,
    invariantViolation: verification.details?.invariantViolation ?? null,
    durationMs: Date.now() - startedAt,
    textEdited: imagesBase64?.length ? null : (textEdited === true ? true : null),
    transport, appVersion,
  }); // fire-and-forget: ответ ученика не ждёт телеметрию

  // Кладём в кэш только реально верифицированные решения — не мок-заглушки.
  if (verification.verified) {
    await setCached(cacheKey, result);
  }

  return { code: 200, body: { ...result, source: "generated", recognizedText, recognition, cacheKey } };
}

/** Общая обработка ошибок ядра: телеметрия + человеческий текст. */
function errorResponse(err, { source, startedAt, transport, appVersion }) {
  console.error(err);
  if (err instanceof InputError) {
    return { code: 400, body: { error: describeApiError(err) } };
  }
  recordVerifyEvent({
    route: "solve", source, durationMs: Date.now() - startedAt,
    errorKind: err instanceof ConfigError ? "config" : (err.stage ?? "start"),
    reason: String(err.message).slice(0, 200),
    transport, appVersion,
  });
  if (err instanceof ConfigError) {
    return { code: 503, body: { error: describeApiError(err) } };
  }
  return { code: 500, body: { error: "Внутренняя ошибка при решении задачи", detail: describeApiError(err) } };
}

/**
 * POST /api/solve
 * body: { imagesBase64?: string[], text?: string, grade: number, subject: string, quarter?: number }
 */
router.post("/", async (req, res) => {
  const startedAt = Date.now();
  const source = requestSource(req);
  // streamFallback выставляет фронт, когда откатывается с потока на POST.
  const transport = req.body?.streamFallback === true ? "fallback" : "post";
  const appVersion = req.get("X-App-Version") ?? null;
  try {
    const { code, body } = await runSolvePipeline({ body: req.body, source, startedAt, transport, appVersion });
    res.status(code).json(body);
  } catch (err) {
    const { code, body } = errorResponse(err, { source, startedAt, transport, appVersion });
    res.status(code).json(body);
  }
});

/**
 * POST /api/solve/stream — тот же вход и тот же итог, но NDJSON-потоком:
 *   {type:"recognized", recognizedText, recognition}   — итог vision (если фото)
 *   {type:"step", index, step}                          — шаги по мере генерации
 *   {type:"final", code, body}                          — ровно то, что отдал бы /api/solve
 *   {type:"error", code, body}                          — ровно то, что отдал бы /api/solve
 * Фронт при любой ошибке потока откатывается на обычный POST — поэтому
 * контракт финального события намеренно совпадает с ответом /api/solve.
 */
router.post("/stream", async (req, res) => {
  const startedAt = Date.now();
  const source = requestSource(req);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  // Ученик закрыл соединение — дописывать некому, но решение ДОРАБАТЫВАЕТ:
  // деньги уже потрачены, verified-результат ляжет в кэш и пригодится.
  let closed = false;
  res.on("close", () => { closed = true; });
  const send = (event) => { if (!closed) res.write(JSON.stringify(event) + "\n"); };

  try {
    const { code, body } = await runSolvePipeline({
      body: req.body, source, startedAt, transport: "stream", appVersion: req.get("X-App-Version") ?? null,
      onRecognized: (recognizedText, recognition) => send({ type: "recognized", recognizedText, recognition }),
      onStep: (step, index) => send({ type: "step", index, step }),
    });
    send({ type: "final", code, body });
  } catch (err) {
    const { code, body } = errorResponse(err, { source, startedAt, transport: "stream", appVersion: req.get("X-App-Version") ?? null });
    send({ type: "error", code, body });
  } finally {
    if (!closed) res.end();
  }
});

export default router;
