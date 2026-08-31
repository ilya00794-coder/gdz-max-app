import { Router } from "express";
import { buildCacheKey, getCached, setCached } from "../services/cache.js";
import { recognizeFromPhotos } from "../services/vision.js";
import { solveTask, solveTaskStream } from "../services/solver.js";
import { verifyAnswer, computeGraphPlots } from "../services/verify.js";
import { validateFigure, legacyFigure } from "../services/figure.js";
import { reportError } from "../services/alerts.js";
import { isSubjectAllowedForGrade, getSubjectsForGrade } from "../services/subjects.js";
import { recordVerifyEvent, hashUser, addUsage, usageCost } from "../services/telemetry.js";
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
async function runSolvePipeline({ body, source, startedAt, transport, appVersion, userHash, startParam, onStep, onRecognized }) {
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
  let visionUsage = null;
  let stage = "start";
  const fail = (err) => { err.stage = stage; throw err; };

  if (imagesBase64?.length) {
    stage = "vision";
    try {
      recognition = await recognizeFromPhotos({ imagesBase64, mode: "task", grade, subject });
    } catch (err) { fail(err); }
    // usage — внутренняя экономика, клиенту в recognition не уходит.
    visionUsage = recognition.usage ?? null;
    delete recognition.usage;
    recognizedText = recognition.recognizedText;
    textbook = recognition.textbook;
    taskNumber = recognition.taskNumber;

    // Пустой результат в режиме task означает не «плохое фото», а «печатного условия нет»:
    // например, снята одна тетрадь с решением. Совет «переснимите ближе» тут был бы враньём.
    if (!recognizedText) {
      // Отказ, который видит пользователь, — единственный сбой, после
      // которого он уходит; без события баг с доской был бы виден только
      // из жалоб (так и случилось). reason — класс отказа, не текст.
      recordVerifyEvent({
        route: "solve", source, grade, subject,
        errorKind: "refusal", reason: "no_task_found",
        inputTokens: visionUsage?.input_tokens ?? null,
        outputTokens: visionUsage?.output_tokens ?? null,
        costUsd: usageCost(visionUsage),
        durationMs: Date.now() - startedAt, transport, appVersion, userHash, startParam,
      });
      return {
        code: 422,
        body: {
          error:
            "Не нашли на фото условия задачи. Сфотографируй условие целиком — " +
            "из учебника, с карточки или с доски. А если это уже решённая работа — " +
            "выбери на главном экране «Проверить домашку».",
          recognition,
        },
      };
    }

    // Плохое фото — честно просим переснять, а не решаем «что-то похожее».
    if (recognition.confidence < 0.4) {
      recordVerifyEvent({
        route: "solve", source, grade, subject,
        errorKind: "refusal", reason: "low_confidence",
        inputTokens: visionUsage?.input_tokens ?? null,
        outputTokens: visionUsage?.output_tokens ?? null,
        costUsd: usageCost(visionUsage),
        durationMs: Date.now() - startedAt, transport, appVersion, userHash, startParam,
      });
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
      // Не отказ, а развилка выбора задачи — помечается отдельно (multiTask).
      recordVerifyEvent({
        route: "solve", source, grade, subject,
        multiTask: true, reason: "multiple_tasks_choice",
        inputTokens: visionUsage?.input_tokens ?? null,
        outputTokens: visionUsage?.output_tokens ?? null,
        costUsd: usageCost(visionUsage),
        durationMs: Date.now() - startedAt, transport, appVersion, userHash, startParam,
      });
      return { code: 200, body: { source: "recognized", multipleTasks: true, recognizedText, recognition } };
    }
  }

  onRecognized?.(recognizedText, recognition);

  const cacheKey = buildCacheKey({ grade, subject, rawText: recognizedText });
  const cached = await getCached(cacheKey);

  if (cached) {
    // Кэш-хит теперь пишется в телеметрию (закрытое слепое пятно): это
    // «решено задач» и экономия кэша — ответ пришёл бесплатно.
    recordVerifyEvent({
      route: "solve", source, grade, subject,
      cacheHit: true, costUsd: 0,
      inputTokens: visionUsage?.input_tokens ?? null,
      outputTokens: visionUsage?.output_tokens ?? null,
      durationMs: Date.now() - startedAt,
      transport, appVersion, userHash, startParam,
    });
    // Записи до слияния visual+drawing (31.08.2026) хранят старые поля —
    // конвертируем на лету, чтобы старый кэш рендерился, а не прятал карточку.
    const figure = cached.figure ?? legacyFigure(cached);
    return { code: 200, body: { ...cached, figure, source: "cache", recognizedText, recognition } };
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

  // usage — внутренняя экономика: не в кэш и не клиенту.
  const solverUsage = solution.usage ?? null;
  delete solution.usage;
  const totalUsage = addUsage(visionUsage, solverUsage);

  const result = {
    ...solution,
    // График — усиление, не условие: сбой расчёта = решение без графика.
    graph: solution.graph && graphPlots ? { ...solution.graph, plots: graphPlots } : null,
    // Рисунок/чертёж — тот же принцип: противоречивые параметры = отказ, решение без рисунка.
    figure: validateFigure(solution.figure),
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
    transport, appVersion, userHash, startParam,
    cacheHit: false,
    inputTokens: totalUsage.input_tokens + totalUsage.cache_read_input_tokens + totalUsage.cache_creation_input_tokens,
    outputTokens: totalUsage.output_tokens,
    costUsd: usageCost(totalUsage),
  }); // fire-and-forget: ответ ученика не ждёт телеметрию

  // Кладём в кэш только реально верифицированные решения — не мок-заглушки.
  if (verification.verified) {
    await setCached(cacheKey, result);
  }

  return { code: 200, body: { ...result, source: "generated", recognizedText, recognition, cacheKey } };
}

