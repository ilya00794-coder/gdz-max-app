// POST /api/image и /api/video — разделы «Создать изображение» и «Создать видео».
// Флаги QWEN_IMAGE / QWEN_VIDEO; лимиты 3 картинки и 1 видео В ЧАС (Илья 12.09).
// Усилитель промптов (решение Ильи 12.09 — ВМЕСТО блокирующей модерации):
// qwen-flash переписывает детский промпт в качественный, улучшенный текст
// показываем под результатом. Встроенный фильтр Alibaba неотключаем — его
// реджект переводим в человеческий отказ, не в крэш.
import { Router } from "express";
import { requestSource } from "../middleware/maxInitData.js";
import { qwenChat, describeQwenError, normalizeQwenUsage } from "../services/qwenClient.js";
import { generateImage, editImage, submitVideoTask, getTaskStatus } from "../services/qwenTaskClient.js";
import { featureEnabled, checkHourlyLimit, recordGenEvent, updateGenEventCost } from "../services/aiFeatures.js";
import { storeFromUrl } from "../services/mediaStore.js";
import { hashUser, usageCost } from "../services/telemetry.js";

export const imageRouter = Router();
export const videoRouter = Router();

const IMAGE_MODEL = process.env.QWEN_IMAGE_MODEL || "qwen-image-3.0";
const IMAGE_EDIT_MODEL = process.env.QWEN_IMAGE_EDIT_MODEL || "qwen-image-edit";
const VIDEO_MODEL = process.env.QWEN_VIDEO_MODEL || "wan3.0-video";
const ENHANCE_MODEL = process.env.QWEN_CHAT_MODEL || "qwen-flash";

// Цены генераций (intl, сверено 12.09 по прайсам Model Studio; за ШТУКУ и
// СЕКУНДУ, не за токены — потому не в PRICES telemetry, а здесь).
const MEDIA_COST = { image: 0.03, imageEdit: 0.045, videoPerSec: 0.05 /* 480P */ };
const VIDEO_SECONDS = 5;
const VIDEO_RESOLUTION = "480P"; // ЖЁСТКО (Илья 12.09): дефолт DashScope — 1080P = $1.00/ролик
// Тариф wan3.0 по фактическому SR из usage задачи — для честной телеметрии.
const VIDEO_PRICE_BY_SR = { 480: 0.05, 720: 0.1, 1080: 0.2 };
// taskId → {genEventId, startedAt}: правка стоимости на done. В памяти процесса:
// после рестарта правки не будет — останется оценка сабмита (терпимо).
const videoTaskLedger = new Map();

/** Усилитель: детский промпт → развёрнутый (композиция/стиль/свет). Сбой
 * усилителя НЕ валит генерацию — уходит исходный промпт (усилитель — бонус). */
async function enhancePrompt(prompt, target) {
  // ОБРАБОТКА ФОТО: LLM-усилитель здесь ВРЕДЕН — два живых кейса 12.09
  // («мультяшный мальчик» вместо Ильи; «девочки с усами» → придуманная
  // вечерняя улица вместо усов). Точечная правка = точечный шаблон, без LLM:
  if (target === "edit") {
    return {
      text: `${prompt}. Внеси только это изменение. Всё остальное оставь ровно как на исходной фотографии: фон, обстановку, людей, их позы, одежду и лица (кроме запрошенного изменения). Фотореалистично.`,
      cost: 0,
    };
  }
  const system = `Ты — редактор промптов для генерации ${target === "video" ? "видео" : "изображений"} в детском приложении. Перепиши запрос пользователя в один развёрнутый промпт по-русски: добавь композицию, стиль, свет, настроение, детали. Сохрани замысел, сделай сцену яркой и доброй. Уложись в 400 символов. Ответь ТОЛЬКО текстом промпта, без пояснений.`;
  try {
    const r = await qwenChat({
      model: ENHANCE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 450,
    }, { timeoutMs: 20_000 });
    const text = r.choices?.[0]?.message?.content?.trim();
    const cost = usageCost(normalizeQwenUsage(r.usage), ENHANCE_MODEL) ?? 0;
    return { text: text || prompt, cost };
  } catch (err) {
    console.warn(new Date().toISOString(), "[ai-media] усилитель промпта упал, идёт исходный:", err.message);
    return { text: prompt, cost: 0 };
  }
}

