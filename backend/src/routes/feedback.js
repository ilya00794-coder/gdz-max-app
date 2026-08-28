import { Router } from "express";
import { getPool } from "../services/cache.js";

const router = Router();

/** Разумные потолки: жалоба — короткий сигнал, а не выгрузка всего состояния. */
const LIMITS = {
  subject: 100,
  recognizedText: 20000,
  userComment: 2000,
  snapshotBytes: 256 * 1024,
};

const TYPES = ["solve", "check"];

/**
 * POST /api/feedback
 * body: { type, grade?, subject?, recognizedText?, solutionSnapshot?, userComment? }
 *
 * Принимает жалобу на решение или на проверку домашней работы.
 * Фотографии сюда не попадают и не сохраняются: в базу идёт только текст и структура
 * того, что реально показали пользователю.
 *
 * Идентификатор пользователя MAX берётся из подписанной строки запуска (req.max),
 * а не из тела запроса — телу в этом вопросе доверять нельзя.
 */
router.post("/", async (req, res) => {
  try {
    const { type, grade, subject, recognizedText, solutionSnapshot, userComment } = req.body ?? {};

    if (!TYPES.includes(type)) {
      return res.status(400).json({ error: `Поле type должно быть одним из: ${TYPES.join(", ")}` });
    }

    const parsedGrade = grade === undefined || grade === null ? null : Number(grade);
    if (parsedGrade !== null && (!Number.isInteger(parsedGrade) || parsedGrade < 1 || parsedGrade > 11)) {
      return res.status(400).json({ error: "grade должен быть целым числом от 1 до 11" });
    }

    const text = (value, limit) =>
      typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

    let snapshot = null;
    if (solutionSnapshot && typeof solutionSnapshot === "object") {
      const serialized = JSON.stringify(solutionSnapshot);
      if (serialized.length > LIMITS.snapshotBytes) {
        return res.status(413).json({ error: "Слишком большой снимок состояния" });
      }
      snapshot = solutionSnapshot;
    }

    const { rows } = await getPool().query(
      `INSERT INTO feedback (type, grade, subject, recognized_text, solution_snapshot, user_comment, max_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        type,
        parsedGrade,
        text(subject, LIMITS.subject),
        text(recognizedText, LIMITS.recognizedText),
        snapshot,
        text(userComment, LIMITS.userComment),
        req.max?.userId ? String(req.max.userId) : null,
      ]
    );

    console.log("[feedback] принята жалоба", {
      id: rows[0].id,
      type,
      grade: parsedGrade,
      subject: text(subject, LIMITS.subject),
      сКомментарием: Boolean(text(userComment, LIMITS.userComment)),
      userId: req.max?.userId ?? null,
    });

    res.json({ ok: true, id: String(rows[0].id) });
  } catch (err) {
    console.error("[feedback] не удалось сохранить жалобу:", err);
    res.status(500).json({ error: "Не удалось сохранить сообщение" });
  }
});

export default router;
