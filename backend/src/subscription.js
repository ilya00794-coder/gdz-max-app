// Проверка подписки пользователя на канал проекта (gating).
//
// Проверенные факты (диагностика 28–29.08.2026, не перепроверять):
// - хост platform-api.max.ru: api2 недоступен с dev-машины (сертификат Минцифры);
// - токен — заголовком Authorization, параметр URL отвергается;
// - подписан → 200 + запись в members; не найден → 200 + пустой members.
// НЕ проверено: существующий аккаунт, НЕ подписанный на канал. Закрывается
// shadow-режимом на реальном трафике, обходных экспериментов не делаем.

import { STRICT_INIT_DATA_ENABLED } from "./middleware/maxInitData.js";

const HOST = process.env.MAX_API_HOST || "platform-api.max.ru";
const TOKEN = process.env.MAX_BOT_TOKEN || "";
// Держим строкой: число -74564545637740 близко к пределу точности Number,
// а в URL оно всё равно подставляется текстом.
const CHANNEL_ID = process.env.MAX_CHANNEL_CHAT_ID || "";

/** off — выключено; shadow — решение логируется, никто не блокируется; on — блокировка. */
export const GATING_MODE = ["off", "shadow", "on"].includes(String(process.env.SUBSCRIPTION_GATING || "").toLowerCase())
  ? String(process.env.SUBSCRIPTION_GATING).toLowerCase()
  : "off";

const REQUEST_TIMEOUT_MS = 4000;
const TTL_SUBSCRIBED_MS = 15 * 60 * 1000;
// Отрицательный TTL короткий: подписка занимает ~10 секунд, и только что
// подписавшийся ученик не должен сидеть в окне отказа (было 60 с — почти
// гарантированное попадание в окно; решение Ильи 31.08).
const TTL_NOT_SUBSCRIBED_MS = 15 * 1000;
// Принудительная проверка (кнопка «Я подписался») минует кэш, но не чаще
// раза в 5 секунд на пользователя — защита от долбёжки по MAX API.
const FORCE_MIN_INTERVAL_MS = 5 * 1000;

/** userId → момент последней принудительной проверки. */
const lastForce = new Map();

/**
 * ВРЕМЕННЫЙ тестовый рычаг (31.08.2026, просьба Ильи): перечисленные id
 * принудительно считаются неподписанными — чтобы посмотреть экран подписки
 * глазами с телефона, не включая гейтинг для всех. Действует в ОБЕИХ точках:
 * гейт блокирует (даже в shadow), recheck отвечает not_subscribed.
 * Убрать по слову Ильи: снять SUBSCRIPTION_TEST_BLOCK_IDS из .env + рестарт.
 */
