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

const MIME = { ".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp", ".gif": "gif" };

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

/** Расстояние Левенштейна — для спаривания строк прозы, где скелет не работает. */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const similarity = (a, b) => 1 - editDistance(key(a), key(b)) / Math.max(key(a).length, key(b).length, 1);
const digitsOf = (s) => (key(s).match(DIGITS) || []).join("");
const signsOf = (s) => (key(s).match(SIGNS) || []).join("");

/**
 * Классификация расхождений — по СЛОВАМ склеенного текста, не по строкам:
 * vision волен переносить строки иначе, чем на фото (склеивает абзацы),
 * и это не ошибка распознавания. Разбиение по строкам сравнивается отдельно
 * как справка (lineInfo), в ошибки не идёт.
 *
 * Типы: цифра, знак, буква/слово (замена), пропущено (слово из эталона
 * не распознано), галлюцинация (распознано слово, которого нет).
 *
 * @returns {{fullMatch: boolean, errors: {type: string, truth?: string, got?: string}[],
 *            lineInfo: {truthLines: number, recognizedLines: number}}}
 */
export function classifyDiff(truthText, recognizedText) {
  const lineInfo = {
    truthLines: truthText.split("\n").map(norm).filter(Boolean).length,
    recognizedLines: recognizedText.split("\n").map(norm).filter(Boolean).length,
  };

  // Перенос слова через дефис на границе строки — артефакт разбиения, не ошибка OCR.
  const words = (text) => norm(text.replace(/-\n\s*/g, "").replace(/\n/g, " ")).split(" ").filter(Boolean);
  const T = words(truthText);
  const R = words(recognizedText);

  // LCS по словам (сравнение через key: пробелы/пунктуация-хвосты не в счёт).
  const dp = Array.from({ length: T.length + 1 }, () => new Array(R.length + 1).fill(0));
  for (let i = T.length - 1; i >= 0; i--)
    for (let j = R.length - 1; j >= 0; j--)
      dp[i][j] = key(T[i]) === key(R[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const errors = [];
  let i = 0, j = 0;
  while (i < T.length && j < R.length) {
    if (key(T[i]) === key(R[j])) { i++; j++; continue; }
    // Замена одного слова другим: и следующий шаг LCS не тянет ни туда, ни сюда.
    if (dp[i + 1][j] === dp[i][j + 1] && dp[i + 1][j + 1] === dp[i + 1][j]) {
      const t = T[i++], r = R[j++];
      if (digitsOf(t) !== digitsOf(r)) errors.push({ type: "цифра", truth: t, got: r });
      else if (signsOf(t) !== signsOf(r)) errors.push({ type: "знак", truth: t, got: r });
      else errors.push({ type: "буква/слово", truth: t, got: r });
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      errors.push({ type: "пропущено", truth: T[i++] });
    } else {
      errors.push({ type: "галлюцинация", got: R[j++] });
    }
  }
  while (i < T.length) errors.push({ type: "пропущено", truth: T[i++] });
  while (j < R.length) errors.push({ type: "галлюцинация", got: R[j++] });

  return { fullMatch: errors.length === 0, errors, lineInfo };
}

// --offline: переанализ сохранённых распознаваний без новых vision-вызовов.
const OFFLINE = process.argv.includes("--offline");
let offlineData = [];

async function main() {
  if (OFFLINE) {
    const dump = path.join(DATA_DIR, "last-run.json");
    if (!fs.existsSync(dump)) { console.log("нет last-run.json — сначала живой прогон"); process.exit(1); }
    offlineData = JSON.parse(fs.readFileSync(dump, "utf8"));
  }
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
    process.stdout.write(`${OFFLINE ? "переанализ" : "распознаю"} ${item.file} (${item.grade} кл., ${item.subject})… `);
    const t0 = Date.now();
    let rec;
    if (OFFLINE) {
      const saved = offlineData.find((r) => r.file === item.file);
      if (!saved?.recognized) { console.log("нет в last-run.json"); continue; }
      rec = { recognizedText: saved.recognized, confidence: saved.confidence };
    } else {
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
    }
    const diff = classifyDiff(item.truth, rec.recognizedText);
    console.log(`${Math.round((Date.now() - t0) / 1000)}с, ${diff.fullMatch ? "полное совпадение" : diff.errors.length + " расхождений"}`);
    results.push({ ...item, recognized: rec.recognizedText, confidence: rec.confidence, diff });
  }

  if (!OFFLINE) fs.writeFileSync(
    path.join(DATA_DIR, "last-run.json"),
    JSON.stringify(results.map(({ file, grade, subject, recognized, confidence, failed }) =>
      ({ file, grade, subject, recognized, confidence, failed })), null, 2)
  );

  // ---- отчёт ----
  console.log("\n════════ ДЕТАЛИ ════════");
  for (const r of results) {
    console.log(`\n— ${r.file} (${r.grade} кл., ${r.subject})${r.failed ? " — СБОЙ: " + r.failed : ""}`);
    if (r.failed) continue;
    console.log(`  confidence: ${r.confidence}; строк: эталон ${r.diff.lineInfo.truthLines} / распознано ${r.diff.lineInfo.recognizedLines}`);
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
