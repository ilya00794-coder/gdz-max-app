import express from "express";
import cors from "cors";
import solveRouter from "./src/routes/solve.js";
import checkHomeworkRouter from "./src/routes/checkHomework.js";
import feedbackRouter from "./src/routes/feedback.js";
import subjectsRouter from "./src/routes/subjects.js";
import transcribeRouter from "./src/routes/transcribe.js";
import { assertDatabaseReady, DATABASE_URL } from "./src/services/cache.js";
import { maxInitData, INIT_DATA_HEADER } from "./src/middleware/maxInitData.js";
import { subscriptionGate, assertGatingReady, checkSubscription } from "./src/subscription.js";
import { startBotPoller } from "./src/services/botChannel.js";
import { startHourlyReports } from "./src/services/hourlyReport.js";
import { startTunnelWatch } from "./src/services/tunnelWatch.js";
import { allPlanSubjects, isComputableSubject } from "./src/services/subjects.js";
import { hasBlockEntry } from "./src/data/subject-rules.js";

const app = express();
app.use(
  cors({
    // Мини-приложение открывается с домена, отданного MAX, и шлёт строку запуска заголовком.
    // X-App-Version шлёт КАЖДЫЙ запрос нового фронта: без него preflight
    // браузера отваливается и приложение мертво с первого экрана («нет связи»)
    // при живом сервере — curl без preflight этого не видит. X-Canary — чтобы
    // канарейка из браузера не легла так же.
    allowedHeaders: ["Content-Type", INIT_DATA_HEADER, "ngrok-skip-browser-warning", "X-App-Version", "X-Canary", "X-Platform"],
  })
);
app.use(express.json({ limit: "15mb" })); // фото в base64 могут быть тяжёлыми

// Разбор строки запуска MAX. Пока только логирует, запросы не отвергает.
app.use("/api", maxInitData);

// Принудительная перепроверка подписки (кнопка «Я подписался» на экране
// подписки). Монтируется ДО subscriptionGate: при gating=on неподписанный
// должен мочь перепроверить себя, иначе кнопка сама получала бы 403.
// Force минует кэш, лимит 1/5с — в checkSubscription.
app.post("/api/subscription/recheck", async (req, res) => {
  const userId = req.max?.userId;
  if (!userId) return res.json({ status: "no_user" });
  try {
    const { status } = await checkSubscription(userId, { force: true });
    res.json({ status });
  } catch (err) {
    console.error("[recheck] сбой:", err.message);
    res.json({ status: "error" });
  }
});
// Gating подписки — строго ПОСЛЕ maxInitData: userId берётся из req.max.
// /health не под /api и в gating не попадает.
app.use("/api", subscriptionGate);

app.use("/api/subjects", subjectsRouter);
app.use("/api/solve", solveRouter);
app.use("/api/check-homework", checkHomeworkRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/transcribe", transcribeRouter); // голос → текст (whisper.cpp локально)

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;

// Проверяем базу ДО старта. Тихого отката на in-memory нет намеренно: он бы замаскировал
// поломку кэша ровно тогда, когда мы уверены, что кэш уже работает через Postgres.
// Падаем громко и с инструкцией — в проде такой лог виден, в отличие от молчаливой деградации.
// Полнота предметных карт — до старта. Каждый предмет учебного плана обязан
// иметь ОСОЗНАННУЮ запись о вычислимости (subjects.json/computable) и о
// предметных блоках (SUBJECT_TO_BLOCKS, пусть пустую []). Молчаливый пропуск
// уже оставлял ОБЗР без блока правил, а алгебру 10–11 — без верификации.
{
  const missing = [];
  for (const subject of allPlanSubjects()) {
    try { isComputableSubject(subject); } catch { missing.push(`computable: «${subject}» (src/data/curriculum/subjects.json)`); }
    if (!hasBlockEntry(subject)) missing.push(`блоки: «${subject}» (SUBJECT_TO_BLOCKS в src/data/subject-rules.js — добавь запись, хотя бы [])`);
  }
  if (missing.length) {
    console.error("\nПРЕДМЕТНЫЕ КАРТЫ НЕПОЛНЫ — сервер не запущен:");
    for (const m of missing) console.error("  - " + m);
    process.exit(1);
  }
}

try {
  const db = await assertDatabaseReady();
  console.log(`Postgres на связи: ${db.version}`);
} catch (err) {
  console.error("\nНЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ К БАЗЕ — сервер не запущен.");
  console.error(`  DATABASE_URL: ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`);
  console.error(`  Причина: ${err.message}\n`);
  console.error("  Что проверить:");
  console.error("    1) запущен ли Postgres:  brew services start postgresql@16");
  console.error("    2) создана ли база:      createdb gdz_max");
  console.error("    3) применена ли схема:   npm run migrate");
  console.error("    4) верен ли DATABASE_URL в .env\n");
  process.exit(1);
}

// Отдельно от базы: у ошибок конфигурации gating свой текст, а не советы про Postgres.
try {
  await assertGatingReady();
} catch (err) {
  console.error("\nОШИБКА КОНФИГУРАЦИИ GATING — сервер не запущен.");
  console.error(`  ${err.message}\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`GDZ MAX backend запущен на http://localhost:${PORT}`);
});

// Приём личек бота для публикации постов (long polling, botChannel.js).
// Не await: сбой поллера не должен мешать HTTP-серверу; ошибки логируются внутри.
startBotPoller();
// Часовой отчёт админам (10:00–22:00, hourlyReport.js).
startHourlyReports();
// Сторож работоспособности туннеля (граница: молчит при смерти бэкенда —
// того поднимет launchd; см. session-state).
startTunnelWatch();
