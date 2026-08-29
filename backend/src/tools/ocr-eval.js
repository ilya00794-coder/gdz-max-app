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

/**
 * Ключ сравнения. Не считаются расхождением: пробелы, обёртка $...$,
 * синонимичные LaTeX-команды и юникод-эквиваленты математических знаков —
 * «$x \\ge 2$» и «x≥2» суть одно и то же содержание.
 */
function key(s) {
  return norm(s)
    .replace(/\$/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\geq|\\ge\b/g, "≥").replace(/\\leq|\\le\b/g, "≤")
    .replace(/\\neq|\\ne\b/g, "≠")
    .replace(/\\cdot|[·×]/g, "*")
    .replace(/\\sqrt/g, "√")
    .replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\in\b/g, "∈").replace(/\\infty/g, "∞")
    .replace(/\\cup/g, "∪")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => "^" + "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c))
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => "_" + "₀₁₂₃₄₅₆₇₈₉".indexOf(c))
    .replace(/ /g, "");
}

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
 * Классификация расхождений — посимвольный дифф нормализованного текста.
 *
 * Слова — неверная гранулярность для математики: «4·120=480» у ученика одно
 * «слово», у vision «$4 \\cdot 120 = 480$» — пять. Посимвольное сравнение по key()
 * безразлично к пробелам, переносам строк, склейке строк и LaTeX-синонимам.
 * Разбиение по строкам остаётся справкой (lineInfo), в ошибки не идёт.
 *
 * Типы: цифра, знак, буква/слово (замена), пропущено, галлюцинация.
 */
const HAS_DIGIT = /[0-9]/;
const ONLY_SIGNS = /^[+\-*/=<>≤≥≠±√∈∞∪(){}\[\];:,.?!]*$/;

export function classifyDiff(truthText, recognizedText) {
  const lineInfo = {
    truthLines: truthText.split("\n").map(norm).filter(Boolean).length,
    recognizedLines: recognizedText.split("\n").map(norm).filter(Boolean).length,
  };

  const flat = (text) => key(text.replace(/-\n\s*/g, "").replace(/\n/g, " "));
  const A = flat(truthText);
  const B = flat(recognizedText);
  if (A === B) return { fullMatch: true, errors: [], lineInfo };

  const m = A.length, n = B.length;
  if ((m + 1) * (n + 1) > 16_000_000) {
    return { fullMatch: false, lineInfo,
      errors: [{ type: "структура", truth: "(текст слишком велик для посимвольного сравнения)" }] };
  }

  // Левенштейн с восстановлением пути.
  const W = n + 1;
  const dp = new Uint16Array((m + 1) * W);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    dp[i * W] = i;
    for (let j = 1; j <= n; j++) {
      dp[i * W + j] = A[i - 1] === B[j - 1]
        ? dp[(i - 1) * W + j - 1]
        : 1 + Math.min(dp[(i - 1) * W + j - 1], dp[(i - 1) * W + j], dp[i * W + j - 1]);
    }
  }

  // Путь → пооперационный список, затем группировка соседних правок в регионы.
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1] && dp[i * W + j] === dp[(i - 1) * W + j - 1]) {
      ops.push({ op: "=", a: A[--i], b: B[--j] });
    } else if (i > 0 && j > 0 && dp[i * W + j] === dp[(i - 1) * W + j - 1] + 1) {
      ops.push({ op: "~", a: A[--i], b: B[--j] });
    } else if (i > 0 && dp[i * W + j] === dp[(i - 1) * W + j] + 1) {
      ops.push({ op: "-", a: A[--i] });
    } else {
      ops.push({ op: "+", b: B[--j] });
    }
  }
  ops.reverse();

  const errors = [];
  let region = null;
  let posA = 0;
  const GAP = 2; // до двух совпавших символов между правками — один регион

  const flush = () => {
    if (!region) return;
    const del = region.del, ins = region.ins;
    let type;
    if (del && !ins) type = "пропущено";
    else if (!del && ins) type = "галлюцинация";
    else if (HAS_DIGIT.test(del) || HAS_DIGIT.test(ins)) type = "цифра";
    else if (ONLY_SIGNS.test(del) && ONLY_SIGNS.test(ins)) type = "знак";
    else type = "буква/слово";
    const ctx = (from, len) => A.slice(Math.max(0, from - 10), Math.min(m, from + len + 10));
    errors.push({ type, truth: del ? `…${ctx(region.startA, del.length)}…` : `…${ctx(region.startA, 0)}…`,
                  got: `${del || "∅"} → ${ins || "∅"}` });
    region = null;
  };

  let gap = 0;
  for (const o of ops) {
    if (o.op === "=") {
      if (region && ++gap > GAP) flush();
      if (!region) gap = 0;
      posA++;
      continue;
    }
    if (!region) region = { startA: posA, del: "", ins: "" };
    else gap = 0;
    if (o.op === "~") { region.del += o.a; region.ins += o.b; posA++; }
    else if (o.op === "-") { region.del += o.a; posA++; }
    else region.ins += o.b;
  }
  flush();

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
