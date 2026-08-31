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
 * Ключ — хэш нормализованного текста условия + класс + предмет.
 * Ветка «учебник+номер» удалена 31.08.2026 (0 срабатываний из 84 записей:
 * автор учебника не печатается на странице с задачей, vision его не видит).
 * Будущая форма — в бэклоге: textbook из ПРОФИЛЯ ученика, номер из фото.
 */
/**
 * Нормализация условия перед хэшированием: два распознавания ОДНОЙ задачи
 * (другой пользователь, ракурс, свет) должны дать один ключ. Живой факт
 * 31.08.2026: пара прогонов одного фото доски различалась только «;»/«.»
 * в концах строк и пробелом внутри формулы («\ge 0» ↔ «\ge0»).
 *
 * ПРИНЦИП БЕЗОПАСНОСТИ (решение Ильи 31.08.2026): НЕ УДАЛЯЕМ НИ ОДНОГО
 * ЗНАЧАЩЕГО СИМВОЛА — ложное попадание (ученик получает ЧУЖОЕ решение)
 * хуже промаха. Удалять НЕЛЬЗЯ:
 *  - глаголы задания: «Решите неравенство …» и «Докажите тождество …»
 *    с одной и той же формулой — РАЗНЫЕ задачи;
 *  - знаки сравнения: «x²−11x+24<0» и «x²−11x+24>0» — разные задачи;
 *  - знаки операций и цифры: «24−9» и «24+9», «3(6x−1)» и «3(6x+1)».
 * Убираем ТОЛЬКО регистр, все пробелы (внутри формул тоже) и пунктуацию
 * КРАЁВ строк. Любое расширение набора — заново через контрольные пары.
 */
// Вводные строки, отбрасываемые целиком. Список КОРОТКИЙ И ЗАКРЫТЫЙ
// (решение Ильи 01.09.2026) — не расширять по ходу: это перечисление,
// и оно должно оставаться маленьким.
const INTRO_LINE = /^(задание|задача|вариант|упражнение|пример)\s*(№\s*\d+|\d+)?\s*[.:]?$/i;

function normalizeTaskText(text) {
  return String(text || "")
    .toLowerCase()
    // Канонизация ЭКВИВАЛЕНТНЫХ ЗАПИСЕЙ ОДНОГО оператора (учебник ставит «≥»,
    // тетрадь — «>=», это одна задача). ВАЖНО: «<» и «>» — РАЗНЫЕ операторы
    // и друг в друга НЕ канонизируются: «x²−5x−14<0» и «…>0» — разные задачи.
    .replace(/[≥⩾]/g, ">=")
    .replace(/[≤⩽]/g, "<=")
    .replace(/≠/g, "!=")
    .replace(/[·×∙]/g, "*")
    .replace(/[−–—]/g, "-")
    .replace(/÷/g, "/")
    .split("\n")
    .filter((line) => !INTRO_LINE.test(line.trim()))
    .join(" ")
    // Пунктуация убирается ВЕЗДЕ, КРОМЕ зажатой между цифрами: «3:4»
    // (отношение), «1,5» и «2.5» (десятичные), «14:30» (время), «1;2»
    // (перечень в множестве) остаются — иначе «3:4» слиплось бы с «34».
    .replace(/(?<!\d)[.,;:!?{}]|[.,;:!?{}](?!\d)/g, "")
    .replace(/\s+/g, "");
}

export function buildCacheKey({ grade, subject, rawText }) {
  const normalized = normalizeTaskText(rawText);
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
