// Замер: решает ли школьные задачи дешёвая модель (Haiku) так же, как Opus.
//
// npm run model-compare [файл-задач]     (по умолчанию eval-data/model-compare/tasks.json)
//
// Продукт НЕ трогается: промпт, curriculum и код solver'а те же. Модель меняется
// штатным механизмом SOLVER_MODEL — но он читается при загрузке модуля, поэтому
// инструмент запускает по ВОРКЕРУ на модель (этот же файл с --worker <model>),
// а usage-токены снимает обёрткой над мемоизированным клиентом внутри воркера.
//
// Формат файла задач (JSON-массив; образец — eval-data/model-compare/tasks.example.json):
//   {
//     "id": "g9-01",              // уникальный идентификатор
//     "grade": 9,                 // класс 1–11
//     "subject": "Алгебра",       // как на чипах приложения
//     "topic": "квадратные уравнения",  // для разбивки в сводке (необязательно)
//     "task": "Решите уравнение x^2 - 5x + 6 = 0",  // условие СВОЁ, не из учебника
//     "answer": "x = 2; x = 3",   // ответ по-человечески (попадает в отчёт)
//     "sympy": "2; 3"             // ответ для машинной сверки: значения через «;»,
//   }                             // десятичные — с точкой; «корней нет» → ""
//
// Сверка ответа с известным — через SymPy (simplify(a−b)==0), как в verify.js:
// "x = 6" ≡ "6", а не сравнение строк. Кэш решений не участвует: solveTask
// вызывается напрямую, каждая задача решается честно.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS = path.join(HERE, "../../eval-data/model-compare/tasks.json");

const MODELS = ["claude-opus-5", "claude-haiku-4-5"];

// $ за 1M токенов, проверено 2026-08-29 (anthropic.com/pricing).
// Кэш: чтение — 10% входной цены, запись (5 мин) — 125%.
const PRICES = {
  "claude-opus-5":   { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const SOLVE_TIMEOUT_MS = 180_000;
const WORKER_CONCURRENCY = 3;

// ---------- режим воркера: решает все задачи одной моделью ----------

async function workerMain(model, tasksFile) {
  process.env.SOLVER_MODEL = model; // до импорта solver.js — константа читается при загрузке
  const { solveTask } = await import("../services/solver.js");
  const { getClient } = await import("../services/anthropicClient.js");

  // Обёртка только в процессе воркера: снимает usage, ничего не меняя в продукте.
  const usageQueue = [];
  const takeUsage = () => usageQueue.shift() ?? null;
  const client = getClient();
  const originalParse = client.messages.parse.bind(client.messages);
  // Haiku 4.5 — модель до 4.6: thinking «adaptive» не поддерживает (канарейка
  // это поймала 400-й ошибкой). Единственная адаптация запроса — thinking с
  // фиксированным бюджетом; промпт, curriculum и схема ответа не меняются.
  const needsBudgetThinking = !/-(4-6|4-8|5)\b|opus-5|sonnet-5|fable-5/.test(model)
    || model.includes("haiku");
  if (needsBudgetThinking) {
    console.error(`[${model}] шим для модели до 4.6: thinking adaptive → enabled (budget 8000), output_config.effort убран`);
  }
  client.messages.parse = async (args) => {
    let patched = args;
    if (needsBudgetThinking) {
      const { effort, ...outputConfig } = args.output_config ?? {};
      patched = { ...args, thinking: { type: "enabled", budget_tokens: 8000 }, output_config: outputConfig };
    }
    const resp = await originalParse(patched);
    usageQueue.push(resp.usage ?? null);
    return resp;
  };

  const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8"));

  // Инкрементальный чекпойнт: каждое решение дозаписывается в progress-файл
  // СРАЗУ, а при рестарте уже решённые задачи не перерешиваются. Урок двух
  // потерь оплаченной работы: RESULT_JSON в конце и полный чекпойнт родителя
  // не спасают, если процесс убит между последним решением и финальной
  // записью. Файл удаляется после успешного завершения воркера.
  const progressFile = tasksFile + "." + model + ".progress.jsonl";
  const alreadyDone = new Map();
  if (fs.existsSync(progressFile)) {
    for (const line of fs.readFileSync(progressFile, "utf8").split("\n").filter(Boolean)) {
      try { const r = JSON.parse(line); if (!r.error) alreadyDone.set(r.id, r); } catch {}
    }
    if (alreadyDone.size) console.error(`[${model}] резюм: ${alreadyDone.size} задач из progress-файла, решаем ${tasks.length - alreadyDone.size}`);
  }
  // Пул из WORKER_CONCURRENCY задач: последовательный прогон 110 задач занял бы
  // ~30 минут на модель. Побочный эффект: первые задачи одной пары (класс,
  // предмет) могут параллельно писать один и тот же промпт-кэш — чуть дороже.
  // usage снимается через замыкание конкретного вызова, а не lastUsage.
  const results = new Array(tasks.length);
  let next = 0;
  async function runOne(i) {
    const task = tasks[i];
    const cached = alreadyDone.get(task.id);
    if (cached) { results[i] = cached; return; }
    const t0 = Date.now();
    let entry = { id: task.id };
    let usageCapture = null;
    try {
      const solution = await Promise.race([
        solveTask({ recognizedText: task.task, grade: task.grade, subject: task.subject })
          .then((sol) => { usageCapture = takeUsage(); return sol; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`таймаут ${SOLVE_TIMEOUT_MS / 1000} с`)), SOLVE_TIMEOUT_MS)),
      ]);
      entry.finalAnswer = solution.finalAnswer;
      entry.programWarning = solution.programWarning;
      entry.stepsCount = solution.steps.length;
      entry.solution = solution;
    } catch (err) {
      entry.error = err.message;
    }
    entry.ms = Date.now() - t0;
    entry.usage = usageCapture;
    results[i] = entry;
    fs.appendFileSync(progressFile, JSON.stringify(entry) + "\n"); // дозапись сразу
    console.error(`[${model}] ${task.id}: ${entry.error ? "ОШИБКА " + entry.error : entry.finalAnswer} (${(entry.ms / 1000).toFixed(1)} с)`);
  }
  async function pump() {
    while (next < tasks.length) await runOne(next++);
  }
  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, pump));
  process.stdout.write("RESULT_JSON:" + JSON.stringify(results) + "\n");
  fs.rmSync(progressFile, { force: true }); // успешное завершение — прогресс больше не нужен
}

