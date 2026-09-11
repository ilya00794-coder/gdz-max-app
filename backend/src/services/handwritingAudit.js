// Аудит рукописи (шаг 3 переезда на qwen, решение Ильи 12.09): замер риска
// семейных ошибок qwen-vision (класс «7→4») ВМЕСТО shadow-Opus.
//
// Сохраняем ПАРЫ «фото + qwen-распознанный текст» для ручной сверки глазами.
// Приватность: папка вне репозитория, БЕЗ user_hash и любых идентификаторов,
// ретенция 7 дней (launchd com.gdz.handwriting-gc). Вьювер:
// npm run handwriting-viewer → audit.html в самой папке (file://, не хостится).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const AUDIT_DIR = process.env.HANDWRITING_AUDIT_DIR
  || path.join(os.homedir(), "gdz-handwriting-audit");

/** Пара файлов <ts>_<rand>.jpg/.txt (+_2.jpg… для мультифото). Fire-and-forget. */
export async function auditHandwriting(imagesBase64, recognizedText) {
  await fs.mkdir(AUDIT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const base = `${stamp}_${crypto.randomBytes(3).toString("hex")}`;
  const images = Array.isArray(imagesBase64) ? imagesBase64 : [];
  for (let i = 0; i < images.length; i++) {
    const data = String(images[i]).replace(/^data:[^;]+;base64,/, "");
    const suffix = i === 0 ? "" : `_${i + 1}`;
    await fs.writeFile(path.join(AUDIT_DIR, `${base}${suffix}.jpg`), Buffer.from(data, "base64"));
  }
  await fs.writeFile(path.join(AUDIT_DIR, `${base}.txt`), recognizedText ?? "", "utf8");
}
