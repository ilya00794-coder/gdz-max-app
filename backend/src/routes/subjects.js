// GET /api/subjects?grade=N — предметы, изучаемые в этом классе (по ФУП).
// Фронт строит из них чипы выбора; данные — src/data/curriculum/subjects.json.

import { Router } from "express";
import { getSubjectsForGrade } from "../services/subjects.js";

const router = Router();

router.get("/", (req, res) => {
  const grade = Number(req.query.grade);
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    return res.status(400).json({ error: "grade должен быть целым числом от 1 до 11" });
  }
  res.json({ grade, subjects: getSubjectsForGrade(grade) });
});

export default router;
