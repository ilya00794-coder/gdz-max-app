// POST /api/transcribe — голос ученика в текст условия (03.09.2026).
// Принимает { audioBase64 } (data-URL или голый base64 от MediaRecorder),
// возвращает { text }. Текст падает в поле композера на фронте — ученик
// видит, правит и отправляет сам (авто-решения по голосу нет намеренно).
import { Router } from "express";
import { transcribeAudio, MAX_AUDIO_BYTES } from "../services/transcribe.js";

const router = Router();

router.post("/", async (req, res) => {
  const raw = req.body?.audioBase64;
  if (typeof raw !== "string" || !raw) {
    return res.status(400).json({ error: "Нужно поле audioBase64" });
  }
  // data:audio/mp4;base64,XXXX → XXXX; голый base64 проходит как есть.
  const b64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  // Грубая ранняя отсечка до декодирования: base64 ≈ 4/3 от байтов.
  if (b64.length > (MAX_AUDIO_BYTES * 4) / 3 + 4) {
    return res.status(413).json({ error: "Запись слишком длинная — скажи короче" });
  }
  let audio;
  try {
    audio = Buffer.from(b64, "base64");
  } catch {
    return res.status(400).json({ error: "audioBase64 не читается" });
  }
  try {
    const text = await transcribeAudio(audio);
    if (!text) return res.status(422).json({ error: "Не расслышали — попробуй ещё раз, ближе к микрофону" });
    res.json({ text });
  } catch (err) {
    console.error(new Date().toISOString(), "[voice] сбой расшифровки:", err.message);
    res.status(500).json({ error: "Не получилось расшифровать запись, попробуй ещё раз" });
  }
});

export default router;
