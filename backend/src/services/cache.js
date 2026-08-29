// Кэш верифицированных решений — таблица solutions_cache в Postgres.
//
// Кэшируются ТОЛЬКО наши собственные решения (см. routes/solve.js: кладём лишь при
// verification.verified === true). Никаких текстов чужих решебников, учебников или
// фотографий пользователей здесь не хранится.
//
// Схема и миграция — backend/src/db/. Миграция запускается вручную: npm run migrate.

import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

/** Для локальной разработки достаточно базы gdz_max на localhost без пароля. */
export const DATABASE_URL = process.env.DATABASE_URL || "postgresql://localhost/gdz_max";

let pool = null;

/** Ленивый пул: создаётся при первом обращении, переиспользуется дальше. */
export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Кэш не должен держать запрос: лучше быстро упасть, чем подвесить ученика.
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
      max: Number(process.env.DB_POOL_MAX || 10),
    });

    // Без обработчика ошибка простаивающего клиента роняет процесс.
    pool.on("error", (err) => console.error("[cache] ошибка простаивающего соединения:", err.message));
  }
  return pool;
}

/**
 * Проверка связи с БД при старте сервера.
 * Молчаливого отката на in-memory здесь нет намеренно: он замаскировал бы поломку
 * именно в тот момент, когда мы уверены, что кэш уже работает через базу.
 *
 * @returns {Promise<{ok: true, version: string}>}
 * @throws при недоступной базе — с текстом, по которому понятно, что чинить
 */
export async function assertDatabaseReady() {
  if (!process.env.DATABASE_URL) {
    console.warn(`[cache] DATABASE_URL не задан, использую значение по умолчанию: ${DATABASE_URL}`);
  }

  const { rows } = await getPool().query("SELECT version() AS version");

  // Таблица должна существовать: миграция — отдельное ручное действие.
  const { rows: table } = await getPool().query(
    `SELECT to_regclass('public.solutions_cache') AS name`
  );
  if (!table[0].name) {
    throw new Error("таблица solutions_cache не найдена — выполните: npm run migrate");
  }

  return { ok: true, version: rows[0].version.split(",")[0] };
}

/**
 * Строит канонический ключ задачи. Чистая функция, к базе не обращается.
 *
 * Приоритет: учебник+класс+предмет+номер задания (если распознано на фото).
 * Fallback: хэш нормализованного текста условия.
 */
export function buildCacheKey({ textbook, grade, subject, taskNumber, rawText }) {
  if (textbook && grade && subject && taskNumber) {
    return `book:${textbook}:${grade}:${subject}:${taskNumber}`.toLowerCase();
  }
  const normalized = (rawText || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  // Класс и предмет — часть ключа: одно и то же условие для 5 и 8 класса решается
  // по-разному (белый список методов curriculum.js), общий кэш обесценивал бы его.
  // book:-ветка выше содержит их изначально.
  return `text:${grade}:${subject}:${hash}`.toLowerCase();
}

/**
 * @param {string} key
 * @returns {Promise<object|null>} решение вместе с cachedAt, либо null
 */
export async function getCached(key) {
  const { rows } = await getPool().query(
    `SELECT solution, cached_at FROM solutions_cache WHERE cache_key = $1`,
    [key]
  );
  if (!rows.length) return null;

  return { ...rows[0].solution, cachedAt: rows[0].cached_at.toISOString() };
}

/**
 * Кладёт решение в кэш. Повторная запись по тому же ключу обновляет строку —
 * пересчитанное решение должно вытеснять старое, а не падать на конфликте.
 *
 * @param {string} key
 * @param {object} solution - объект решения целиком
 * @returns {Promise<void>}
 */
export async function setCached(key, solution) {
  const verificationMethod = solution?.verification?.method ?? null;

  await getPool().query(
    `INSERT INTO solutions_cache (cache_key, solution, verification_method, cached_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (cache_key) DO UPDATE
       SET solution = EXCLUDED.solution,
           verification_method = EXCLUDED.verification_method,
           cached_at = now()`,
    [key, solution, verificationMethod]
  );
}

/** Закрывает пул — для скриптов и тестов, серверу не нужно. */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
