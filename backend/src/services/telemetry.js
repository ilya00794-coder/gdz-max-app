// Телеметрия вердиктов — таблица verify_events (см. schema.sql: что храним
// и чего НЕ храним — намеренно).
//
// Fire-and-forget: телеметрия не имеет права ронять или задерживать ответ
// ученику. Вызывающий код НЕ ждёт промис; ошибка записи — одна строка в лог.

import crypto from "node:crypto";
import { getPool } from "./cache.js";
import { reportError } from "./alerts.js";

// Сбои записи телеметрии — НЕ тишина (решение Ильи 01.09): серия подряд →
// живой алерт; времена сбоев копятся в памяти, часовой отчёт помечает час
// с потерями — «тихий час» должен отличаться от часа, в котором мы ослепли.
const WRITE_FAILS_BEFORE_ALERT = 4;
let consecutiveWriteFails = 0;
const writeFailTimes = []; // кольцевой буфер последних суток
export function telemetryWriteFailuresSince(sinceTs) {
  return writeFailTimes.filter((t) => t >= sinceTs).length;
}

// Необратимый хэш пользователя (решение Ильи 31.08.2026, предусмотрено
// комментарием schema.sql): HMAC-SHA256 с локальной солью, усечён до 16 hex.
// Считаем уникальных и «новых против вернувшихся», личность не восстановима.
// Соль не задана → null (хэшировать без соли = словарная атака по user_id).
const USER_HASH_SALT = process.env.USER_HASH_SALT || "";
if (!USER_HASH_SALT) console.warn("[telemetry] USER_HASH_SALT не задан — user_hash писаться не будет");

export function hashUser(userId) {
  if (!userId || !USER_HASH_SALT) return null;
  return crypto.createHmac("sha256", USER_HASH_SALT).update(String(userId)).digest("hex").slice(0, 16);
}

// Цены claude-opus-5 за 1M токенов (docs.claude.com, снято 31.08.2026):
// input $5, output $25; кэш: запись ×1.25, чтение ×0.1 от input.
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

/** Суммирует usage-объекты ответов API (поля могут отсутствовать). */
export function addUsage(...usages) {
  const t = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  for (const u of usages) {
    if (!u) continue;
    t.input_tokens += u.input_tokens ?? 0;
    t.output_tokens += u.output_tokens ?? 0;
    t.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    t.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  }
  return t;
}

/** Стоимость запроса в долларах по прайсу выше. */
export function usageCost(u) {
  if (!u) return null;
  return (
    (u.input_tokens ?? 0) * PRICE.input +
    (u.output_tokens ?? 0) * PRICE.output +
    (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
    (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead
  ) / 1e6;
}

export function recordVerifyEvent(event) {
  const {
    route, source, grade = null, subject = null,
    verified = null, method = null, reason = null,
    answerKind = null, multiTask = null, invariantViolation = null,
    parseFailureKind = null, durationMs = null, errorKind = null,
    textEdited = null, textSource = null, transport = null, appVersion = null,
    inputTokens = null, outputTokens = null, costUsd = null,
    cacheHit = null, userHash = null, startParam = null,
    contentType = null, stopReason = null, platform = null, keyHash = null,
    solverModel = null,
  } = event;
  getPool()
    .query(
      `INSERT INTO verify_events
         (route, source, grade, subject, verified, method, reason,
          answer_kind, multi_task, invariant_violation, parse_failure_kind,
          duration_ms, error_kind, text_edited, text_source, transport, app_version,
          input_tokens, output_tokens, cost_usd, cache_hit, user_hash, start_param,
          content_type, stop_reason, platform, key_hash, solver_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [route, source, grade, subject, verified, method,
       reason ? String(reason).slice(0, 300) : null,
       answerKind, multiTask, invariantViolation, parseFailureKind,
       durationMs, errorKind, textEdited, textSource, transport, appVersion ? String(appVersion).slice(0, 60) : null,
       inputTokens, outputTokens, costUsd, cacheHit, userHash,
       startParam ? String(startParam).slice(0, 60) : null,
       contentType, stopReason ? String(stopReason).slice(0, 40) : null, platform, keyHash,
       solverModel ? String(solverModel).slice(0, 60) : null]
    )
    .then(() => { consecutiveWriteFails = 0; })
    .catch((err) => {
      console.warn(new Date().toISOString(), "[telemetry] запись не удалась:", err.message);
      consecutiveWriteFails += 1;
      writeFailTimes.push(Date.now());
      while (writeFailTimes.length && writeFailTimes[0] < Date.now() - 24 * 3600_000) writeFailTimes.shift();
      if (consecutiveWriteFails === WRITE_FAILS_BEFORE_ALERT) {
        // Живой алерт (дедуп 1/5мин — в reportError): телеметрия слепнет.
        reportError({ kind: "telemetry_write", reason: err.message, source: "remote" });
      }
    });
}