/** Общая обвязка обоих роутов: флаг → лимит → усилитель → генерация → телеметрия. */
function mediaHandler({ kind, flagName, run }) {
  return async (req, res) => {
    const startedAt = Date.now();
    const source = requestSource(req);
    if (!featureEnabled(flagName, source, req.max?.userId)) {
      return res.status(503).json({ error: "Раздел пока выключен" });
    }
    const userHash = hashUser(req.max?.userId);
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt || prompt.length > 1000) {
      return res.status(400).json({ error: "Опиши, что сгенерировать (до 1000 символов)" });
    }
    const { allowed, used, limit } = await checkHourlyLimit(kind, userHash, source);
    if (!allowed) {
      const what = kind === "video" ? "видео" : "картинок";
      return res.status(429).json({ error: `Лимит ${what} — ${limit} в час. Возвращайся чуть позже!`, limitReached: true });
    }
    const enhanced = await enhancePrompt(prompt, kind === "image" && req.body?.imageBase64 ? "edit" : kind);
    try {
      const { url, model, mediaCost } = await run(req, enhanced.text);
      recordGenEvent({
        kind, source, userHash, model, prompt, enhancedPrompt: enhanced.text,
        ok: true, durationMs: Date.now() - startedAt, costUsd: mediaCost + enhanced.cost,
      });
      res.json({ url, enhancedPrompt: enhanced.text, used: used + 1, limit });
    } catch (err) {
      recordGenEvent({ kind, source, userHash, prompt, enhancedPrompt: enhanced.text, ok: false, errorKind: String(err.message).slice(0, 160), durationMs: Date.now() - startedAt, costUsd: enhanced.cost });
      console.error(new Date().toISOString(), `[ai-${kind}] сбой:`, err.message);
      // Реджект встроенной модерации DashScope приходит кодом DataInspectionFailed.
      const friendly = /inspection|green|risk/i.test(String(err.message))
        ? "Такое сгенерировать не получилось — попробуй переформулировать запрос"
        : describeQwenError(err);
      res.status(502).json({ error: friendly });
    }
  };
}

imageRouter.post("/", mediaHandler({
  kind: "image",
  flagName: "QWEN_IMAGE",
  run: async (req, enhancedPrompt) => {
    const photo = req.body?.imageBase64; // data-URL или голый base64 → режим обработки фото
    if (photo) {
      const dataUrl = String(photo).startsWith("data:") ? String(photo) : `data:image/jpeg;base64,${photo}`;
      const { url } = await editImage({ model: IMAGE_EDIT_MODEL, prompt: enhancedPrompt, imageDataUrl: dataUrl });
      return { url: await storeFromUrl(url, ".png"), model: IMAGE_EDIT_MODEL, mediaCost: MEDIA_COST.imageEdit };
    }
    const { url } = await generateImage({ model: IMAGE_MODEL, prompt: enhancedPrompt });
    return { url: await storeFromUrl(url, ".png"), model: IMAGE_MODEL, mediaCost: MEDIA_COST.image };
  },
}));

