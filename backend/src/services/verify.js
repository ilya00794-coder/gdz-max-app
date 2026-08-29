// Верификация финального ответа через SymPy (символьно, детерминированно, бесплатно).
//
// Проверяется ТОЛЬКО финальный ответ (число/множество корней) — он не защищён авторским
// правом, в отличие от текста объяснения. Никаких внешних решебников здесь нет:
// эталон вычисляется из формализованной записи задачи, которую вернул наш же solver.
//
// Безопасность: formalExpression генерирует LLM, поэтому строка не выполняется как есть.
// Node проверяет её по белому списку символов и имён, затем Python разбирает выражение
// в AST и пропускает только математические узлы (см. verify_sympy.py), вычисление идёт
// в отдельном процессе с таймаутом и без builtins.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, "verify_sympy.py");

const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 5000);

/** Предметы, где ответ можно проверить символьно. */
const COMPUTABLE_SUBJECTS = ["математика", "алгебра", "геометрия", "физика", "химия"];

/** Функции, разрешённые в formalExpression. Должны совпадать с белым списком в verify_sympy.py. */
const ALLOWED_NAMES = new Set([
  "solve", "solveset", "Eq", "sqrt", "cbrt", "root", "Abs", "exp", "log", "ln",
  "sin", "cos", "tan", "cot", "asin", "acos", "atan", "factorial", "binomial",
  "Rational", "simplify", "expand", "factor", "diff", "integrate", "limit",
  "pi", "E", "oo", "I",
]);

/** Только математические символы: буквы, цифры, операторы, скобки, запятая, точка. */
const SAFE_CHARS = /^[A-Za-z0-9_+\-*/(),.\s=]+$/;

/**
 * Приводит строку к машинному виду: юникод-минусы, неразрывные пробелы, десятичная запятая.
 * Ответ приходит от LLM в человеческом формате, где «−» — это U+2212, а не дефис.
 */
export function normalizeMathText(text) {
  return String(text ?? "")
    .replace(/[−–—‐‑]/g, "-") // −, –, —, ‐, ‑ → -
    .replace(/[   ]/g, " ") // неразрывные пробелы
    .replace(/[·×]/g, "*")
    .replace(/(\d),(\d)/g, "$1.$2"); // десятичная запятая: 4,5 → 4.5
}

/**
 * Модель иногда пишет уравнение как "solve(2*x + 8 = 20, x)" — с одиночным "=",
 * что для Python синтаксическая ошибка. Чиним: одиночное "=" превращаем в "==",
 * а Python-сторона разберёт сравнение в Eq(). Двойные и составные операторы не трогаем.
 */
function repairEquals(expression) {
  return expression.replace(/(?<![=!<>])=(?!=)/g, "==");
}

/** Проверяет, что строка состоит только из разрешённых символов и известных имён. */
export function isExpressionSafe(expression) {
  if (!expression || expression.length > 2000) return false;
  if (!SAFE_CHARS.test(expression)) return false;
  if (expression.includes("__")) return false;

  const names = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return names.every((name) => ALLOWED_NAMES.has(name) || (name.length <= 3 && /^[a-zA-Z][a-zA-Z0-9]*$/.test(name)));
}

/** Ответы, означающие пустое множество решений. */
const NO_ROOTS = /(корн|решени)[а-яё]*\s+нет|нет\s+(корн|решени)[а-яё]*|решени[а-яё]*\s+не\s+существует/i;

/**
 * Вытаскивает из человеческого ответа список значений.
 * "x = 1; x = −5" → ["1", "-5"];  "x₁ = 2, x₂ = 3" → ["2", "3"];  "корней нет" → [].
 *
 * @returns {string[]|null} null — если разобрать не удалось
 */
export function parseCandidateAnswer(candidateAnswer) {
  const text = normalizeMathText(candidateAnswer).trim();
  if (!text) return null;
  if (NO_ROOTS.test(text)) return [];

  const parts = text
    .split(/;|,|\bили\b|\bи\b/gi)
    .map((part) => {
      // Отбрасываем всё до последнего «=»: "x_1 = 5" → "5".
      const afterEquals = part.includes("=") ? part.slice(part.lastIndexOf("=") + 1) : part;
      // Убираем кириллицу (единицы измерения, слова) и индексы вида ₁.
      return afterEquals.replace(/[Ѐ-ӿ₀-₉]+/g, "").trim();
    })
    .filter(Boolean);

  if (!parts.length) return null;
  return parts;
}

/**
 * Запускает verify_sympy.py отдельным процессом, передаёт задание в stdin.
 * Таймаут считаем сами: процесс убивается SIGKILL, чтобы зависший SymPy не держал запрос.
 */
export function runPython(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.on("error", () => {}); // процесс мог умереть раньше, чем мы дописали вход
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Сверяет ответ решателя с символьным решением задачи.
 *
 * @param {object} params
 * @param {string} params.subject - предмет
 * @param {string|null} params.expression - формализованная запись задачи (formalExpression)
 * @param {string|number} params.candidateAnswer - финальный ответ, предложенный решателем
 * @returns {Promise<{verified: boolean, confidence: number, method: string, details?: object}>}
 */
export async function verifyAnswer({ subject, expression, candidateAnswer }) {
  const normalizedSubject = String(subject || "").trim().toLowerCase();

  if (!COMPUTABLE_SUBJECTS.includes(normalizedSubject)) {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: "предмет не проверяется символьно" } };
  }
  if (!expression) {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: "нет формализованной записи задачи" } };
  }

  const normalizedExpression = repairEquals(normalizeMathText(expression).trim());
  if (!isExpressionSafe(normalizedExpression)) {
    return {
      verified: false,
      confidence: 0,
      method: "unsupported",
      details: { reason: "формализованная запись не прошла проверку белого списка" },
    };
  }

  const candidates = parseCandidateAnswer(candidateAnswer);
  if (candidates === null) {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: "не удалось разобрать ответ" } };
  }
  if (!candidates.every((c) => isExpressionSafe(c))) {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: "ответ содержит недопустимые символы" } };
  }

  let run;
  try {
    run = await runPython({ expression: normalizedExpression, candidates });
  } catch (err) {
    return { verified: false, confidence: 0, method: "sympy_unavailable", details: { reason: `не удалось запустить ${PYTHON_BIN}: ${err.message}` } };
  }

  if (run.timedOut) {
    return { verified: false, confidence: 0, method: "timeout", details: { reason: `SymPy не уложился в ${TIMEOUT_MS} мс` } };
  }
  if (run.code !== 0) {
    const reason = /ModuleNotFoundError|No module named/.test(run.stderr)
      ? "не установлен sympy: pip3 install -r requirements.txt --user"
      : `SymPy завершился с кодом ${run.code}: ${run.stderr.slice(0, 300)}`;
    return { verified: false, confidence: 0, method: "sympy_unavailable", details: { reason } };
  }
  const stdout = run.stdout;

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: "SymPy вернул нечитаемый ответ" } };
  }

  if (!report.ok) {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: report.reason } };
  }

  return {
    verified: report.verified === true,
    // Символьная сверка детерминирована: либо множества совпали, либо нет.
    confidence: report.verified === true ? 1 : 0,
    method: "sympy",
    details: {
      solutions: report.solutions,
      realSolutions: report.realSolutions,
      candidates: report.candidates,
      missing: report.missing,
      extra: report.extra,
    },
  };
}
