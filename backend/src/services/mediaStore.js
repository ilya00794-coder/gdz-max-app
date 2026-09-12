// Хранилище сгенерированных медиа (12.09.2026). Зачем: OSS-ссылки DashScope
// (*.aliyuncs.com) не открываются из вебвью MAX с телефона (живой случай Ильи,
// битая картинка) и протухают через ~24ч. Файл скачивается бэкендом и отдаётся
// нашим же хостом через GET /media/<uuid> (см. server.js, ДО auth-middleware:
// <img> не умеет слать заголовки; имя-uuid неугадываемо).
// Папка ВНЕ репозитория (~/gdz-media): результаты обработки могут содержать
// лица детей — в git им нельзя (CLAUDE.md), ретенция короткая.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const MEDIA_DIR = path.join(os.homedir(), "gdz-media");
const RETENTION_DAYS = 7;

/** Скачивает url и кладёт в хранилище. Возвращает публичный путь "/media/<имя>". */
export async function storeFromUrl(url, ext) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`скачивание медиа не удалось: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const name = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  prune();
  return "/media/" + name;
}

/** Чистка старше RETENTION_DAYS — на каждом сохранении, дёшево (десятки файлов). */
function prune() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      const p = path.join(MEDIA_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch (err) {
    console.warn(new Date().toISOString(), "[media-store] чистка не удалась:", err.message);
  }
}

/** Сохраняет data-URL (фото пользователя) в хранилище. Возвращает "/media/<имя>".
 * Нужен i2v: DashScope принимает первый кадр ТОЛЬКО http-URL — отдаём свой. */
export function storeFromDataUrl(dataUrl) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/s.exec(String(dataUrl));
  if (!m) throw new Error("ожидается data-URL картинки (png/jpeg)");
  const name = crypto.randomUUID() + (m[1] === "png" ? ".png" : ".jpg");
  fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(m[2], "base64"));
  prune();
  return "/media/" + name;
}

/** Публичная база бэкенда (ngrok agent API) — для ссылок, которые скачивает
 * ВНЕШНИЙ сервис (DashScope i2v). Кэш на процесс; null — туннеля нет. */
let publicBaseCache = null;
export async function publicBase() {
  if (publicBaseCache) return publicBaseCache;
  try {
    const r = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    publicBaseCache = j?.tunnels?.find((x) => x?.public_url?.startsWith("https://"))?.public_url ?? null;
  } catch { publicBaseCache = null; }
  return publicBaseCache;
}
