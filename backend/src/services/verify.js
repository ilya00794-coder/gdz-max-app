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

/**
 * Приводит строку к машинному виду: юникод-минусы, неразрывные пробелы, десятичная запятая.
 * Ответ приходит от LLM в человеческом формате, где «−» — это U+2212, а не дефис.
 */
export function normalizeMathText(text) {
  return String(text ?? "")
    .replace(/[−–—‐‑]/g, "-") // −, –, —, ‐, ‑ → -
    .replace(/[   ]/g, " ") // неразрывные пробелы
    .replace(/[·×]/g, "*")
    // Запятая внутри Rational(a,b) — разделитель аргументов, НЕ десятичная:
    // без защиты Rational(60,100) превращался в Rational(60.100) и ломал
    // верификацию монструозной дробью (пойман живой канарейкой answerValues).
    .replace(/Rational\((\s*\d+\s*),(\s*\d+\s*)\)/g, "Rational($1@COMMA@$2)")
    .replace(/(\d),(\d)/g, "$1.$2") // десятичная запятая: 4,5 → 4.5
    .replace(/@COMMA@/g, ",");
}

/**
 * Модель иногда пишет уравнение как "solve(2*x + 8 = 20, x)" — с одиночным "=",
 * что для Python синтаксическая ошибка. Чиним: одиночное "=" превращаем в "==",
 * а Python-сторона разберёт сравнение в Eq(). Двойные и составные операторы не трогаем.
 */
function repairEquals(expression) {
  return expression.replace(/(?<![=!<>])=(?!=)/g, "==");
}

/**
 * НЕГАТИВНЫЙ предохранитель, а не описание допустимых выражений.
 *
 * Единственный судья допустимого — белый список AST-узлов и вызовов в
 * verify_sympy.py, и он ВСЕГДА выполняется после этого фильтра (проверено
 * по всем пяти местам вызова: formalExpression, candidates, инвариант any,
 * misread, graph). Здесь режется только категорический мусор. Дублировать
 * позитивные правила (операторы, имена, длину) тут НЕЛЬЗЯ: это трижды
 * давало ложный unsupported — лимит длины имени, скобки систем, знак %.
 */
