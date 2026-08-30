// Ручная миграция схемы: node src/db/migrate.js (или npm run migrate).
//
// Намеренно НЕ запускается автоматически при старте сервера: миграция схемы — это
// осознанное действие, а не побочный эффект деплоя. schema.sql идемпотентен
// (CREATE TABLE/INDEX IF NOT EXISTS), поэтому повторный запуск безопасен.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, DATABASE_URL } from "../services/cache.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = await fs.readFile(path.join(HERE, "schema.sql"), "utf8");
  const pool = getPool();

  console.log(`Применяю схему к ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`);
  await pool.query(schema);

  for (const table of ["solutions_cache", "feedback", "reference_solutions", "verify_events"]) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    if (!rows.length) throw new Error(`Таблица ${table} не найдена после миграции`);

    console.log(`\nТаблица ${table}:`);
    for (const r of rows) {
      console.log(`  ${r.column_name.padEnd(20)} ${r.data_type.padEnd(26)} ${r.is_nullable === "NO" ? "NOT NULL" : ""} ${r.column_default ?? ""}`);
    }

    const { rows: indexes } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
      [table]
    );
    console.log("  индексы:", indexes.map((i) => i.indexname).join(", "));
  }

  await pool.end();
  console.log("\nМиграция применена.");
}

main().catch((err) => {
  console.error("Миграция не удалась:", err.message);
  process.exit(1);
});