// ---------- сверка ответов через SymPy ----------

/** Десятичные запятые → точки, чтобы parseCandidateAnswer не расщепил "2,72". */
function decimalCommasToDots(text) {
  return String(text ?? "").replace(/(\d),(\d)/g, "$1.$2");
}

/**
 * Чистит одно значение перед SymPy: π → pi (с неявным умножением: 25π → 25*pi),
 * градусы и юникод-степени единиц (см², см³) — прочь. Кириллицу единиц убирает
 * сам parseCandidateAnswer; здесь — то, что не покрыто им.
 */
/**
 * Числа → Rational: python-eval считает 1/3 и 0.3 флоатом ещё до SymPy, и
 * simplify((0.3)-(0.3)) капризничает на Float/Integer. Копия numbersToRationals
 * из misread.js (она там не экспортируется); баг с ведущим нулём «0.3» →
 * Rational(03,10), найденный при написании этой копии, в misread.js починен.
 */
function numbersToRationals(expr) {
  return expr.replace(/\d+\.\d+|\d+/g, (m) => {
    const dot = m.indexOf(".");
    if (dot === -1) return `Rational(${m})`;
    const frac = m.length - dot - 1;
    const digits = m.replace(".", "").replace(/^0+(?=\d)/, "");
    return `Rational(${digits},1${"0".repeat(frac)})`;
  });
}

function cleanValue(value) {
  return String(value)
    .replace(/(\d)\s*π/g, "$1*pi")
    .replace(/π/g, "pi")
    .replace(/[°²³]/g, "")
    .trim();
}

/**
 * Совпадает ли ответ модели с известным. Оба разбираются parseCandidateAnswer
 * (та же логика, что в verify.js), значения сопоставляются биекцией через
 * simplify(a−b)==0 — порядок и форма записи не важны.
 */
