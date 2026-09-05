// POST /api/ui-event — события интерфейса (03.09.2026). Пока один класс:
// выбор режима на первом экране (mode_solve | mode_check). Fire-and-forget
// с фронта; здесь — белый список и запись. Зачем: доля выбора «Проверить
// домашку» отличает «не нашли вход» от «сценарий не нужен».
import { Router } from "express";
import { getPool } from "../services/cache.js";
import { hashUser } from "../services/telemetry.js";

// voice_* (03.09): отказы getUserMedia с err.name и успешные записи —
// знаменатель для доли отказов. Класс был невидим, узнавали от людей.
// share (05.09): нажатие «Скинуть другу» под решением. Меряем ЖЕЛАНИЕ
// поделиться (клик), не доходимость друга — осознанно. Знаменатель —
// показы решения из verify_events, отдельного события показа нет.
const KINDS = new Set(["mode_solve", "mode_check", "voice_ok", "voice_fail", "retake", "share"]);
const router = Router();

router.post("/", (req, res) => {
  const kind = req.body?.kind;
  if (!KINDS.has(kind)) return res.status(400).json({ error: "неизвестный kind" });
  const platform = ["ios", "android", "web"].includes(req.get("X-Platform")) ? req.get("X-Platform") : null;
  const detail = typeof req.body?.detail === "string" ? req.body.detail.slice(0, 40) : null;
  // Fire-and-forget: ответ не ждёт записи, сбой — строка в лог.
  getPool()
    .query(
      `INSERT INTO ui_events (kind, user_hash, platform, start_param, detail) VALUES ($1,$2,$3,$4,$5)`,
      [kind, hashUser(req.max?.userId), platform, req.max?.params?.start_param ?? null, detail]
    )
    .catch((err) => console.warn(new Date().toISOString(), "[ui-event] запись не удалась:", err.message));
  res.json({ ok: true });
});

export default router;
