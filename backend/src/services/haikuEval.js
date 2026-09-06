// Сбор всех solve-ответов для ручного разбора качества роутинга (06.09.2026).
// Fire-and-forget: сбой записи — warn, ответ ученику не задет. user_hash НЕ
// пишется. Кэш-хиты пишутся с from_cache=true (см. комментарий в schema.sql).
// Ретенция 30 дней — почасовая чистка в hourlyReport.
import { getPool } from "./cache.js";

export function recordEval({ grade, subject, recognizedText, solution, verified, reason, fromCache }) {
  getPool()
    .query(
      `INSERT INTO haiku_eval (grade, subject, recognized_text, solution, final_answer,
                               answer_kind, verified, reason, solver_model, from_cache)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [grade, subject, recognizedText ?? null, solution ?? null,
       solution?.finalAnswer ?? null, solution?.answerValues?.kind ?? null,
       verified ?? null, reason ? String(reason).slice(0, 300) : null,
       solution?.solverModel ?? null, fromCache === true]
    )
    .catch((err) => console.warn(new Date().toISOString(), "[haiku-eval] запись не удалась:", err.message));
}
