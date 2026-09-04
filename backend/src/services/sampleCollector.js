// ВРЕМЕННЫЙ сбор образцов (фото + vision-выход) для ручного разбора качества
// распознавания (задача Ильи 04.09.2026). Диагностика, не продукт.
//
// Флаг COLLECT_SAMPLES читается ОДИН РАЗ при старте процесса: выключение
// сбора требует РЕСТАРТА бэкенда, правки .env мало (осознанно — ноль
// проверок на горячем пути при off).
//
// FAIL-OPEN жёстко: вся работа в setImmediate (после отправки ответа) и в
// try/catch — любой сбой (нет места, нет прав) = одна строка warn, ответ
// ученику не зависит от сбора НИКОГДА.
//
// Приватность: префикс имени = время + случайные hex (НЕ user_hash, ничего
// опознающего); user_hash в метаданные НЕ пишется.
//
// Ретенция 48 ч — launchd-агент com.gdz.samples-gc (infra/launchd/), find
// -maxdepth 1 -mmin +2880 -delete каждый час + RunAtLoad.

import { mkdirSync, writeFileSync, statfsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ENABLED = ["1", "true", "on", "yes"].includes(String(process.env.COLLECT_SAMPLES || "").toLowerCase());
const DIR = "/Users/ilya/gdz-samples";
/** Порог свободного места: ниже — сбор пропускается с warn (диск не добиваем). */
const MIN_FREE_BYTES = 500 * 1024 * 1024;

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

if (ENABLED) {
  try {
    mkdirSync(DIR, { recursive: true });
    console.log("[samples] сбор образцов ВКЛЮЧЁН →", DIR, "(ретенция 48 ч агентом com.gdz.samples-gc)");
  } catch (err) {
    console.warn("[samples] каталог не создать:", err.message);
  }
}

/**
 * Сохраняет образец: исходное фото (первое), vision-текст, JSON-метаданные.
 * Вызывается ДО return из пайплайна, но вся работа — в setImmediate:
 * к моменту записи ответ уже отправлен.
 */
export function collectSample({ imagesBase64, recognizedText, meta }) {
  if (!ENABLED) return; // off = ноль действий
  if (!imagesBase64?.length) return; // без фото нечего разбирать
  setImmediate(() => {
    try {
      const free = statfsSync(DIR);
      if (free.bavail * free.bsize < MIN_FREE_BYTES) {
        console.warn("[samples] мало места на диске — образец пропущен");
        return;
      }
      const d = new Date();
      const stamp = d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const prefix = `${stamp}_${crypto.randomBytes(3).toString("hex")}`;

      const raw = String(imagesBase64[0]);
      const m = raw.match(/^data:([a-z/+.-]+);base64,(.*)$/is);
      const mediaType = m ? m[1].toLowerCase() : "image/jpeg";
      const bytes = Buffer.from((m ? m[2] : raw).replace(/\s+/g, ""), "base64");
      const ext = EXT[mediaType] ?? "bin";

      writeFileSync(path.join(DIR, `${prefix}.${ext}`), bytes);
      writeFileSync(path.join(DIR, `${prefix}.txt`), String(recognizedText ?? ""));
      writeFileSync(path.join(DIR, `${prefix}.json`), JSON.stringify({ ts: d.toISOString(), ...meta }, null, 2));
    } catch (err) {
      console.warn("[samples] запись образца не удалась:", err.message);
    }
  });
}
