// Клиент асинхронных генераций DashScope (изображение/видео, 12.09.2026).
// Родной task-API: POST с X-DashScope-Async: enable → task_id → поллинг
// GET /tasks/{id} до SUCCEEDED/FAILED. Тот же ключ, что qwenClient.
import { QwenApiError, QwenConfigError } from "./qwenClient.js";

const BASE = "https://dashscope-intl.aliyuncs.com/api/v1";

function apiKey() {
  if (!process.env.QWEN_API_KEY) throw new QwenConfigError("Не задан QWEN_API_KEY");
  return process.env.QWEN_API_KEY;
}

async function call(path, { method = "POST", body, async = false, timeoutMs = 60_000 } = {}) {
  const r = await fetch(BASE + path, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey(),
      ...(async ? { "X-DashScope-Async": "enable" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new QwenApiError(r.status, j?.message || JSON.stringify(j)?.slice(0, 300) || `HTTP ${r.status}`);
  return j;
}

/**
 * Запускает задачу и ждёт результата поллингом.
 * @returns {Promise<{output: object, usage: object|null, taskId: string}>}
 *   output — блок output задачи в статусе SUCCEEDED (внутри results/video_url).
 * Бросает QwenApiError при FAILED (message — код+текст DashScope, там же
 * прилетает реджект встроенной модерации Alibaba).
 */
export async function runTask(path, body, { pollMs = 5000, maxWaitMs = 300_000 } = {}) {
  const submitted = await call(path, { body, async: true });
  const taskId = submitted.output?.task_id;
  if (!taskId) throw new QwenApiError(500, "DashScope не вернул task_id: " + JSON.stringify(submitted).slice(0, 200));
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, pollMs));
    const t = await call(`/tasks/${taskId}`, { method: "GET", timeoutMs: 30_000 });
    const status = t.output?.task_status;
    if (status === "SUCCEEDED") return { output: t.output, usage: t.usage ?? null, taskId };
    if (status === "FAILED" || status === "CANCELED") {
      throw new QwenApiError(502, `${t.output?.code ?? status}: ${t.output?.message ?? "генерация не удалась"}`);
    }
    if (Date.now() > deadline) throw new QwenApiError(504, `генерация не успела за ${Math.round(maxWaitMs / 1000)}с (статус ${status})`);
  }
}

/** Достаёт url картинки из ответа multimodal-generation (варианты форм). */
function imageUrlFrom(j) {
  const content = j.output?.choices?.[0]?.message?.content;
  const fromContent = Array.isArray(content) ? content.find((c) => c.image)?.image : null;
  return fromContent || j.output?.results?.find((x) => x.url)?.url || null;
}

/** Текст → изображение. qwen-image-3.0 — СИНХРОННЫЙ multimodal-эндпоинт
 * (сверено с API-референсом 12.09: input.messages, не input.prompt).
 * prompt_extend выключен — усилитель промптов у нас свой (виден пользователю). */
export async function generateImage({ model, prompt, size = "1328*1328" }) {
  const j = await call("/services/aigc/multimodal-generation/generation", {
    body: {
      model,
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { size, prompt_extend: false, watermark: false },
    },
    timeoutMs: 120_000,
  });
  const url = imageUrlFrom(j);
  if (!url) throw new QwenApiError(500, "в ответе нет url изображения: " + JSON.stringify(j).slice(0, 200));
  return { url, usage: j.usage ?? null };
}

/** Фото (data-URL) + инструкция → отредактированное изображение (qwen-image-edit,
 * тот же multimodal-эндпоинт, image+text в content). */
export async function editImage({ model, prompt, imageDataUrl }) {
  const j = await call("/services/aigc/multimodal-generation/generation", {
    body: {
      model,
      input: { messages: [{ role: "user", content: [{ image: imageDataUrl }, { text: prompt }] }] },
      parameters: { prompt_extend: false, watermark: false },
    },
    timeoutMs: 120_000,
  });
  const url = imageUrlFrom(j);
  if (!url) throw new QwenApiError(500, "в ответе нет url изображения: " + JSON.stringify(j).slice(0, 200));
  return { url, usage: j.usage ?? null };
}

/** Текст → видео: только САБМИТ задачи (480P, ~5 с по решению Ильи 12.09).
 * Генерация идёт минуты — держать HTTP открытым сквозь ngrok/вебвью ненадёжно,
 * поэтому статус опрашивает КЛИЕНТ через getTaskStatus. */
export async function submitVideoTask({ model, prompt, imageDataUrl = null, resolution = "480P", durationSec = 5 }) {
  // resolution, НЕ size (канарейка 12.09: size молча игнорится, дефолт 1080P —
  // ролик выходит $1.00 вместо $0.25; параметры сверены с API-гайдом wan3.0).
  // imageDataUrl — фото первым кадром (i2v, Илья 12.09: «видео со своей фотографией»).
  const submitted = await call("/services/aigc/video-generation/video-synthesis", {
    body: {
      model,
      input: { prompt, ...(imageDataUrl ? { img_url: imageDataUrl } : {}) },
      parameters: { resolution, ...(imageDataUrl ? {} : { ratio: "16:9" }), duration: durationSec },
    },
    async: true,
  });
  const taskId = submitted.output?.task_id;
  if (!taskId) throw new QwenApiError(500, "DashScope не вернул task_id: " + JSON.stringify(submitted).slice(0, 200));
  return { taskId };
}

/** Один опрос статуса задачи: {status: 'running'|'done'|'failed', url?, error?, usage?}.
 * usage на done содержит ФАКТИЧЕСКИЕ параметры генерации (SR: 480/720/1080,
 * output_video_duration) — по ним телеметрия считает честную стоимость
 * (урок 12.09: параметр не применился → ролик 1080P за $1.00 при записи $0.25). */
export async function getTaskStatus(taskId) {
  const t = await call(`/tasks/${encodeURIComponent(taskId)}`, { method: "GET", timeoutMs: 30_000 });
  const status = t.output?.task_status;
  if (status === "SUCCEEDED") {
    const url = t.output.video_url || t.output.results?.find((x) => x.url || x.video_url)?.url
      || t.output.results?.[0]?.video_url;
    return url ? { status: "done", url, usage: t.usage ?? null } : { status: "failed", error: "в результате нет video_url" };
  }
  if (status === "FAILED" || status === "CANCELED") {
    return { status: "failed", error: `${t.output?.code ?? status}: ${t.output?.message ?? "генерация не удалась"}` };
  }
  return { status: "running" };
}
