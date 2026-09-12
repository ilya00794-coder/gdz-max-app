// GET /api/features — какие AI-разделы показывать этому клиенту + актуальная
// версия фронта (фикс вечного кэша Pages: вебвью держит index до 10+ минут,
// боль ловилась трижды за 12.09 — приложение само перезагрузится мимо кэша).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { requestSource } from "../middleware/maxInitData.js";
import { featuresFor } from "../services/aiFeatures.js";

const router = Router();

// Версия фронта из webapp/version.js (репо на этой же машине; деплой-скрипт
// пишет её при каждом деплое). Кэш по mtime — файл читается не чаще смены.
const VERSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../webapp/version.js");
let verCache = { mtime: 0, value: null };
function frontVersion() {
  try {
    const mtime = fs.statSync(VERSION_FILE).mtimeMs;
    if (mtime !== verCache.mtime) {
      const m = /APP_VERSION\s*=\s*"([^"]+)"/.exec(fs.readFileSync(VERSION_FILE, "utf8"));
      verCache = { mtime, value: m?.[1] ?? null };
    }
  } catch { verCache = { mtime: 0, value: null }; }
  return verCache.value;
}

router.get("/", (req, res) => {
  res.json({ features: featuresFor(requestSource(req), req.max?.userId), frontVersion: frontVersion() });
});

export default router;