const TEST_BLOCK_IDS = new Set(
  String(process.env.SUBSCRIPTION_TEST_BLOCK_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
);
if (TEST_BLOCK_IDS.size) console.warn(`[gating] ТЕСТ: принудительно неподписанные id: ${[...TEST_BLOCK_IDS].join(",")}`);

/** userId → { status, expires }. 'error' сюда не попадает никогда. */
const cache = new Map();

/** После 429 не долбим API до этого момента (Retry-After либо 30 секунд). */
let backoffUntil = 0;

/**
 * @param {string|number} userId
 * @param {{force?: boolean}} [opts] force — проверить мимо кэша (кнопка
 *   «Я подписался»); при превышении лимита 1/5с ведёт себя как обычный вызов.
 * @returns {Promise<{status: "subscribed"|"not_subscribed"|"error", raw: object|null}>}
 */
export async function checkSubscription(userId, { force = false } = {}) {
  const key = String(userId);

  if (TEST_BLOCK_IDS.has(key)) return { status: "not_subscribed", raw: { test: true } };

  let bypassCache = false;
  if (force) {
    const last = lastForce.get(key) ?? 0;
    if (Date.now() - last >= FORCE_MIN_INTERVAL_MS) {
      lastForce.set(key, Date.now());
      bypassCache = true;
    }
    // Лимит не прошёл — тихо падаем в обычное поведение (кэш): пользователь,
    // щёлкающий кнопку, получает последний известный статус, не ошибку.
  }

  const hit = cache.get(key);
  if (!bypassCache && hit && hit.expires > Date.now()) return { status: hit.status, raw: null };

  if (Date.now() < backoffUntil) {
    return { status: "error", raw: { reason: "backoff после 429" } };
  }

  let res;
  try {
    const url = new URL(`https://${HOST}/chats/${CHANNEL_ID}/members`);
    url.searchParams.set("user_ids", key);
    res = await fetch(url, {
      headers: { Authorization: TOKEN },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Сеть, таймаут — ошибка, решение «пускать» примет вызывающий (fail-open).
    return { status: "error", raw: { reason: err.name === "TimeoutError" ? "timeout" : err.message } };
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    backoffUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000);
    return { status: "error", raw: { httpStatus: 429, backoffMs: backoffUntil - Date.now() } };
  }

  if (!res.ok) {
    return { status: "error", raw: { httpStatus: res.status } };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { status: "error", raw: { httpStatus: res.status, reason: "нечитаемый ответ" } };
  }

  const members = Array.isArray(body?.members) ? body.members : null;
  if (!members) {
    // 200 без members — форма ответа изменилась; консервативно считаем ошибкой.
    return { status: "error", raw: { httpStatus: res.status, reason: "нет поля members" } };
  }

  const subscribed = members.some((m) => String(m.user_id) === key);
  const status = subscribed ? "subscribed" : "not_subscribed";
  cache.set(key, { status, expires: Date.now() + (subscribed ? TTL_SUBSCRIBED_MS : TTL_NOT_SUBSCRIBED_MS) });

  return { status, raw: { httpStatus: res.status, members } };
}

/**
 * Мидлвара gating. shadow: проверка уходит в фон, next() сразу — пользователь
 * не ждёт MAX API, решение только логируется. on: решение ждём, «не подписан» → 403,
 * ошибка проверки → fail-open. Без userId — decision "no_user", в MAX не ходим.
 */
export function subscriptionGate(req, res, next) {
  if (GATING_MODE === "off") return next();

  const userId = req.max?.userId;
  if (!userId) {
    // strict=off или локальный запрос: проверять нечего, в MAX не ходим.
    console.log("[gating]", { режим: GATING_MODE, path: req.path, decision: "no_user" });
    return next();
  }

  const startedAt = Date.now();
  const decide = ({ status, raw }) => {
    // Одна строка на решение; имена и аватарки в лог не пишем.
    console.log("[gating]", {
      режим: GATING_MODE,
      userId,
      decision: status,
      httpStatus: raw?.httpStatus ?? null,
      membersДлина: raw?.members?.length ?? null,
      изКэша: raw === null,
      duration_ms: Date.now() - startedAt,
    });
    return status;
  };

  // Тестовые id блокируются даже в shadow — полная симуляция неподписанного.
  if (TEST_BLOCK_IDS.has(String(userId))) {
    console.log("[gating]", { режим: GATING_MODE, userId, decision: "not_subscribed (ТЕСТ)" });
    return res.status(403).json({ error: "not_subscribed" });
  }

  if (GATING_MODE === "shadow") {
    // Без await: пользователь не должен ждать MAX API ради лога.
    checkSubscription(userId)
      .then(decide)
      .catch((err) => console.error("[gating] shadow: сбой проверки:", err.message));
    return next();
  }

  // on: решение нужно ДО ответа.
  checkSubscription(userId)
    .then(decide)
    .then((status) => {
      if (status === "not_subscribed") return res.status(403).json({ error: "not_subscribed" });
      next(); // subscribed и error (fail-open)
    })
    .catch((err) => {
      console.error("[gating] сбой проверки, пускаю (fail-open):", err.message);
      next();
    });
}

/**
 * Старт-проверки. Неверный chatId при fail-open молча открыл бы доступ всем —
 * поэтому канал проверяется на старте и ошибка кричит в лог.
 * Интерлок: gating=on без строгого initData — конфигурация-декорация,
 * user_id в ней подделывается заголовком; сервер не должен стартовать.
 */
export async function assertGatingReady() {
  if (GATING_MODE === "off") return;

  if (GATING_MODE === "on" && !STRICT_INIT_DATA_ENABLED) {
    throw new Error(
      "SUBSCRIPTION_GATING=on требует STRICT_INIT_DATA=on: без проверки подписи " +
        "initData user_id подделывается любым заголовком, и gating ничего не защищает."
    );
  }

  if (!TOKEN) throw new Error("gating включён, а MAX_BOT_TOKEN не задан");
  if (!CHANNEL_ID) throw new Error("gating включён, а MAX_CHANNEL_CHAT_ID не задан");

  try {
    const res = await fetch(`https://${HOST}/chats/${CHANNEL_ID}`, {
      headers: { Authorization: TOKEN },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const info = await res.json().catch(() => ({}));
    if (!res.ok || info.type !== "channel") {
      console.error("[gating] ПРОВЕРЬТЕ MAX_CHANNEL_CHAT_ID: канал не подтвердился", {
        httpStatus: res.status,
        type: info.type ?? null,
        title: info.title ?? null,
      });
    } else {
      console.log(`[gating] режим ${GATING_MODE}, канал подтверждён: «${info.title}» (${info.participants_count} подписчиков)`);
    }
  } catch (err) {
    console.error("[gating] старт-проверка канала не удалась (сеть/таймаут):", err.message);
  }
}
