// POST /api/chat — раздел «Чат AI» (qwen-flash, история с клиента).
// За флагом QWEN_CHAT (off|canary|on); лимит 10 сообщений/час на пользователя.
import { Router } from "express";
import { requestSource } from "../middleware/maxInitData.js";
import { qwenChat, describeQwenError, normalizeQwenUsage } from "../services/qwenClient.js";
import { featureEnabled, checkHourlyLimit, recordGenEvent, HOURLY_LIMITS } from "../services/aiFeatures.js";
import { hashUser, usageCost } from "../services/telemetry.js";

const router = Router();

const CHAT_MODEL = process.env.QWEN_CHAT_MODEL || "qwen-flash";
const HISTORY_WINDOW = 20; // сообщений истории в запрос — дальше окно съедает деньги без пользы

// Аудитория — школьники: помощник дружелюбный, без взрослых тем, отвечает коротко.
const SYSTEM_PROMPT = [
  "Ты — дружелюбный помощник в приложении «Домашка в MAX» для школьников 1–11 класса.",
  "Отвечай по-русски, просто и по делу, без канцелярита. Числа и формулы записывай понятно.",
  "Можно болтать на любые темы, помогать с учёбой, объяснять, придумывать идеи.",
  "Не выдавай себя за человека. Если вопрос про домашнюю задачу с фото — предложи раздел «Решить домашку».",
].join(" ");

router.post("/", async (req, res) => {
  const startedAt = Date.now();
  const source = requestSource(req);
  if (!featureEnabled("QWEN_CHAT", source, req.max?.userId)) {
    return res.status(503).json({ error: "Раздел «Чат» пока выключен" });
  }
  const userHash = hashUser(req.max?.userId);

  const raw = req.body?.messages;
  if (!Array.isArray(raw) || !raw.length) {
    return res.status(400).json({ error: "Нужен messages: [{role, content}, ...]" });
  }
  const messages = raw
    .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.trim())
    .slice(-HISTORY_WINDOW)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Последнее сообщение должно быть от пользователя" });
  }

  const { allowed, used, limit } = await checkHourlyLimit("chat", userHash, source);
  if (!allowed) {
    return res.status(429).json({ error: `Лимит чата — ${limit} сообщений в час. Передохни немного и возвращайся!`, limitReached: true });
  }

  try {
    const resp = await qwenChat({
      model: CHAT_MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 2000,
    }, { timeoutMs: 60_000 });
    const reply = resp.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("пустой ответ модели");
    const usage = normalizeQwenUsage(resp.usage); // implicit-кэш qwen учитывается тарифом ×0.1
    const costUsd = usageCost(usage, CHAT_MODEL);
    recordGenEvent({
      kind: "chat", source, userHash, model: CHAT_MODEL,
      prompt: messages[messages.length - 1].content,
      ok: true, durationMs: Date.now() - startedAt, costUsd,
      inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null,
    });
    res.json({ reply, used: used + 1, limit: limit ?? HOURLY_LIMITS.chat });
  } catch (err) {
    recordGenEvent({ kind: "chat", source, userHash, model: CHAT_MODEL, prompt: messages[messages.length - 1].content, ok: false, errorKind: String(err.message).slice(0, 120), durationMs: Date.now() - startedAt });
    console.error(new Date().toISOString(), "[ai-chat] сбой:", err.message);
    res.status(502).json({ error: describeQwenError(err) });
  }
});

export default router;
