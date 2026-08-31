// Уведомления о сбоях в личку бота (шаг 2 линии аналитики, 31.08.2026).
//
// Принцип (Илья): приложение не чинит себя само — починка это диагностика,
// правка, канарейка и деплой. Поэтому сбой немедленно уходит админам
// с классом и контекстом; ошибки живых пользователей — сразу и отдельно,
// фоновые (канарейки, local) — агрегатом. Пострадавшие запоминаются,
// уведомление «мы починили» уходит ТОЛЬКО по команде админа (/починили).

import { getPool } from "./cache.js";

/** Живой сбой одного класса не спамит чаще раза в 5 минут — повторы копятся. */
const LIVE_DEDUP_MS = 5 * 60 * 1000;
/** Фоновые сбои копятся и уходят сводкой раз в 30 минут. */
const BG_FLUSH_MS = 30 * 60 * 1000;

const liveLast = new Map();   // kind → { ts, suppressed }
const bgBuffer = new Map();   // kind → count
let bgTimer = null;

/** Инжектится из botChannel при старте поллера — alerts не тянет его сам,
 * чтобы не создать цикл импортов. Без бота алерты просто ложатся в лог. */
let sendFn = null;
let adminIds = [];
export function bindAlertTransport(send, admins) {
  sendFn = send;
  adminIds = [...admins];
}

export async function tellAdmins(text) {
  if (!sendFn || !adminIds.length) {
    console.warn("[alerts] бот недоступен, алерт только в лог:", text.slice(0, 160));
    return;
  }
  for (const id of adminIds) {
    try {
      await sendFn(id, text);
    } catch (err) {
      console.error("[alerts] не доставил алерт админу:", err.message);
    }
  }
}

/**
 * Регистрирует сбой. Живые (source=remote) — немедленно; прочие — в агрегат.
 * userId (сырой, только у живых) — для таблицы пострадавших; в телеметрию
 * вердиктов он по-прежнему не попадает.
 */
export function reportError({ kind, reason = "", route = null, source = "local", userId = null }) {
  try {
    if (source === "remote") {
      if (userId) rememberIncidentUser(userId, kind);
      const prev = liveLast.get(kind);
      if (prev && Date.now() - prev.ts < LIVE_DEDUP_MS) {
        prev.suppressed += 1;
        return;
      }
      const extra = prev?.suppressed ? `\n(+${prev.suppressed} таких же за прошлые 5 минут)` : "";
      liveLast.set(kind, { ts: Date.now(), suppressed: 0 });
      tellAdmins(
        `🔴 Сбой у живого пользователя\nкласс: ${kind}${route ? ` · путь: ${route}` : ""}\n${String(reason).slice(0, 200)}${extra}`
      );
      return;
    }
    // Фоновые: канарейки, local-прогоны, служебные циклы.
    bgBuffer.set(kind, (bgBuffer.get(kind) ?? 0) + 1);
    if (!bgTimer) {
      bgTimer = setTimeout(() => {
        bgTimer = null;
        const lines = [...bgBuffer.entries()].map(([k, n]) => `· ${k}: ${n}`);
        bgBuffer.clear();
        if (lines.length) tellAdmins(`⚪ Фоновые сбои за 30 минут:\n${lines.join("\n")}`);
      }, BG_FLUSH_MS);
    }
  } catch (err) {
    console.error("[alerts] сбой самого алерта:", err.message);
  }
}

/** Пострадавший запоминается до уведомления о починке (см. schema.sql). */
function rememberIncidentUser(userId, kind) {
  getPool()
    .query(
      `INSERT INTO incident_users (user_id, error_kind)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET last_seen = now(), error_kind = EXCLUDED.error_kind
         WHERE incident_users.notified_at IS NULL`,
      [String(userId), kind]
    )
    .catch((err) => console.warn("[alerts] не записал пострадавшего:", err.message));
}

/**
 * Команда /починили: уведомить всех неуведомлённых пострадавших.
 * Отметка notified_at — только после УСПЕШНОЙ отправки конкретному
 * пользователю; неудачные остаются в списке.
 */
export async function notifyFixed(text, send = sendFn) {
  const message = text?.trim() || "Мы починили сбой — попробуй ещё раз 🙌";
  const { rows } = await getPool().query(
    `SELECT user_id FROM incident_users WHERE notified_at IS NULL`
  );
  let ok = 0, failed = 0;
  for (const { user_id } of rows) {
    try {
      await send(user_id, message);
      await getPool().query(`UPDATE incident_users SET notified_at = now() WHERE user_id = $1`, [user_id]);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn("[alerts] не уведомил пострадавшего:", err.message);
    }
  }
  // Уведомлённые больше не нужны — чистим (условие исключения: см. schema.sql).
  await getPool().query(`DELETE FROM incident_users WHERE notified_at IS NOT NULL`);
  return { total: rows.length, ok, failed };
}
