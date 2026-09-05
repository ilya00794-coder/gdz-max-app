// Конкурс роликов: приём заявки из ПРИЛОЖЕНИЯ (06.09.2026). Пишет в ту же
// contest_entries тем же saveContestEntry, что и бот, — один список участников,
// второго конкурса нет. Флаг и валидация ссылки — общие с ботом (botChannel).
//
// ПРИВАТНОСТЬ: url и contact — детские данные, живут только в contest_entries
// (задокументированное исключение политики, см. schema.sql). В логи и
// телеметрию содержимое не пишется — только факт «заявка принята» с userId.
// Дедупа нет намеренно (правило бота: чистый INSERT, повтор = вторая строка).
import { Router } from "express";
import { saveContestEntry, CONTEST_MODE, URL_RE } from "../services/botChannel.js";

const router = Router();

/** Фронту для показа кнопки: конкурс идёт или нет. Флаг живёт здесь, не во фронте. */
router.get("/status", (req, res) => {
  res.json({ active: CONTEST_MODE });
});

router.post("/entry", async (req, res) => {
  if (!CONTEST_MODE) return res.status(403).json({ error: "contest_off" });

  const userId = req.max?.userId;
  // Без userId заявка бесполезна: победителя не опознать и не связаться.
  if (!userId) return res.status(401).json({ error: "Открой приложение внутри MAX — иначе мы не сможем связаться с победителем." });

  // Первое совпадение из текста — ровно как бот вытаскивает ссылку из сообщения.
  const link = String(req.body?.url ?? "").match(URL_RE)?.[0] ?? null;
  if (!link) return res.status(400).json({ error: "Пришли полную ссылку на ролик (вида https://…)." });

  const contact = typeof req.body?.contact === "string" && req.body.contact.trim() ? req.body.contact.trim() : null;

  try {
    await saveContestEntry(userId, link, contact);
    console.log(new Date().toISOString(), "[contest] заявка из приложения принята", { userId });
    res.json({ ok: true });
  } catch (err) {
    // Fail-open к приложению: сбой БД живёт только в этом ответе.
    console.error("[contest] запись заявки не удалась:", err.message);
    res.status(503).json({ error: "Не получилось сохранить заявку — попробуй ещё раз через минуту." });
  }
});

export default router;