export async function answersMatch(modelAnswer, knownSympy, helpers) {
  const { parseCandidateAnswer, runPython } = helpers;
  const gotRaw = parseCandidateAnswer(decimalCommasToDots(modelAnswer));
  const got = gotRaw === null ? null : gotRaw.map(cleanValue).filter(Boolean);
  const known = String(knownSympy).trim() === ""
    ? []
    : decimalCommasToDots(knownSympy).split(";").map((s) => cleanValue(s)).filter(Boolean);
  if (got === null) return { match: false, reason: "ответ модели не разобрался" };
  if (got.length !== known.length) return { match: false, reason: `значений ${got.length}, ожидалось ${known.length}` };

  const { isExpressionSafe } = helpers;
  const used = new Set();
  for (const k of known) {
    let found = false;
    for (let i = 0; i < got.length; i++) {
      if (used.has(i)) continue;
      const expr = `simplify((${numbersToRationals(k)}) - (${numbersToRationals(got[i])}))`;
      if (!isExpressionSafe(expr)) continue;
      // runPython возвращает {code, stdout}; вердикт — внутри JSON в stdout
      // (см. checkArithmetic в misread.js — тот же контракт).
      const run = await runPython({ expression: expr, candidates: ["0"] });
      if (run.timedOut || run.code !== 0) continue;
      let report;
      try { report = JSON.parse(run.stdout); } catch { continue; }
      if (report.ok && report.verified) { used.add(i); found = true; break; }
    }
    if (!found) return { match: false, reason: `значение ${k} не найдено среди [${got.join(", ")}]` };
  }
  return { match: true };
}

// ---------- режим оркестратора ----------

function runWorker(model, tasksFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", model, tasksFile], {
      env: { ...process.env, SOLVER_MODEL: model },
      stdio: ["ignore", "pipe", "inherit"], // stderr воркера — прогресс, виден сразу
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
      if (code !== 0 || !line) return reject(new Error(`воркер ${model} завершился с кодом ${code}`));
      resolve(JSON.parse(line.slice("RESULT_JSON:".length)));
    });
  });
}

function costUsd(usage, model) {
  if (!usage) return null;
  const p = PRICES[model];
  const M = 1e6;
  return (
    ((usage.input_tokens ?? 0) * p.input +
      (usage.output_tokens ?? 0) * p.output +
      (usage.cache_read_input_tokens ?? 0) * p.input * 0.1 +
      (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25) / M
  );
}

function pct(n, d) {
  return d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "—";
}

function validateTasks(tasks, tasksFile) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error(`${tasksFile}: ожидается непустой JSON-массив`);
  const ids = new Set();
  for (const t of tasks) {
    for (const field of ["id", "grade", "subject", "task", "answer"]) {
      if (t[field] === undefined || t[field] === "") throw new Error(`задача ${t.id ?? "?"}: нет поля "${field}"`);
    }
    if (t.sympy === undefined) throw new Error(`задача ${t.id}: нет поля "sympy" (для «корней нет» — пустая строка "")`);
    if (ids.has(t.id)) throw new Error(`дублирующийся id: ${t.id}`);
    ids.add(t.id);
  }
}