/** Общая обработка ошибок ядра: телеметрия + человеческий текст. */
function errorResponse(err, { source, startedAt, transport, appVersion, userHash = null, startParam = null, rawUserId = null }) {
  console.error(err);
  if (err instanceof InputError) {
    return { code: 400, body: { error: describeApiError(err) } };
  }
  const kind = err instanceof ConfigError ? "config" : (err.stage ?? "start");
  recordVerifyEvent({
    route: "solve", source, durationMs: Date.now() - startedAt,
    errorKind: kind,
    reason: String(err.message).slice(0, 200),
    transport, appVersion, userHash, startParam,
  });
  // Немедленный алерт админам; живой пользователь запоминается для /починили.
  reportError({ kind, reason: err.message, route: "solve", source, userId: rawUserId });
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
  const userHash = hashUser(req.max?.userId);
  const startParam = req.max?.params?.start_param ?? null;
  try {
    const { code, body } = await runSolvePipeline({ body: req.body, source, startedAt, transport, appVersion, userHash, startParam });
    res.status(code).json(body);
  } catch (err) {
    const { code, body } = errorResponse(err, { source, startedAt, transport, appVersion, userHash, startParam, rawUserId: req.max?.userId ?? null });
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

  const userHash = hashUser(req.max?.userId);
  const startParam = req.max?.params?.start_param ?? null;
  try {
    const { code, body } = await runSolvePipeline({
      body: req.body, source, startedAt, transport: "stream", appVersion: req.get("X-App-Version") ?? null,
      userHash, startParam,
      onRecognized: (recognizedText, recognition) => send({ type: "recognized", recognizedText, recognition }),
      onStep: (step, index) => send({ type: "step", index, step }),
    });
    send({ type: "final", code, body });
  } catch (err) {
    const { code, body } = errorResponse(err, { source, startedAt, transport: "stream", appVersion: req.get("X-App-Version") ?? null, userHash, startParam, rawUserId: req.max?.userId ?? null });
    send({ type: "error", code, body });
  } finally {
    if (!closed) res.end();
  }
});

export default router;
