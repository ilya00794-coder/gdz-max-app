// Разбор строки запуска MAX Bridge (initData).
//
// Документация: https://dev.max.ru/docs/webapps/validation
// initData приходит в мини-приложение фрагментом адреса и содержит подписанные
// параметры запуска: user, chat, auth_date, query_id, ip и hash.
//
// СЕЙЧАС ЭТО МИДЛВАРА-НАБЛЮДАТЕЛЬ: она разбирает и логирует то, что пришло,
// но никого не отвергает. Строгая проверка подписи — отдельный следующий шаг;
// структура под неё заложена (см. verifyInitDataSignature ниже).
//
// Персональные данные в лог не пишем: только факт наличия полей и идентификатор
// пользователя, без имени, телефона и содержимого чата.

import crypto from "node:crypto";

export const INIT_DATA_HEADER = "x-max-init-data";

/** Токен бота с платформы MAX. Только из окружения, в репозитории его быть не должно. */
const BOT_TOKEN = process.env.MAX_BOT_TOKEN || "";

/** Насколько старую строку запуска считаем протухшей (для будущей строгой проверки). */
const MAX_AGE_SECONDS = Number(process.env.MAX_INIT_DATA_MAX_AGE || 24 * 60 * 60);

/**
 * Разбирает initData в параметры и строку для подписи.
 *
 * @param {string} raw
 * @returns {{params: Record<string,string>, hash: string|null, checkString: string}|null}
 */
export function parseInitData(raw) {
  if (!raw || typeof raw !== "string") return null;

  let search;
  try {
    search = new URLSearchParams(raw.startsWith("#") ? raw.slice(1) : raw);
  } catch {
    return null;
  }

  const params = {};
  for (const [key, value] of search.entries()) params[key] = value;
  if (!Object.keys(params).length) return null;

  const hash = params.hash ?? null;

  // Строка для подписи: все параметры кроме hash, отсортированные по ключу a→z,
  // склеенные переводом строки.
  const checkString = Object.keys(params)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("\n");

  return { params, hash, checkString };
}

/**
 * Считает подпись и сравнивает с присланной.
 *
 * Пока результат только логируется. Когда будем включать строгий режим — здесь же
 * появится отказ на "invalid" и "expired".
 *
 * @returns {{status: "valid"|"invalid"|"unparsable"|"no_token"|"no_hash", ageSeconds: number|null}}
 */
export function verifyInitDataSignature(raw, botToken = BOT_TOKEN) {
  const parsed = parseInitData(raw);
  if (!parsed) return { status: "unparsable", ageSeconds: null };

  const ageSeconds = parsed.params.auth_date
    ? Math.floor(Date.now() / 1000) - Number(parsed.params.auth_date)
    : null;

  if (!parsed.hash) return { status: "no_hash", ageSeconds };
  if (!botToken) return { status: "no_token", ageSeconds };

  // secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN), затем подпись параметров этим ключом.
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(parsed.checkString).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parsed.hash, "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  return { status: valid ? "valid" : "invalid", ageSeconds };
}

/** Безопасно достаёт id пользователя, не вытаскивая в лог остальные его данные. */
function extractUserId(params) {
  if (!params.user) return null;
  try {
    return JSON.parse(params.user)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Мидлвара: разбирает initData, кладёт разбор в req.max и пишет в лог.
 * Никогда не отвергает запрос — это наблюдение, а не защита.
 */
export function maxInitData(req, _res, next) {
  const raw = req.get(INIT_DATA_HEADER) || req.body?.initData || null;

  if (!raw) {
    req.max = { present: false, status: "absent", userId: null, params: null };
    return next();
  }

  const parsed = parseInitData(raw);
  const check = verifyInitDataSignature(raw);
  const userId = parsed ? extractUserId(parsed.params) : null;

  req.max = {
    present: true,
    status: check.status,
    ageSeconds: check.ageSeconds,
    expired: check.ageSeconds !== null && check.ageSeconds > MAX_AGE_SECONDS,
    userId,
    params: parsed?.params ?? null,
  };

  console.log("[max-init-data]", {
    path: req.path,
    поля: parsed ? Object.keys(parsed.params).sort() : null,
    подпись: check.status,
    возрастСек: check.ageSeconds,
    протухла: req.max.expired,
    userId,
  });

  next();
}
