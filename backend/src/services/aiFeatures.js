// AI-разделы приложения (чат/изображение/видео, 12.09.2026): общий разбор
// флагов и лимитов. Флаги по образцу переезда: off | canary (только X-Canary) | on.
// Прод-безопасность: выкладка с off неотличима от текущего приложения.
import { getPool } from "./cache.js";

const flag = (name) => String(process.env[name] || "off").toLowerCase();

// Телефон Ильи не умеет слать X-Canary — поэтому canary-фичи видны ещё и
// админам по userId из MAX_ADMIN_USER_IDS (тот же вайтлист, что у бота).
const ADMIN_IDS = new Set(
  String(process.env.MAX_ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
);
const isCanaryViewer = (source, userId) =>
  source === "canary" || (userId != null && ADMIN_IDS.has(String(userId)));

/** Видна ли фича этому запросу (source из requestSource; userId — из initData). */
export function featureEnabled(name, source, userId) {
  const v = flag(name);
  return v === "on" || (v === "canary" && isCanaryViewer(source, userId));
}

/** Снимок всех трёх фич для GET /api/features. */
export function featuresFor(source, userId) {
  return {
    chat: featureEnabled("QWEN_CHAT", source, userId),
    image: featureEnabled("QWEN_IMAGE", source, userId),
    video: featureEnabled("QWEN_VIDEO", source, userId),
  };
}

// Лимиты В ЧАС на пользователя — из .env, строка вида "chat:10,image:3,video:1".
// Решение Ильи 12.09 (вечер): НА СТАРТЕ ЛИМИТОВ НЕТ (GEN_LIMITS пуст/не задан),
// вводить постепенно правкой .env + kickstart, без изменения кода.
// Канарейки (source=canary) лимитом не ограничены в любом случае.
export const HOURLY_LIMITS = Object.fromEntries(
  String(process.env.GEN_LIMITS || "").split(",").map((p) => p.split(":"))
    .filter(([k, v]) => ["chat", "image", "video"].includes(k?.trim()) && Number(v) > 0)
    .map(([k, v]) => [k.trim(), Number(v)])
);

/**
 * Проверяет лимит и возвращает {allowed, used}. Считаем только успешные
 * события (ok=true): сбой генерации не должен сжигать квоту ребёнка.
 * Сбой самого запроса к БД = лимит НЕ подтверждён → пропускаем (fail-open:
 * телеметрия и так пишется, а падение БД не должно класть фичу целиком).
 */
export async function checkHourlyLimit(kind, userHash, source) {
  const limit = HOURLY_LIMITS[kind];
  if (source === "canary") return { allowed: true, used: 0, limit };
  if (!limit || !userHash) return { allowed: true, used: 0, limit };
  try {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM gen_events
       WHERE user_hash = $1 AND kind = $2 AND ok = true
         AND created_at > now() - interval '1 hour'`,
      [userHash, kind]
    );
    const used = rows[0]?.n ?? 0;
    return { allowed: used < limit, used, limit };
  } catch (err) {
    console.warn(new Date().toISOString(), "[ai-features] лимит не посчитан (пропускаю):", err.message);
    return { allowed: true, used: 0 };
  }
}

/** Телеметрия генераций — fire-and-forget, ответ пользователя не ждёт БД.
 * Возвращает Promise<id|null> — нужен видео-пути, чтобы на завершении задачи
 * поправить стоимость по ФАКТИЧЕСКОМУ разрешению (см. updateGenEventCost). */
export function recordGenEvent({ kind, source, userHash, model, prompt, enhancedPrompt, ok, errorKind, durationMs, costUsd, inputTokens, outputTokens }) {
  return getPool()
    .query(
      `INSERT INTO gen_events (kind, source, user_hash, model, prompt, enhanced_prompt, ok, error_kind, duration_ms, cost_usd, input_tokens, output_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [kind, source, userHash ?? null, model ?? null,
       prompt ? String(prompt).slice(0, 2000) : null,
       enhancedPrompt ? String(enhancedPrompt).slice(0, 2000) : null,
       ok !== false, errorKind ?? null, durationMs ?? null, costUsd ?? null,
       inputTokens ?? null, outputTokens ?? null]
    )
    .then((r) => r.rows[0]?.id ?? null)
    .catch((err) => { console.warn(new Date().toISOString(), "[gen-events] запись не удалась:", err.message); return null; });
}

/** Правка стоимости события по факту завершения (честная телеметрия видео). */
export function updateGenEventCost(id, costUsd, durationMs) {
  if (!id) return;
  getPool()
    .query(`UPDATE gen_events SET cost_usd = $2, duration_ms = COALESCE($3, duration_ms) WHERE id = $1`, [id, costUsd, durationMs ?? null])
    .catch((err) => console.warn(new Date().toISOString(), "[gen-events] правка стоимости не удалась:", err.message));
}
