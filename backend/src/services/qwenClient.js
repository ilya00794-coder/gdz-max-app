// Родной клиент Qwen (DashScope, OpenAI-совместимый compatible-mode/v1).
//
// Шаг 1 переезда на Qwen (проба №0 12.09: tools-схема держится на qwen-flash
// и qwen3-vl-flash, дисциплина полей лучше Anthropic-прослойки). Живёт РЯДОМ
// с anthropicClient.js: существующие пути (Opus/Haiku/прослойка) не трогаются
// до шага 6 (точка невозврата — после N дней стабильности).
//
// Реализация — голый fetch, без openai-SDK: контракт узкий (chat/completions,
// tools, image_url), зависимость не окупается. Ретраев здесь нет — политика
// ретраев/фолбэков живёт у вызывающих (solve ×2 → qwen3.8-flash и т. п.).

import { coerceBySchema } from "./qwenSolveAdapter.js";

const BASE_URL = process.env.QWEN_NATIVE_BASE_URL
  || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TIMEOUT_MS = 120_000;

/** Ошибка конфигурации (нет ключа) — сервер поднимается без ключа, падает только вызов. */
export class QwenConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "QwenConfigError";
    this.code = "QWEN_NOT_CONFIGURED";
  }
}

/** Ошибка API с HTTP-статусом — вместо SDK-классов Anthropic. */
export class QwenApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "QwenApiError";
    this.status = status;
  }
}

/**
 * Транзиентные классы ошибок с СОБСТВЕННЫМ действием пользователя — тот же
 * контракт, что classifyUpstreamError в anthropicClient (роуты переедут на
 * эту функцию на шагах 2-3): null = обычный сбой (идёт в серию «стены»).
 */
export function classifyQwenError(err) {
  const status = err?.status ?? null;
  if (status === 429) {
    return { errorClass: "rate_limit", error: "Слишком много запросов сразу — подожди минуту и попробуй снова." };
  }
  if (status >= 500 || status === 503) {
    return { errorClass: "overloaded", error: "Сервис сейчас перегружен — попробуй через минуту." };
  }
  // fetch-сбои сети: TypeError (fetch failed), AbortError (таймаут)
  if (err?.name === "AbortError" || err?.name === "TimeoutError" || /fetch failed|network|ECONNRE/i.test(String(err?.message))) {
    return { errorClass: "upstream_network", error: "Не получилось связаться с сервисом решения. Попробуй ещё раз." };
  }
  return null;
}

/** Короткий человекочитаемый вид ошибки для логов/ответов. */
export function describeQwenError(err) {
  if (err instanceof QwenConfigError) return err.message;
  if (err?.status === 401 || err?.status === 403) return "Неверный или неавторизованный QWEN_API_KEY";
  if (err?.status === 429) return "Превышен лимит запросов к Qwen API, попробуйте позже";
  if (err?.status === 400) return `Некорректный запрос к Qwen API: ${err.message}`;
  if (err instanceof QwenApiError) return `Ошибка Qwen API ${err.status}: ${err.message}`;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return "Qwen API не ответил вовремя";
  return err?.message || "Неизвестная ошибка";
}

function apiKey() {
  if (!process.env.QWEN_API_KEY) {
    throw new QwenConfigError("Не задан QWEN_API_KEY — родной Qwen-клиент недоступен.");
  }
  return process.env.QWEN_API_KEY;
}

/**
 * Низкоуровневый chat-вызов. body — поля OpenAI-формата (model, messages,
 * tools, tool_choice, max_tokens). Возвращает разобранный JSON ответа.
 */
export async function qwenChat(body) {
  const r = await fetch(BASE_URL + "/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", authorization: "Bearer " + apiKey() },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    throw new QwenApiError(r.status, j?.error?.message || JSON.stringify(j)?.slice(0, 300) || `HTTP ${r.status}`);
  }
  return j;
}

/**
 * Структурный вызов: схема отдаётся инструментом (function calling),
 * аргументы разбираются и прогоняются через coerceBySchema (число→строка,
 * JSON-строка→массив, опущенные null — как в прослойке; проверено пробой №0:
 * vision отдал tasks строкой). Zod-валидация — у вызывающего (fail-closed).
 *
 * @returns {Promise<{parsed: object|null, usage: object|null, raw: object}>}
 *   parsed=null — модель не позвала инструмент или аргументы не JSON
 *   (структурный сбой; ретрай/фолбэк — политика вызывающего).
 */
export async function qwenStructured({ model, system, messages, schemaName, schema, maxTokens = 8000 }) {
  const msgs = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];
  const raw = await qwenChat({
    model,
    messages: msgs,
    max_tokens: maxTokens,
    tools: [{ type: "function", function: { name: schemaName, description: "Верни результат СТРОГО по схеме, без пояснений вне инструмента.", parameters: schema } }],
    tool_choice: "auto",
  });
  const tc = raw.choices?.[0]?.message?.tool_calls?.[0];
  let parsed = null;
  if (tc?.function?.arguments) {
    try { parsed = JSON.parse(tc.function.arguments); } catch { parsed = null; }
  }
  let coerced = false;
  if (parsed && typeof parsed === "object") {
    const before = JSON.stringify(parsed);
    parsed = coerceBySchema(parsed, schema);
    coerced = JSON.stringify(parsed) !== before; // метрика дисциплины: чинили ли транспортные причуды
  }
  return { parsed, usage: raw.usage ?? null, coerced, raw };
}

/**
 * Режим родного пути (шаг 2): off — прослойка как была (дефолт);
 * canary — родной ТОЛЬКО для X-Canary; on — родной для всех.
 * Отдельный от QWEN_SOLVE рычаг: дети остаются на прослойке до явного слова.
 */
export const QWEN_NATIVE = String(process.env.QWEN_NATIVE || "off").toLowerCase();

/**
 * usage родного формата → форма Anthropic, которую ждут addUsage/usageCost.
 * ВАЖНО: у OpenAI-формата cached_tokens ВХОДЯТ в prompt_tokens — вычитаем,
 * иначе кэшные токены посчитались бы дважды (по полной цене и по кэш-цене).
 */
export function normalizeQwenUsage(u) {
  if (!u) return null;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    output_tokens: u.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** Блок image_url из base64/data-URL — родной формат для vision-сообщений. */
export function imageBlock(base64OrDataUrl, mediaType = "image/jpeg") {
  const url = String(base64OrDataUrl).startsWith("data:")
    ? base64OrDataUrl
    : `data:${mediaType};base64,${base64OrDataUrl}`;
  return { type: "image_url", image_url: { url } };
}
