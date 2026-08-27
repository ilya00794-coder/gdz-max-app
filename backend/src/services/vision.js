// Распознавание условия задачи / рукописного решения по фото — реальный вызов Claude API (vision).
//
// Важно по ограничению проекта: мы распознаём ФОТО, которое прислал сам ученик
// (его учебник, его тетрадь). Это ввод пользователя, а не копирование чужого решебника.
// Модель здесь только транскрибирует то, что видно на фото, и НЕ решает задачу —
// решение делает solver.js отдельным вызовом.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getClient, InputError, VISION_MODEL, VISION_EFFORT } from "./anthropicClient.js";

/** Форматы, которые принимает Claude vision. */
const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** Ограничение API — примерно 5 МБ на изображение (считаем по исходным байтам). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Схема ответа. Nullable-полей избегаем намеренно: строгий JSON-схема-режим
 * надёжнее работает на простых типах, поэтому «неизвестно» = пустая строка,
 * а в null конвертируем уже на нашей стороне.
 */
const RecognitionSchema = z.object({
  recognizedText: z
    .string()
    .describe("Полный текст того, что видно на фото, в виде обычного текста. Формулы — в LaTeX внутри $...$."),
  textbook: z
    .string()
    .describe("Автор и/или название учебника, если они видны на фото. Если не видно — пустая строка."),
  taskNumber: z
    .string()
    .describe("Номер задания/упражнения и страница, если видны (например: '№ 245, с. 78'). Если не видно — пустая строка."),
  confidence: z
    .number()
    .describe("Уверенность в распознавании от 0 до 1. Ставь низкое значение, если фото размытое или текст неразборчив."),
  issues: z
    .array(z.string())
    .describe("Проблемы с фото, мешающие распознаванию (размыто, обрезано, блик, не видно условия). Пустой массив, если всё в порядке."),
  contentType: z
    .enum(["printed_task", "handwritten_work", "unclear"])
    .describe(
      "Что РЕАЛЬНО на фото, независимо от того, зачем тебя позвали: " +
        "printed_task — печатное условие задачи из учебника или задачника; " +
        "handwritten_work — рукописная работа ученика; " +
        "unclear — определить однозначно нельзя."
    ),
});

const SYSTEM_PROMPTS = {
  // Фото учебника/задачника: нужно вытащить ТОЛЬКО печатное условие.
  // Ученик часто снимает страницу вместе с уже начатым решением — рукописное
  // в условие попадать не должно, иначе solver получит чужой черновик как часть задачи.
  task: `Ты — модуль распознавания школьного приложения-помощника.
Тебе присылают фотографию страницы учебника или задачника с условием задачи.

Твоя задача — ТОЛЬКО транскрибировать ПЕЧАТНОЕ условие задачи. Не решай задачу,
не давай подсказок, не дописывай пропущенное «по смыслу».

Печатное и рукописное разделяй строго:
- В recognizedText попадает ТОЛЬКО печатный (типографский) текст условия.
- Всё написанное от руки — черновик, решение ученика, пометки на полях, формулы,
  подчёркивания с подписями — в recognizedText НЕ попадает никогда, даже если написано
  аккуратно и даже если выглядит как продолжение условия.
- Если на фото есть любой рукописный текст, добавь в issues строку ровно такого вида:
  "обнаружен посторонний рукописный текст, не перенесён".
- Ученик часто фотографирует страницу вместе со своей тетрадью или уже начатым решением —
  это нормально, просто не переноси рукописную часть.
- Если печатного условия на фото нет вообще, оставь recognizedText пустым и укажи в issues,
  что печатное условие задачи не найдено. Не подменяй его рукописным текстом.

Правила транскрипции печатного условия:
- Переноси текст условия дословно, сохраняя нумерацию пунктов (а), б), 1., 2.).
- Математику записывай в LaTeX внутри $...$ (дроби, степени, корни, индексы).
- Если на фото несколько печатных заданий, выбери то, на которое явно указывает ученик
  (обведено, отмечено, снято крупным планом). Если непонятно — перенеси все и
  укажи это в issues.
- Таблицы переноси построчно, чертежи и рисунки описывай словами в квадратных скобках,
  например: [рисунок: треугольник ABC, прямой угол при C].
- Если название учебника или номер задания напечатаны на странице — заполни поля textbook и taskNumber.
- Ничего не выдумывай: чего не видно на фото, того нет в ответе.

Отдельно про поле contentType. Это твоё честное наблюдение о снимке, а НЕ о том,
зачем тебя вызвали. Отвечай по факту, даже если он расходится с задачей режима:
- printed_task — на фото печатное условие задачи из учебника или задачника;
- handwritten_work — на фото рукописная работа ученика;
- unclear — однозначно определить нельзя. Ставь unclear, если условие переписано
  от руки, если на снимке одновременно и печатная задача, и решение к ней,
  или если качество не позволяет отличить одно от другого.`,

  // Фото тетради: нужно вытащить ход решения ученика вместе с ошибками, как есть.
  studentWork: `Ты — модуль распознавания школьного приложения-помощника.
Тебе присылают фотографии тетради ученика с уже выполненной работой.

Твоя задача — ТОЛЬКО транскрибировать написанное учеником. Не исправляй ошибки,
не решай задачу заново, не «улучшай» запись.

Правила:
- Переноси рукописный текст и вычисления построчно, В ТОМ ВИДЕ, как они написаны,
  включая арифметические и орфографические ошибки — их будет искать другой модуль.
- Математику записывай в LaTeX внутри $...$.
- Зачёркнутое помечай так: [зачёркнуто: ...].
- Если есть условие задачи — перенеси и его, отделив строкой «--- Решение ученика ---».
- Неразборчивые фрагменты помечай как [неразборчиво] и снижай confidence.
- Ничего не додумывай за ученика.

Отдельно про поле contentType. Это твоё честное наблюдение о снимке, а НЕ о том,
зачем тебя вызвали. Отвечай по факту, даже если он расходится с задачей режима:
- printed_task — на фото печатное условие задачи из учебника или задачника;
- handwritten_work — на фото рукописная работа ученика;
- unclear — однозначно определить нельзя. Ставь unclear, если условие переписано
  от руки, если на снимке одновременно и печатная задача, и решение к ней,
  или если качество не позволяет отличить одно от другого.`,
};

