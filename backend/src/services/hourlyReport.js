// Часовой отчёт админам в бота (шаг 3 линии аналитики, 31.08.2026).
//
// Правила (Илья): окно отправки 10:00–22:00 локального времени, только
// вайтлисту; час + нарастающий итог дня; 6–8 строк, без канареек и local;
// пустой час — молчание. Порог: отчёт идёт при ЛЮБОМ ненулевом
// remote-событии за час, включая «только отказы» и «только сбои» —
// тишина означает «никто не приходил», а не «приходили и всё сломалось».
// Первый отчёт дня (10:00) несёт строку «Вчера» — базу сравнения.

import { getPool } from "./cache.js";
import { tellAdmins } from "./alerts.js";
import { telemetryWriteFailuresSince } from "./telemetry.js";

const REPORT_FROM_HOUR = 10;
const REPORT_TO_HOUR = 22; // включительно: последний отчёт в 22:00 за 21–22

const fmtUsd = (v) => "$" + (Number(v) || 0).toFixed(2);

/** Свод remote-событий за [from, to). Все canary/local отрезаны здесь. */
async function stats(from, to) {
  const { rows } = await getPool().query(
    `SELECT
       count(*)                                                   AS events,
       count(DISTINCT user_hash) FILTER (WHERE user_hash IS NOT NULL) AS uniq,
       count(*) FILTER (WHERE route='solve' AND error_kind IS NULL
                          AND multi_task IS DISTINCT FROM true)   AS solved,
       count(*) FILTER (WHERE route='solve' AND cache_hit)        AS from_cache,
       -- Кэш-хит по построению verified: кэшируются только verified-решения.
       count(*) FILTER (WHERE route='solve' AND error_kind IS NULL
                          AND multi_task IS DISTINCT FROM true
                          AND (verified OR cache_hit))            AS solved_verified,
       count(*) FILTER (WHERE route='check' AND error_kind IS NULL
                          AND multi_task IS DISTINCT FROM true)   AS checked,
       coalesce(sum(cost_usd), 0)                                 AS spent,
       coalesce(avg(cost_usd) FILTER (WHERE route='solve' AND cache_hit IS FALSE
                          AND error_kind IS NULL AND cost_usd > 0), 0) AS avg_gen_cost,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
         FILTER (WHERE error_kind IS NULL AND duration_ms IS NOT NULL) AS median_ms,
       max(duration_ms) FILTER (WHERE error_kind IS NULL)         AS max_ms
     FROM verify_events
     WHERE source = 'remote' AND created_at >= $1 AND created_at < $2`,
    [from, to]
  );
  const s = rows[0];

  const { rows: refusals } = await getPool().query(
    `SELECT reason, count(*) AS n FROM verify_events
     WHERE source='remote' AND error_kind='refusal' AND created_at >= $1 AND created_at < $2
     GROUP BY reason ORDER BY n DESC`,
    [from, to]
  );
  const { rows: posts } = await getPool().query(
    `SELECT start_param, count(*) AS n FROM verify_events
     WHERE source='remote' AND start_param IS NOT NULL AND created_at >= $1 AND created_at < $2
     GROUP BY start_param ORDER BY n DESC LIMIT 3`,
    [from, to]
  );
  const { rows: fresh } = await getPool().query(
    `SELECT count(DISTINCT user_hash) AS n FROM verify_events e
     WHERE source='remote' AND user_hash IS NOT NULL AND created_at >= $1 AND created_at < $2
       AND NOT EXISTS (SELECT 1 FROM verify_events p
                       WHERE p.user_hash = e.user_hash AND p.created_at < $1)`,
    [from, to]
  );
  return { ...s, refusals, posts, newUsers: Number(fresh[0].n) };
}

/** Разбивка попыток solve по классу×предмету за окно — дневная строка отчёта:
 * что пытались решить и как вышло. n = всего попыток; маркеры (только ненулевые):
 * ✅ проверено вычислением (verified или кэш-хит, по построению verified);
 * ⛔ отказ модели; ⚠ техническая ошибка (no_task_found и т.п.). Глобальная
 * строка ⛔ Отказы остаётся — там разбивка по ПРИЧИНАМ; здесь — по классу·предмету. */
async function daySubjects(from, to) {
  const { rows } = await getPool().query(
    `SELECT grade, subject, count(*) AS n,
            count(*) FILTER (WHERE verified OR cache_hit)                       AS verified,
            count(*) FILTER (WHERE error_kind = 'refusal')                      AS refusals,
            count(*) FILTER (WHERE error_kind IS NOT NULL AND error_kind <> 'refusal') AS errors
     FROM verify_events
     WHERE source='remote' AND route='solve' AND created_at >= $1 AND created_at < $2
     GROUP BY grade, subject ORDER BY n DESC`,
    [from, to]
  );
  return rows;
}

/** Строка «📚 За день: класс·предмет N(✅ ⛔ ⚠)» — топ-6, остальное «+N ещё». */
export function subjectsLine(rows) {
  if (!rows.length) return null;
  const TOP = 6;
  const combo = (r) => {
    const mk = [];
    if (Number(r.verified) > 0) mk.push(`✅${r.verified}`);
    if (Number(r.refusals) > 0) mk.push(`⛔${r.refusals}`);
    if (Number(r.errors) > 0) mk.push(`⚠${r.errors}`);
    return `${r.grade ?? "?"}·${r.subject ?? "?"} ${r.n}${mk.length ? `(${mk.join(" ")})` : ""}`;
  };
  const shown = rows.slice(0, TOP).map(combo).join(" · ");
  const extra = rows.length > TOP ? ` · +${rows.length - TOP} ещё` : "";
  return `📚 За день: ${shown}${extra}`;
}

