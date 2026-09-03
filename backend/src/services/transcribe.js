// Расшифровка голоса в текст — локальный whisper.cpp (03.09.2026).
//
// Путь выбран фактами зонда: SpeechRecognition в вебвью MAX не работает
// (service-not-allowed), запись MediaRecorder работает (audio/mp4 с iPhone).
// Claude API аудио не принимает — расшифровка своя: ffmpeg приводит любой
// контейнер к wav 16k mono, whisper-cli (Metal на M1, модель small
// мультиязычная) отдаёт текст. Канарейка движка: «реши уравнение два икс
// плюс пять равно тринадцать» → «Реши уравнение 2x+5=13.» за ~3 с.
//
// Безопасность: execFile с массивом аргументов (никакого шелла), временные
// файлы в os.tmpdir со случайным именем, удаляются в finally. Аудио НЕ
// сохраняется (политика хранения — как с фото: обработали и забыли).

import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(process.env.HOME ?? "", "models/whisper/ggml-small.bin");
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
/** Потолок сырого аудио: ~10 МБ ≈ несколько минут AAC — школьная задача короче. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const STEP_TIMEOUT_MS = 30_000;

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)}: ${err.message}; ${String(stderr).slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

/**
 * @param {Buffer} audio — байты записи (mp4/webm/ogg/wav — ffmpeg разберётся)
 * @returns {Promise<string>} распознанный текст (может быть пустым — тишина)
 */
export async function transcribeAudio(audio) {
  if (!audio?.length) throw new Error("пустое аудио");
  if (audio.length > MAX_AUDIO_BYTES) throw new Error("аудио слишком длинное");
  const id = crypto.randomBytes(8).toString("hex");
  const src = path.join(tmpdir(), `gdz-voice-${id}.in`);
  const wav = path.join(tmpdir(), `gdz-voice-${id}.wav`);
  const t0 = Date.now();
  try {
    await writeFile(src, audio);
    await run(FFMPEG_BIN, ["-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", wav], STEP_TIMEOUT_MS);
    // -np: без прогресса, -nt: без таймстампов — stdout остаётся чистым текстом.
    const out = await run(WHISPER_BIN, ["-m", WHISPER_MODEL, "-l", "ru", "-np", "-nt", wav], STEP_TIMEOUT_MS);
    const text = out.trim();
    console.log(new Date().toISOString(), `[voice] расшифровано за ${Date.now() - t0} мс, ${audio.length} байт → ${text.length} символов`);
    return text;
  } finally {
    await unlink(src).catch(() => {});
    await unlink(wav).catch(() => {});
  }
}