// Видео: САБМИТ задачи → {taskId}; статус опрашивает клиент (генерация минуты,
// держать POST открытым сквозь ngrok/вебвью ненадёжно). Лимит и стоимость
// пишутся на сабмите (цена ролика фиксированная; при сбое экономика чуть
// завышена — сбои редки, точность приемлема, отдельная строка ok=false
// добавляется статус-роутом для видимости сбоев).
videoRouter.post("/", async (req, res) => {
  const startedAt = Date.now();
  const source = requestSource(req);
  if (!featureEnabled("QWEN_VIDEO", source, req.max?.userId)) {
    return res.status(503).json({ error: "Раздел пока выключен" });
  }
  const userHash = hashUser(req.max?.userId);
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt || prompt.length > 1000) {
    return res.status(400).json({ error: "Опиши, что сгенерировать (до 1000 символов)" });
  }
  const { allowed, used, limit } = await checkHourlyLimit("video", userHash, source);
  if (!allowed) {
    return res.status(429).json({ error: `Лимит видео — ${limit} в час. Возвращайся чуть позже!`, limitReached: true });
  }
  const enhanced = await enhancePrompt(prompt, "video");
  try {
    const { taskId } = await submitVideoTask({ model: VIDEO_MODEL, prompt: enhanced.text, resolution: VIDEO_RESOLUTION, durationSec: VIDEO_SECONDS });
    recordGenEvent({
      kind: "video", source, userHash, model: VIDEO_MODEL, prompt, enhancedPrompt: enhanced.text,
      ok: true, durationMs: Date.now() - startedAt,
      costUsd: MEDIA_COST.videoPerSec * VIDEO_SECONDS + enhanced.cost,
    }).then((id) => {
      if (id) videoTaskLedger.set(taskId, { genEventId: id, enhCost: enhanced.cost, startedAt });
      if (videoTaskLedger.size > 500) videoTaskLedger.delete(videoTaskLedger.keys().next().value);
    });
    res.json({ taskId, enhancedPrompt: enhanced.text, used: used + 1, limit });
  } catch (err) {
    recordGenEvent({ kind: "video", source, userHash, prompt, enhancedPrompt: enhanced.text, ok: false, errorKind: String(err.message).slice(0, 160), durationMs: Date.now() - startedAt, costUsd: enhanced.cost });
    console.error(new Date().toISOString(), "[ai-video] сбой сабмита:", err.message);
    const friendly = /inspection|green|risk/i.test(String(err.message))
      ? "Такое сгенерировать не получилось — попробуй переформулировать запрос"
      : describeQwenError(err);
    res.status(502).json({ error: friendly });
  }
});

// GET /api/video/status?taskId=... — один опрос; фронт зовёт раз в ~10 с.
videoRouter.get("/status", async (req, res) => {
  const source = requestSource(req);
  if (!featureEnabled("QWEN_VIDEO", source, req.max?.userId)) {
    return res.status(503).json({ error: "Раздел пока выключен" });
  }
  const taskId = String(req.query?.taskId ?? "").trim();
  if (!taskId || taskId.length > 128) return res.status(400).json({ error: "Нужен taskId" });
  try {
    const s = await getTaskStatus(taskId);
    if (s.status === "done") {
      s.url = await storeFromUrl(s.url, ".mp4"); // OSS вебвью не откроет; наш хост откроет
      // Честная стоимость по ФАКТУ (usage.SR): если параметр разрешения вдруг
      // не применился (ловушка 12.09 — два ролика 1080P по $1.00 при записи
      // $0.25), телеметрия не должна врать, как было с единым Opus-тарифом.
      const led = videoTaskLedger.get(taskId);
      const sr = s.usage?.SR;
      const secs = s.usage?.output_video_duration ?? VIDEO_SECONDS;
      if (led && sr && VIDEO_PRICE_BY_SR[sr]) {
        const actual = VIDEO_PRICE_BY_SR[sr] * secs + led.enhCost;
        updateGenEventCost(led.genEventId, actual, Date.now() - led.startedAt);
        videoTaskLedger.delete(taskId);
        if (sr !== 480) console.warn(new Date().toISOString(), `[ai-video] ФАКТИЧЕСКОЕ разрешение ${sr}P (просили ${VIDEO_RESOLUTION}) — стоимость поправлена на $${actual.toFixed(2)}`);
      }
    }
    if (s.status === "failed") {
      const led = videoTaskLedger.get(taskId);
      if (led) { // неуспех не тарифицируется DashScope — оставляем только цену усилителя
        updateGenEventCost(led.genEventId, led.enhCost);
        videoTaskLedger.delete(taskId);
      }
      recordGenEvent({ kind: "video", source, userHash: hashUser(req.max?.userId), ok: false, errorKind: String(s.error).slice(0, 160) });
      const friendly = /inspection|green|risk/i.test(String(s.error))
        ? "Такое сгенерировать не получилось — попробуй переформулировать запрос"
        : "Генерация видео не удалась — попробуй ещё раз";
      return res.json({ status: "failed", error: friendly });
    }
    res.json(s);
  } catch (err) {
    console.error(new Date().toISOString(), "[ai-video] сбой статуса:", err.message);
    res.status(502).json({ error: describeQwenError(err) });
  }
});