/** Текст отчёта за час, либо null (тихий час — молчание). */
export async function buildHourlyReport(hourStart, { withYesterday = false } = {}) {
  const hourEnd = new Date(hourStart.getTime() + 3600_000);
  const dayStart = new Date(hourStart); dayStart.setHours(0, 0, 0, 0);

  const h = await stats(hourStart, hourEnd);
  if (Number(h.events) === 0) return null; // тишина = «никто не приходил»

  const d = await stats(dayStart, hourEnd);
  const hh = (dt) => String(dt.getHours()).padStart(2, "0") + ":00";
  const saved = (n, avg) => fmtUsd(Number(n) * Number(avg));

  const lines = [`📊 ${hh(hourStart)}–${hh(hourEnd)} · Домашка в МАХ`];

  lines.push(`👥 Уникальных: ${h.uniq} (${h.newUsers} новых) · за день: ${d.uniq} (${d.newUsers} новых)`);
  lines.push(`✅ Решено: ${h.solved}, из кэша ${h.from_cache} · за день: ${d.solved}, из кэша ${d.from_cache}`);
  if (Number(h.solved) > 0 || Number(d.solved) > 0) {
    lines.push(`🧮 Проверено вычислением: ${h.solved_verified} из ${h.solved} · за день: ${d.solved_verified} из ${d.solved}`);
  }
  // Что пытались решить за день по классам и предметам и как вышло (дневная
  // строка — за час обычно 0–1 событие, поклассовая разбивка осмысленна за день).
  const bdLine = subjectsLine(await daySubjects(dayStart, hourEnd));
  if (bdLine) lines.push(bdLine);
  if (Number(h.checked) > 0 || Number(d.checked) > 0) {
    lines.push(`📝 Проверок домашки: ${h.checked} · за день: ${d.checked}`);
  }
  lines.push(
    `💰 Потрачено: ${fmtUsd(h.spent)} · за день: ${fmtUsd(d.spent)} · кэш сберёг: ${saved(h.from_cache, d.avg_gen_cost)} / ${saved(d.from_cache, d.avg_gen_cost)}`
  );
  // Отказы видны, пока они были хоть раз за день, — даже нулём за час.
  if (h.refusals.length || d.refusals.length) {
    const hourPart = h.refusals.length ? h.refusals.map((r) => `${r.reason} ×${r.n}`).join(", ") : "0";
    const dayTotal = d.refusals.reduce((a, r) => a + Number(r.n), 0);
    lines.push(`⛔ Отказы: ${hourPart} · за день: ×${dayTotal}`);
  }
  if (h.median_ms != null) {
    lines.push(`⏱ Медиана ответа: ${Math.round(h.median_ms / 1000)} с · максимум: ${Math.round(h.max_ms / 1000)} с`);
  }
  if (h.posts.length) {
    lines.push(h.posts.map((p) => `🔗 С поста ${p.start_param}: ${p.n}`).join(" · ") +
      (d.posts.length ? ` · за день: ${d.posts.reduce((a, p) => a + Number(p.n), 0)}` : ""));
  }

  // Час с потерями телеметрии отличается от честного тихого часа.
  const lost = telemetryWriteFailuresSince(hourStart.getTime());
  if (lost > 0) lines.push(`⚠️ Сбоев записи телеметрии за час: ${lost} — данные часа неполны`);

  if (withYesterday) {
    const yStart = new Date(dayStart.getTime() - 86400_000);
    const y = await stats(yStart, dayStart);
    lines.push(`📅 Вчера: ${y.solved} задач, ${y.uniq} человек, ${fmtUsd(y.spent)}`);
  }

  return lines.join("\n");
}

/** Планировщик: тик на границе каждого часа, отправка в окне 10–22. */
export function startHourlyReports() {
  const tick = async () => {
    const now = new Date();
    const hour = now.getHours();
    if (hour < REPORT_FROM_HOUR || hour > REPORT_TO_HOUR) return;
    const hourStart = new Date(now.getTime() - 3600_000);
    hourStart.setMinutes(0, 0, 0);
    try {
      const text = await buildHourlyReport(hourStart, { withYesterday: hour === REPORT_FROM_HOUR });
      if (text) {
        await tellAdmins(text);
        // Успех отправки логируется явно: 01.09 «ушёл или тихий час» было не отличить.
        console.log(new Date().toISOString(), `[report] отчёт за ${hourStart.getHours()}:00 отправлен (${text.split("\n").length} строк)`);
      } else {
        console.log(new Date().toISOString(), `[report] час ${hourStart.getHours()}:00 пуст — молчание`);
      }
    } catch (err) {
      console.error("[report] сбой часового отчёта:", err.message);
    }
  };
  const msToNextHour = 3600_000 - (Date.now() % 3600_000);
  setTimeout(() => {
    tick();
    setInterval(tick, 3600_000);
  }, msToNextHour + 2000); // +2с от границы: события часа успевают дозаписаться
  console.log(`[report] часовые отчёты включены (окно ${REPORT_FROM_HOUR}:00–${REPORT_TO_HOUR}:00)`);
}