const FORBIDDEN_CHARS = /["'`;\\{}@#$?!:&|^~<>]/;
const NON_ASCII = /[^\x20-\x7E\n\t]/;

export function isExpressionSafe(expression) {
  if (!expression || expression.length > 2000) return false;
  if (expression.includes("__")) return false;
  // Формализации латинские; кириллица ученических ответов вырезается раньше
  // (parseCandidateAnswer), сюда не доходит.
  if (NON_ASCII.test(expression)) return false;
  if (FORBIDDEN_CHARS.test(expression)) return false;
  return true;
}

/** Грамматика числового литерала ученического ответа: целое | десятичное | дробь a/b. */
const STUDENT_LITERAL = /^[+-]?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?$/;

/** Ответы, означающие пустое множество решений. */
// Допускаем 1–2 вставных слова («действительных», «у уравнения») между отрицанием
// и «корней/решений»: модели пишут «не имеет действительных корней» и т. п.
const NO_ROOTS =
  /(корн|решени)[а-яё]*\s+нет|нет\s+(?:[а-яё]+\s+){0,2}(корн|решени)|решени[а-яё]*\s+не\s+существует|не\s+имеет\s+(?:[а-яё]+\s+){0,2}(корн|решени)/i;

/**
 * Вытаскивает из человеческого ответа список значений.
 * "x = 1; x = −5" → ["1", "-5"];  "x₁ = 2, x₂ = 3" → ["2", "3"];  "корней нет" → [].
 *
 * @returns {string[]|null} null — если разобрать не удалось
 */
export function parseCandidateAnswer(candidateAnswer) {
  // «Ответ: 26» — слово убираем ДО вырезания кириллицы, иначе остаётся «: 26».
  // \frac{a}{b} от vision → « a/b»: смешанные дроби приходят и как «8 17/51»
  // (почерк), и как «8\frac{17}{51}» (LaTeX-настроение vision) — читаем обе.
  const text = normalizeMathText(candidateAnswer)
    .trim()
    .replace(/^ответ\s*[:.]?\s*/i, "")
    .replace(/\\frac\{(\d+)\}\{(\d+)\}/g, " $1/$2");
  if (!text) return null;
  if (NO_ROOTS.test(text)) return [];

  const parts = text
    // Не \bили\b: JS-\b не считает кириллицу словесной, граница не срабатывает,
    // и «x = 0 или x = 7» парсился как одно значение. Пробелы вокруг — та же роль.
    .split(/;|,|\s+или\s+|\s+и\s+/gi)
    .map((part) => {
      // Отбрасываем всё до последнего «=»: "x_1 = 5" → "5".
      const afterEquals = part.includes("=") ? part.slice(part.lastIndexOf("=") + 1) : part;
      // Процентный суффикс распознаём ДО вырезания кириллицы: иначе слово
      // «процентов» уничтожается раньше, чем прочитан его смысл /100, и
      // «60 процентов» тихо превращалось в 60 (ложное verified с эталоном 60).
      const percent = afterEquals.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*(?:%|процент[а-яё]*)\s*\.?\s*$/i);
      if (percent) return `${percent[1]}/100`;
      // Убираем кириллицу (единицы измерения, слова) и индексы вида ₁.
      const cleaned = afterEquals
        .replace(/[Ѐ-ӿ₀-₉]+/g, "")
        .trim()
        // Хвост единиц и оформления: «26.» и «26 руб.» → 26; «115°», «81 см²»
        // (после вырезания «см») → 115 и 81. Точку срезаем только В КОНЦЕ,
        // десятичные «26.5» не задеваются.
        .replace(/[°²³\s.]+$/, "")
        .trim();
      // Смешанная дробь «8 1/6» → правильная «49/6»: считаем в JS точно,
      // чтобы кандидат остался числовым литералом для строгой грамматики.
      const mixed = cleaned.match(/^([+-]?)(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
      if (mixed && Number(mixed[4]) !== 0) {
        const sign = mixed[1] === "-" ? "-" : "";
        return `${sign}${BigInt(mixed[2]) * BigInt(mixed[4]) + BigInt(mixed[3])}/${mixed[4]}`;
      }
      return cleaned;
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
/**
 * Все числа выражения — в sympy.Rational: python-eval считает 0.6 и 3/5
 * флоатами до SymPy, и сравнение Float/Integer капризничает (0.0 против 0
 * даёт разный результат в зависимости от направления). Единый экземпляр
 * для verify и misread — копии этой функции уже дважды ловили баги.
 */
export function numbersToRationals(expr) {
  return expr.replace(/\d+\.\d+|\d+/g, (m) => {
    const dot = m.indexOf(".");
    if (dot === -1) return `Rational(${m.replace(/^0+(?=\d)/, "")})`;
    const frac = m.length - dot - 1;
    const digits = m.replace(".", "").replace(/^0+(?=\d)/, "");
    return `Rational(${digits},1${"0".repeat(frac)})`;
  });
}

/**
 * Инвариант kind:"any": все формы равны между собой и единицы однородны
 * (все отсутствуют либо все одинаковы). Нарушение — дефект solver'а,
 * логируется громко; сверка деградирует к первой форме.
 * @returns {Promise<string|null>} описание нарушения либо null
 */
async function checkAnyInvariant(values) {
  const units = new Set(values.map((v) => v.unit ?? null));
  if (units.size > 1) {
    return `разные единицы в any: ${[...units].join(", ")} — запрещено (пересчёт между единицами мог быть неверным)`;
  }
  for (let i = 1; i < values.length; i++) {
    const expr = `simplify((${numbersToRationals(values[0].value)}) - (${numbersToRationals(values[i].value)}))`;
    if (!isExpressionSafe(expr)) return `форма не прошла белый список: ${values[i].value}`;
    try {
      const run = await runPython({ expression: expr, candidates: ["0"] });
      const report = JSON.parse(run.stdout);
      if (!report.ok || !report.verified) return `формы не равны: ${values[0].value} ≠ ${values[i].value}`;
    } catch {
      return `не удалось проверить равенство форм: ${values[i].value}`;
    }
  }
  return null;
}

export async function verifyAnswer({ subject, expression, candidateAnswer, answerValues }) {
  const normalizedSubject = String(subject || "").trim().toLowerCase();
  let invariantViolation = null; // уходит в details для телеметрии (п.8)

  if (!COMPUTABLE_SUBJECTS.includes(normalizedSubject)) {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: "предмет не проверяется символьно" } };
  }

  // Машинная форма ответа от solver'а (если есть) — приоритетнее парсинга строки.
  if (answerValues?.kind === "expression") {
    return {
      verified: false, confidence: 0, method: "unsupported",
      details: { reason: "ответ-выражение (серия, интервал, именованные части) — символьная сверка не применима" },
    };
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

  let candidates;
  if (answerValues && Array.isArray(answerValues.values)) {
    // Путь по машинной форме: значения уже в SymPy-записи, единицы — метаданные.
    if (answerValues.kind === "any" && answerValues.values.length > 1) {
      invariantViolation = await checkAnyInvariant(answerValues.values);
      if (invariantViolation) {
        console.error("[answerValues] НАРУШЕНИЕ ИНВАРИАНТА any — дефект solver'а:", {
          violation: invariantViolation,
          values: answerValues.values,
          candidateAnswer,
        });
      }
    }
    if (answerValues.kind === "all" && answerValues.values.length === 0 && !NO_ROOTS.test(normalizeMathText(candidateAnswer ?? ""))) {
      // Пустой список значений — это утверждение «решений нет»; если текст ответа
      // на него не похож, скорее всего модель потеряла значения. Сверка ниже
      // пропустит такое verified только против настоящего solve без корней.
      console.warn("[answerValues] пустой values при непохожем на «корней нет» ответе:", { candidateAnswer });
    }
    candidates =
      answerValues.kind === "any" && answerValues.values.length
        ? [answerValues.values[0].value] // any: формы равны, сверяем первую
        : answerValues.values.map((v) => v.value); // all: полный набор (пустой = «корней нет»)
  } else {
    candidates = parseCandidateAnswer(candidateAnswer);
    // Ответ ученика — ЧИСЛО, а не выражение. Всё, что не проходит строгую
    // грамматику числового литерала (целое | десятичное | дробь a/b),
    // в вычислитель НЕ идёт вовсе: питон трактовал бы символы как операторы
    // (% — modulo, скобка-приписка — группировка, · — умножение), и
    // «60 % (0,6)» тихо вычислялся в 0. Неоднозначность → unsupported,
    // ложное verified недопустимо. Машинные answerValues идут другой веткой
    // и грамматикой не ограничены (им законны sqrt(2), 2*pi).
    if (candidates !== null && !candidates.every((c) => STUDENT_LITERAL.test(c))) {
      return {
        verified: false, confidence: 0, method: "unsupported",
        details: { reason: "ответ не разобран как число — сверка не применима", code: "not_literal", candidates },
      };
    }
  }
  if (candidates === null) {
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: "не удалось разобрать ответ", code: "unparsed" } };
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
    if (/не независима/.test(report.reason ?? "")) {
      // Модель подставила готовый ответ вместо формализации из условия.
      console.error("[verify] ФОРМАЛИЗАЦИЯ-ЛИТЕРАЛ — дефект solver'а:", { expression, candidateAnswer });
    }
    if (/ЛОЖНОЕ числовое утверждение/.test(report.reason ?? "")) {
      // Модель формализовала неверное равенство — дефект solver'а, видим отдельно.
      console.error("[verify] ЛОЖНАЯ ФОРМАЛИЗАЦИЯ — дефект solver'а:", { expression, candidateAnswer });
    }
    return { verified: false, confidence: 0, method: "unsupported", details: { reason: report.reason } };
  }

  return {
    verified: report.verified === true,
    // Символьная сверка детерминирована: либо множества совпали, либо нет.
    confidence: report.verified === true ? 1 : 0,
    method: "sympy",
    details: {
      invariantViolation,
      solutions: report.solutions,
      realSolutions: report.realSolutions,
      candidates: report.candidates,
      missing: report.missing,
      extra: report.extra,
    },
  };
}

/**
 * Считает данные графика для solve-пути: по одному вызову verify_sympy
 * (mode=plot) на каждую функцию из graph.expressions.
 *
 * График — усиление, а не условие: ЛЮБОЙ сбой (небезопасное выражение,
 * таймаут, code != 0, ok:false) означает «решение уходит без графика» —
 * возвращаем null, пишем одну строку в лог, наружу ничего не бросаем.
 *
 * @param {{expressions: string[], xRange: [number, number]}|null} graph
 * @returns {Promise<object[]|null>} plots или null
 */
export async function computeGraphPlots(graph) {
  if (!graph?.expressions?.length) return null;
  const plots = [];
  for (const expression of graph.expressions) {
    try {
      if (!isExpressionSafe(expression)) {
        console.warn(`[graph] выражение не прошло проверку безопасности: ${expression.slice(0, 80)}`);
        return null;
      }
      const run = await runPython({ mode: "plot", expression, xRange: graph.xRange });
      if (run.timedOut || run.code !== 0) {
        console.warn(`[graph] расчёт не удался (${run.timedOut ? "таймаут" : "код " + run.code}): ${expression.slice(0, 80)}`);
        return null;
      }
      const report = JSON.parse(run.stdout);
      if (!report.ok) {
        console.warn(`[graph] расчёт отвергнут: ${report.reason} — ${expression.slice(0, 80)}`);
        return null;
      }
      plots.push(report);
    } catch (err) {
      console.warn(`[graph] расчёт упал: ${err.message} — ${expression.slice(0, 80)}`);
      return null;
    }
  }
  return plots;
}
