// Телеметрия вердиктов — таблица verify_events (см. schema.sql: что храним
// и чего НЕ храним — намеренно).
//
// Fire-and-forget: телеметрия не имеет права ронять или задерживать ответ
// ученику. Вызывающий код НЕ ждёт промис; ошибка записи — одна строка в лог.

import { getPool } from "./cache.js";

export function recordVerifyEvent(event) {
  const {
    route, source, grade = null, subject = null,
    verified = null, method = null, reason = null,
    answerKind = null, multiTask = null, invariantViolation = null,
    parseFailureKind = null, durationMs = null, errorKind = null,
    textEdited = null, transport = null, appVersion = null,
  } = event;
  getPool()
    .query(
      `INSERT INTO verify_events
         (route, source, grade, subject, verified, method, reason,
          answer_kind, multi_task, invariant_violation, parse_failure_kind,
          duration_ms, error_kind, text_edited, transport, app_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, $14, $15, $16)`,
      [route, source, grade, subject, verified, method,
       reason ? String(reason).slice(0, 300) : null,
       answerKind, multiTask, invariantViolation, parseFailureKind,
       durationMs, errorKind, textEdited, transport, appVersion ? String(appVersion).slice(0, 60) : null]
    )
    .catch((err) => console.warn("[telemetry] запись не удалась:", err.message));
}
