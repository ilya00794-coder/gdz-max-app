// Общий клиент Claude API для всех AI-сервисов бэкенда.
// Ключ берётся ТОЛЬКО из переменной окружения (см. .env.example, .env в .gitignore).

import Anthropic from "@anthropic-ai/sdk";

/** Модель по умолчанию для всех вызовов; переопределяется на уровне сервиса. */
export const DEFAULT_MODEL = "claude-opus-5";

/** Модель для распознавания фото (vision). */
export const VISION_MODEL = process.env.VISION_MODEL || DEFAULT_MODEL;

/**
 * Глубина рассуждений для vision-этапа. Распознавание — не самая тяжёлая задача,
 * поэтому по умолчанию "medium": дешевле, чем "high", без заметной потери качества.
 * Допустимые значения: low | medium | high | xhigh | max.
 */
export const VISION_EFFORT = process.env.VISION_EFFORT || "medium";

/** Модель для решения задач. */
export const SOLVER_MODEL = process.env.SOLVER_MODEL || DEFAULT_MODEL;

/**
 * Глубина рассуждений на этапе решения. Здесь, в отличие от распознавания,
 * экономить нельзя: цена ошибки — неверное решение в тетради ученика.
 */
export const SOLVER_EFFORT = process.env.SOLVER_EFFORT || "high";

/** Модель для пошагового сравнения работы ученика с эталоном. */
export const COMPARE_MODEL = process.env.COMPARE_MODEL || DEFAULT_MODEL;

/**
 * Глубина рассуждений при сравнении. Здесь модель выносит вердикт о правильности
 * чужой работы — ошибиться дороже, чем сэкономить, поэтому high.
 */
export const COMPARE_EFFORT = process.env.COMPARE_EFFORT || "high";

/** Ошибка входных данных пользователя (плохое фото, неверный формат) — это 400, а не 500. */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
    this.code = "BAD_INPUT";
  }
}

let client = null;

/**
 * Ошибка конфигурации (нет ключа) — отличаем её от ошибок самого API,
 * чтобы роут мог вернуть понятный статус, а не «внутренняя ошибка».
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.code = "ANTHROPIC_NOT_CONFIGURED";
  }
}

/**
 * Ленивая инициализация клиента: сервер должен подниматься даже без ключа
 * (health-check, отдача статики), а падать — только на реальном AI-вызове.
 */
export function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ConfigError(
      "Не задан ANTHROPIC_API_KEY. Скопируйте .env.example в .env и укажите ключ."
    );
  }
  if (!client) {
    client = new Anthropic(); // ключ читается из ANTHROPIC_API_KEY
  }
  return client;
}

/** Приводит ошибку SDK к короткому человекочитаемому виду для логов/ответа. */
export function describeApiError(err) {
  if (err instanceof ConfigError || err instanceof InputError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Неверный ANTHROPIC_API_KEY";
  if (err instanceof Anthropic.RateLimitError) return "Превышен лимит запросов к Claude API, попробуйте позже";
  if (err instanceof Anthropic.BadRequestError) return `Некорректный запрос к Claude API: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Не удалось соединиться с Claude API";
  if (err instanceof Anthropic.APIError) return `Ошибка Claude API ${err.status}: ${err.message}`;
  return err?.message || "Неизвестная ошибка";
}
