// Оценка качества распознавания рукописи (режим studentWork).
//
// Вход:
//   eval-data/ocr/*.jpg|png   — фото тетрадей (В GIT НЕ ПОПАДАЮТ, см. README рядом)
//   eval-data/ocr/truth.json  — эталон, руками: [{ file, grade, subject, truth }]
//     truth — многострочный текст того, что РЕАЛЬНО написано на фото,
//     в той же нотации, что отдаёт vision (формулы в $...$).
//     Без имён и опознавательных данных.
//
// Запуск: npm run ocr-eval
// Промпты этот инструмент не трогает — он только меряет текущий пайплайн.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recognizeFromPhotos } from "../services/vision.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCR_EVAL_DIR || path.join(HERE, "../../eval-data/ocr");
const TRUTH_PATH = path.join(DATA_DIR, "truth.json");

const MIME = { ".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp" };

/** Нормализация строки для сравнения: пробелы, юникод-минусы, хвостовая пунктуация. */
function norm(line) {
  return line
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[;,.]\s*$/, "")
    .trim();
}

/** Ключ сравнения: пробелы внутри строки не считаются расхождением ($x=2$ и $x = 2$ — одно). */
const key = (s) => norm(s).replace(/ /g, "");

const DIGITS = /[0-9]/g;
const SIGNS = /[+\-*/=<>±·√^_]/g;

/** Скелет строки без цифр/знаков — чтобы понять, «та же ли это строка». */
const skeleton = (s) => key(s).replace(DIGITS, "#").replace(SIGNS, "@");
const digitsOf = (s) => (key(s).match(DIGITS) || []).join("");
const signsOf = (s) => (key(s).match(SIGNS) || []).join("");

/**
 * Классификация расхождений между эталоном и распознанным.
 * Выравнивание строк — LCS по нормализованным строкам; несовпавшие пары
 * добираются по совпадению скелета (та же строка с другой цифрой/знаком).
 *
 * @returns {{fullMatch: boolean, errors: {type: string, truth?: string, got?: string}[]}}
 */
export function classifyDiff(truthText, recognizedText) {
  const T = truthText.split("\n").map(norm).filter(Boolean);
  const R = recognizedText.split("\n").map(norm).filter(Boolean);

  // LCS-таблица по точному совпадению строк.
  const dp = Array.from({ length: T.length + 1 }, () => new Array(R.length + 1).fill(0));
  for (let i = T.length - 1; i >= 0; i--)
    for (let j = R.length - 1; j >= 0; j--)
      dp[i][j] = key(T[i]) === key(R[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const unmatchedT = [];
  const unmatchedR = [];
  let i = 0, j = 0;
  while (i < T.length && j < R.length) {
    if (key(T[i]) === key(R[j])) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) unmatchedT.push(T[i++]);
    else unmatchedR.push(R[j++]);
  }
  while (i < T.length) unmatchedT.push(T[i++]);
  while (j < R.length) unmatchedR.push(R[j++]);

  const errors = [];
  const usedR = new Set();

  for (const t of unmatchedT) {
    // Ищем распознанную строку с тем же скелетом — это «та же строка, но с ошибкой».
    const k = unmatchedR.findIndex((r, idx) => !usedR.has(idx) && skeleton(r) === skeleton(t));
    if (k !== -1) {
      usedR.add(k);
      const r = unmatchedR[k];
      if (digitsOf(t) !== digitsOf(r)) errors.push({ type: "цифра", truth: t, got: r });
      else if (signsOf(t) !== signsOf(r)) errors.push({ type: "знак", truth: t, got: r });
      else errors.push({ type: "структура", truth: t, got: r });
    } else {
      errors.push({ type: "пропущенная строка", truth: t });
    }
  }

  unmatchedR.forEach((r, idx) => {
    if (!usedR.has(idx)) {
      // Строка есть в распознанном, но нет в эталоне. Если скелет ни с чем не
      // рифмуется — модель это придумала.
      const похожаНаЭталонную = T.some((t) => skeleton(t) === skeleton(r));
      errors.push({ type: похожаНаЭталонную ? "структура" : "галлюцинация", got: r });
    }
  });

  return { fullMatch: errors.length === 0, errors };
}

async function main() {
  if (!fs.existsSync(TRUTH_PATH)) {
    console.log(`Нет эталона: ${TRUTH_PATH}`);
    console.log("Положите фото тетрадей в eval-data/ocr/ и опишите их в truth.json:");
    console.log('  [{ "file": "photo1.jpg", "grade": 8, "subject": "Алгебра", "truth": "строка 1\\nстрока 2" }]');
    console.log("Синтетику не подкладывать: рукопись, отрисованная шрифтом, даст ложную картину.");
    process.exit(1);
  }

  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8"));
  if (!Array.isArray(truth) || !truth.length) {
    console.log("truth.json пуст — мерить нечего.");
    process.exit(1);
  }

  const results = [];
  for (const item of truth) {
    const file = path.join(DATA_DIR, item.file);
    const ext = path.extname(file).toLowerCase();
    if (!fs.existsSync(file) || !MIME[ext]) {
      console.log(`ПРОПУСК ${item.file}: файла нет или формат не поддержан`);
      continue;
    }
    process.stdout.write(`распознаю ${item.file} (${item.grade} кл., ${item.subject})… `);
    const t0 = Date.now();
    let rec;
    try {
      rec = await recognizeFromPhotos({
        imagesBase64: [`data:image/${MIME[ext]};base64,${fs.readFileSync(file).toString("base64")}`],
        mode: "studentWork",
        grade: item.grade,
        subject: item.subject,
      });
    } catch (err) {
      console.log(`ОШИБКА: ${err.message}`);
      results.push({ ...item, failed: err.message });
      continue;
    }
    const diff = classifyDiff(item.truth, rec.recognizedText);
    console.log(`${Math.round((Date.now() - t0) / 1000)}с, ${diff.fullMatch ? "полное совпадение" : diff.errors.length + " расхождений"}`);
    results.push({ ...item, recognized: rec.recognizedText, confidence: rec.confidence, diff });
  }

  // ---- отчёт ----
  console.log("\n════════ ДЕТАЛИ ════════");
  for (const r of results) {
    console.log(`\n— ${r.file} (${r.grade} кл., ${r.subject})${r.failed ? " — СБОЙ: " + r.failed : ""}`);
    if (r.failed) continue;
    console.log(`  confidence: ${r.confidence}`);
    for (const e of r.diff.errors) {
      console.log(`  [${e.type}]`);
      if (e.truth !== undefined) console.log(`     эталон:      ${e.truth}`);
      if (e.got !== undefined) console.log(`     распознано:  ${e.got}`);
    }
    if (r.diff.fullMatch) console.log("  без расхождений");
  }

  const ok = results.filter((r) => r.diff?.fullMatch);
  const byType = {};
  const byGrade = {};
  for (const r of results) {
    if (!r.diff) continue;
    for (const e of r.diff.errors) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      byGrade[r.grade] = (byGrade[r.grade] || 0) + 1;
    }
  }
  console.log("\n════════ СВОДКА ════════");
  console.log(`фото обработано: ${results.filter((r) => !r.failed).length} из ${truth.length}`);
  console.log(`полностью верных: ${ok.length} (${Math.round((100 * ok.length) / Math.max(1, results.length))}%)`);
  console.log("ошибки по типам:", Object.keys(byType).length ? byType : "нет");
  console.log("ошибки по классам:", Object.keys(byGrade).length ? byGrade : "нет");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error("инструмент упал:", e.message); process.exit(1); });
