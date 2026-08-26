import express from "express";
import cors from "cors";
import solveRouter from "./src/routes/solve.js";
import checkHomeworkRouter from "./src/routes/checkHomework.js";
import { assertDatabaseReady, DATABASE_URL } from "./src/services/cache.js";
import { maxInitData, INIT_DATA_HEADER } from "./src/middleware/maxInitData.js";

const app = express();
app.use(
  cors({
    // Мини-приложение открывается с домена, отданного MAX, и шлёт строку запуска заголовком.
    allowedHeaders: ["Content-Type", INIT_DATA_HEADER],
  })
);
app.use(express.json({ limit: "15mb" })); // фото в base64 могут быть тяжёлыми

// Разбор строки запуска MAX. Пока только логирует, запросы не отвергает.
app.use("/api", maxInitData);

app.use("/api/solve", solveRouter);
app.use("/api/check-homework", checkHomeworkRouter);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;

// Проверяем базу ДО старта. Тихого отката на in-memory нет намеренно: он бы замаскировал
// поломку кэша ровно тогда, когда мы уверены, что кэш уже работает через Postgres.
// Падаем громко и с инструкцией — в проде такой лог виден, в отличие от молчаливой деградации.
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

app.listen(PORT, () => {
  console.log(`GDZ MAX backend запущен на http://localhost:${PORT}`);
});
