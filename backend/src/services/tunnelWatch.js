// Сторож РАБОТОСПОСОБНОСТИ туннеля, не наличия процесса (03.09.2026).
//
// KeepAlive launchd ловит смерть ngrok-процесса, но НЕ случай «агент жив,
// туннель не проходит»: у ngrok есть вечный reconnecting (сессия к облаку
// разорвана, процесс живёт) — подтверждено его же логом. Урок тот же, что
// у сторожа поллера 01.09: проверять функцию, не процесс.
//
// Два слоя:
//  - ЛОКАЛЬНЫЙ (каждые LOCAL_MS): API агента 127.0.0.1:4040/api/tunnels —
//    установлен ли туннель. Бесплатно, без трафика через edge (free-план
//    ngrok лимитирован — сквозняком каждые 2 мин было бы расточительно).
//  - СКВОЗНОЙ (каждые EXTERNAL_MS): GET {public_url}/health снаружи — ловит
//    «агент думает, что ок, а edge не отдаёт». public_url берём из
//    последнего локального ответа — домен не хардкодим. /health вне /api
//    и без телеметрии — статистику не портит (проверено 03.09).
//
// Реакция (требования Ильи):
//  - K_FAILS подряд → launchctl kickstart + АЛЕРТ (даже если поднимется
//    само: тихие перезапуски скрыли бы системную проблему);
//  - восстановление → алерт с длительностью простоя (как у поллера);
//  - K_KICKSTARTS перезапусков не помогли → «ТУННЕЛЬ НЕ ПОДНИМАЕТСЯ»,
//    однократно до восстановления — дальше нужен человек.
//
// ГРАНИЦА: сторож живёт в бэкенде — при смерти бэкенда молчит (бэкенд
// поднимет launchd; зафиксировано в session-state рядом с границей сна).

import { execFile } from "node:child_process";
import { tellAdmins } from "./alerts.js";

const log = (...a) => console.log(new Date().toISOString(), "[tunnel]", ...a);

const AGENT_API = "http://127.0.0.1:4040/api/tunnels";
const LABEL = "com.gdz.tunnel";

function kickstart() {
  return new Promise((resolve) => {
    execFile("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`], (err) => {
      if (err) log("kickstart не удался:", err.message);
      resolve(!err);
    });
  });
}

/** Локальная проверка: туннель установлен у агента? Возвращает public_url или null. */
export async function probeLocal(timeoutMs = 3000) {
  try {
    const res = await fetch(AGENT_API, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json();
    const t = j?.tunnels?.find((x) => x?.public_url?.startsWith("https://"));
    return t?.public_url ?? null;
  } catch {
    return null;
  }
}

/** Сквозная проверка: edge отдаёт наш /health? */
export async function probeThrough(publicUrl, timeoutMs = 8000) {
  try {
    const res = await fetch(`${publicUrl}/health`, {
      headers: { "ngrok-skip-browser-warning": "1" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export function startTunnelWatch({
  localMs = 2 * 60 * 1000,
  externalMs = 30 * 60 * 1000,
  kFails = 2,
  kKickstarts = 3,
} = {}) {
  let consecutiveFails = 0;
  let kickstarts = 0;
  let downSince = null;
  let gaveUp = false; // «не поднимается» уже отправлен — не спамим до восстановления
  let lastPublicUrl = null;
  let lastExternalAt = 0;

  const tick = async () => {
    const publicUrl = await probeLocal();
    let ok = Boolean(publicUrl);
    let via = "локальная";

    if (ok) {
      lastPublicUrl = publicUrl;
      // Сквозной слой — редкий, только при живом локальном.
      if (Date.now() - lastExternalAt >= externalMs) {
        lastExternalAt = Date.now();
        ok = await probeThrough(publicUrl);
        if (!ok) via = "сквозная";
      }
    }

    if (ok) {
      if (downSince) {
        const mins = Math.max(1, Math.round((Date.now() - downSince) / 60000));
        log(`восстановился после ${kickstarts} перезапусков, простой ~${mins} мин`);
        tellAdmins(`🟢 Туннель снова работает (простой ~${mins} мин, перезапусков: ${kickstarts}).`).catch(() => {});
      }
      consecutiveFails = 0;
      kickstarts = 0;
      downSince = null;
      gaveUp = false;
      return;
    }

    consecutiveFails += 1;
    log(`туннель не проходит (${via} проверка, №${consecutiveFails} подряд)`);
    if (consecutiveFails < kFails) return;

    if (!downSince) downSince = Date.now();
    if (kickstarts >= kKickstarts) {
      if (!gaveUp) {
        gaveUp = true;
        tellAdmins(`🔴 ТУННЕЛЬ НЕ ПОДНИМАЕТСЯ: ${kickstarts} перезапусков подряд не помогли. Нужно вмешательство.`).catch(() => {});
      }
      return;
    }
    kickstarts += 1;
    // Алерт ДО лечения и ВСЕГДА — даже если поднимется само (требование Ильи).
    tellAdmins(`🔴 Туннель не проходит (${via} проверка ×${consecutiveFails}) — перезапускаю ngrok (попытка ${kickstarts}).`).catch(() => {});
    await kickstart();
  };

  setInterval(() => { tick().catch((err) => log("сбой тика:", err.message)); }, localMs);
  log(`сторож включён: локальная каждые ${Math.round(localMs / 1000)} с, сквозная каждые ${Math.round(externalMs / 60000)} мин`);
  return { probeLocal, probeThrough }; // для канареек
}
