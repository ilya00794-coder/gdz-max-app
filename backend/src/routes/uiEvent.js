// POST /api/ui-event — события интерфейса (03.09.2026). Пока один класс:
// выбор режима на первом экране (mode_solve | mode_check). Fire-and-forget
// с фронта; здесь — белый список и запись. Зачем: доля выбора «Проверить
// домашку» отличает «не нашли вход» от «сценарий не нужен».
import { Router } from "express";
import { getPool } from "../services/cache.js";
import { hashUser } from "../services/telemetry.js";

const KINDS = new Set(["mode_solve", "mode_check"]);
const router = Router();

router.post("/", (req, res) => {
  const kind = req.body?.kind;
  if (!KINDS.has(kind)) return res.status(400).json({ error: "неизвестный kind" });
  const platform = ["ios", "android", "web"].includes(req.get("X-Platform")) ? req.get("X-Platform") : null;
  // Fire-and-forget: ответ не ждёт записи, сбой — строка в лог.
  getPool()
    .query(
      `INSERT INTO ui_events (kind, user_hash, platform, start_param) VALUES ($1,$2,$3,$4)`,
      [kind, hashUser(req.max?.userId), platform, req.max?.params?.start_param ?? null]
    )
    .catch((err) => console.warn(new Date().toISOString(), "[ui-event] запись не удалась:", err.message));
  res.json({ ok: true });
});

export default router;