/**
 * Принимает как «сырой» base64, так и data URL (`data:image/jpeg;base64,...`),
 * который отдаёт FileReader в webapp.
 */
function parseImage(input, index) {
  if (typeof input !== "string" || !input.trim()) {
    throw new InputError(`Изображение №${index + 1}: пустое значение`);
  }

  let mediaType = null;
  let data = input.trim();

  const dataUrlMatch = data.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (dataUrlMatch) {
    mediaType = dataUrlMatch[1].toLowerCase();
    data = dataUrlMatch[2];
  }

  data = data.replace(/\s+/g, ""); // base64 не должен содержать переносов строк

  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    throw new InputError(`Изображение №${index + 1}: не удалось декодировать base64`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new InputError(
      `Изображение №${index + 1}: слишком большое (${Math.round(buffer.length / 1024 / 1024)} МБ, максимум 5 МБ)`
    );
  }

  if (!mediaType) mediaType = sniffMediaType(buffer);
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    throw new InputError(
      `Изображение №${index + 1}: неподдерживаемый формат ${mediaType}. Нужен JPEG, PNG, GIF или WebP.`
    );
  }

  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

/** Определяет формат по сигнатуре файла, если data URL не пришёл. */
function sniffMediaType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("latin1").startsWith("GIF8")) return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return "неизвестный";
}

/**
 * Распознаёт текст с фото задачи или тетради.
 *
 * @param {object} params
 * @param {string[]} params.imagesBase64 - одно или несколько фото (base64 или data URL)
 * @param {"task"|"studentWork"} [params.mode="task"] - что на фото: условие задачи или работа ученика
 * @param {number} [params.grade] - класс ученика, помогает выбрать терминологию
 * @param {string} [params.subject] - предмет, помогает разобрать неоднозначные символы
 * @returns {Promise<{ recognizedText: string, textbook: string|null, taskNumber: string|null, confidence: number, issues: string[], contentType: "printed_task"|"handwritten_work"|"unclear" }>}
 */
export async function recognizeFromPhotos({ imagesBase64, mode = "task", grade, subject }) {
  if (!Array.isArray(imagesBase64) || imagesBase64.length === 0) {
    throw new InputError("Не переданы изображения для распознавания");
  }

  const system = SYSTEM_PROMPTS[mode];
  if (!system) throw new Error(`Неизвестный режим распознавания: ${mode}`);

  const imageBlocks = imagesBase64.map(parseImage);

  const context = [
    grade ? `Класс ученика: ${grade}.` : null,
    subject ? `Предмет: ${subject}.` : null,
    imageBlocks.length > 1
      ? `Фотографий: ${imageBlocks.length} — это части одной работы, распознай их как единый текст по порядку.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const instruction =
    mode === "studentWork"
      ? "Перенеси в текст всё, что написано на этих фотографиях."
      : "Перенеси в текст условие задачи с этих фотографий.";

  const client = getClient();

  const response = await client.messages.parse({
    model: VISION_MODEL,
    max_tokens: 16000,
    system,
    thinking: { type: "adaptive" },
    output_config: {
      format: zodOutputFormat(RecognitionSchema, "recognition"),
      effort: VISION_EFFORT,
    },
    messages: [
      {
        role: "user",
        content: [...imageBlocks, { type: "text", text: [context, instruction].filter(Boolean).join("\n") }],
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("Модель не вернула структурированный результат распознавания");
  }

  return {
    recognizedText: parsed.recognizedText.trim(),
    textbook: parsed.textbook.trim() || null,
    taskNumber: parsed.taskNumber.trim() || null,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    issues: parsed.issues ?? [],
    // Наблюдение модели о содержимом снимка. Ни на что в пайплайне не влияет:
    // порог confidence, режимы и 422 работают ровно как раньше.
    contentType: parsed.contentType ?? "unclear",
  };
}