async function main() {
  const [, , flag, workerModel, workerFile] = process.argv;
  if (flag === "--worker") return workerMain(workerModel, workerFile);

  const tasksFile = path.resolve(flag || DEFAULT_TASKS);
  if (!fs.existsSync(tasksFile)) {
    console.error(`Файл задач не найден: ${tasksFile}\nФормат — см. eval-data/model-compare/tasks.example.json`);
    process.exit(1);
  }
  const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8"));

  // Инкрементальный чекпойнт: каждое решение дозаписывается в progress-файл
  // СРАЗУ, а при рестарте уже решённые задачи не перерешиваются. Урок двух
  // потерь оплаченной работы: RESULT_JSON в конце и полный чекпойнт родителя
  // не спасают, если процесс убит между последним решением и финальной
  // записью. Файл удаляется после успешного завершения воркера.
  const progressFile = tasksFile + "." + model + ".progress.jsonl";
  const alreadyDone = new Map();
  if (fs.existsSync(progressFile)) {
    for (const line of fs.readFileSync(progressFile, "utf8").split("\n").filter(Boolean)) {
      try { const r = JSON.parse(line); if (!r.error) alreadyDone.set(r.id, r); } catch {}
    }
    if (alreadyDone.size) console.error(`[${model}] резюм: ${alreadyDone.size} задач из progress-файла, решаем ${tasks.length - alreadyDone.size}`);
  }
  validateTasks(tasks, tasksFile);
  console.error(`Задач: ${tasks.length}; модели: ${MODELS.join(", ")} — воркеры стартуют параллельно.\n`);

  const [opusResults, haikuResults] = await Promise.all(MODELS.map((m) => runWorker(m, tasksFile)));
  const byModel = { [MODELS[0]]: opusResults, [MODELS[1]]: haikuResults };

  // Сверка — в родителе, SymPy тот же для обеих моделей.
  const helpers = await import("../services/verify.js");
  const rows = [];
  for (const task of tasks) {
    const row = { task };
    for (const model of MODELS) {
      const r = byModel[model].find((x) => x.id === task.id);
      const verdict = r.error
        ? { match: false, reason: `ошибка: ${r.error}` }
        : await answersMatch(r.finalAnswer, task.sympy, helpers);
      row[model] = { ...r, ...verdict, costUsd: costUsd(r.usage, model) };
    }
    rows.push(row);
  }

  // ---------- сводка ----------
  const [OPUS, HAIKU] = MODELS;
  console.log(`\n===== СВОДКА (${tasks.length} задач) =====\n`);
  for (const model of MODELS) {
    const rs = rows.map((r) => r[model]);
    const ok = rs.filter((r) => r.match).length;
    const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const avgMs = rs.reduce((s, r) => s + r.ms, 0) / rs.length;
    console.log(`${model}: верно ${pct(ok, rs.length)}, среднее время ${(avgMs / 1000).toFixed(1)} с, стоимость $${cost.toFixed(4)} (~$${(cost / rs.length).toFixed(4)}/задача)`);
  }

  for (const dim of ["grade", "topic"]) {
    console.log(`\n--- по ${dim === "grade" ? "классам" : "темам"} ---`);
    const groups = [...new Set(tasks.map((t) => t[dim] ?? "—"))];
    for (const g of groups.sort((a, b) => (dim === "grade" ? a - b : String(a).localeCompare(String(b), "ru")))) {
      const sub = rows.filter((r) => (r.task[dim] ?? "—") === g);
      const label = dim === "grade" ? `${g} класс` : g;
      console.log(
        `  ${String(label).padEnd(30)} opus ${pct(sub.filter((r) => r[OPUS].match).length, sub.length)}   haiku ${pct(sub.filter((r) => r[HAIKU].match).length, sub.length)}`
      );
    }
  }

  const diverged = rows.filter((r) => r[OPUS].match !== r[HAIKU].match || (!r[OPUS].match && !r[HAIKU].match));
  console.log(`\n--- расхождения и промахи (${diverged.length}) ---`);
  for (const r of diverged) {
    console.log(`  ${r.task.id} (${r.task.grade} кл., ${r.task.topic ?? "без темы"}): ожидалось «${r.task.answer}»`);
    for (const model of MODELS) {
      const x = r[model];
      console.log(`    ${x.match ? "✓" : "✗"} ${model}: «${x.finalAnswer ?? "—"}»${x.match ? "" : ` — ${x.reason}`}`);
    }
  }
  if (!diverged.length) console.log("  нет — обе модели ответили одинаково верно");

  const dump = path.join(path.dirname(tasksFile), "last-run.json");
  fs.writeFileSync(dump, JSON.stringify(rows, null, 2));
  console.log(`\nПолные результаты (с шагами решений и usage): ${dump}`);
}

// Запускаем только как entry point: при импорте (сухие тесты сверки) main не нужен.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("model-compare не удался:", err.message);
    process.exit(1);
  });
}
