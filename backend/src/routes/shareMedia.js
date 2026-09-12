// POST /api/share-media — «поделиться самим файлом» (Илья 12.09): бот шлёт
// пользователю в ЛС его сгенерированное медиа с подписью и ссылкой на канал,
// фронт открывает нативный шеринг этого сообщения (shareMaxContent {mid}).
import path from "node:path";
import fs from "node:fs";
import { Router } from "express";
import { sendMediaToUser } from "../services/botChannel.js";
import { MEDIA_DIR } from "../services/mediaStore.js";

const router = Router();

const CHANNEL_LINK = "https://max.ru/id772408566819_biz";
const CAPTION = `Сделано в «Домашка в MAX» 🚀\n${CHANNEL_LINK}`;

router.post("/", async (req, res) => {
  const userId = req.max?.userId;
  if (!userId) return res.status(401).json({ error: "Открой приложение внутри MAX" });
  const media = String(req.body?.media ?? "");
  const name = media.startsWith("/media/") ? media.slice("/media/".length) : media;
  // только uuid.расширение — чужой путь не подставить
  if (!/^[0-9a-f-]{36}\.(png|jpg|mp4)$/.test(name)) {
    return res.status(400).json({ error: "Неизвестное медиа" });
  }
  const filePath = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Файл устарел (медиа хранятся 7 дней)" });
  try {
    const { mid } = await sendMediaToUser(userId, filePath, CAPTION);
    res.json({ mid });
  } catch (err) {
    console.error(new Date().toISOString(), "[share-media] сбой:", err.message);
    res.status(502).json({ error: "Не получилось подготовить файл к отправке — попробуй ещё раз" });
  }
});

export default router;
