// GET /api/features — какие AI-разделы показывать этому клиенту.
// Фронт зовёт при старте; все off → плашек нет, приложение как раньше.
import { Router } from "express";
import { requestSource } from "../middleware/maxInitData.js";
import { featuresFor } from "../services/aiFeatures.js";

const router = Router();

router.get("/", (req, res) => {
  res.json({ features: featuresFor(requestSource(req), req.max?.userId) });
});

export default router;
