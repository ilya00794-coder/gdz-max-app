// Обнаружение ВОЗМОЖНОЙ ошибки распознавания через внутреннюю согласованность
// выкладок. Мотивация: confidence как сигнал ненадёжности цифр не работает
// (ma-02: 0.78 при восьми цифровых ошибках), а несходящаяся арифметика — работает.
//
// ЖЁСТКИЕ ПРАВИЛА:
// - числа НИКОГДА не исправляются: несогласованность может быть настоящей ошибкой
//   ученика, и «починив» её, мы спрятали бы то, что обязан найти разбор;
// - вердикт compare от результата не зависит; в ответ пользователю ничего не идёт;
// - флаг MISREAD_DETECTION (off по умолчанию) только включает запись в лог.
//
// ГРАНИЦЫ ПО ПОСТРОЕНИЮ: проверяются только полностью ЧИСЛОВЫЕ цепочки равенств
// (25-24=1, 4·120=480, a=b=c по соседним парам). Части с переменными, неравенства
// и текст пропускаются молча.
//
// ВТОРАЯ СЛЕПАЯ ЗОНА, вскрытая канарейкой на ma-02: детектор ловит misread,
// только когда тот ЛОМАЕТ соотношение. Систематическая подмена, прошедшая
// через все вхождения, невидима:
//   прочитано  1,58·(45,2+17,3+57,5) = 1,58·100 = 158  → флаг: сумма 120 ≠ 100
//   а если бы 3→5 случилось только в «1,38»:
//              1,58·(45,2+17,3+37,5) = 1,58·100 = 158  → сходится, флага НЕТ
// Исходный случай «1,38 пять раз прочитано как 1,58» сам по себе не ловится —
// поймали его лишь потому, что vision сделал ВТОРУЮ ошибку (37,5 → 57,5).

import { normalizeMathText, isExpressionSafe, runPython } from "./verify.js";

const ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.MISREAD_DETECTION || "").toLowerCase()
);

if (ENABLED) {
  console.log("[misread] детектор включён: лог-only, ответ пользователю и вердикт не меняются");
}

/** LaTeX-запись vision → арифметика, понятная SymPy-скрипту. */
function latexToArithmetic(text) {
  return (
    normalizeMathText(text)
      .replace(/\$/g, "")
      .replace(/\\left|\\right|\;|\\,|\\!/g, "")
      .replace(/\\cdot|\\times/g, "*")
      .replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))")
      .replace(/\^/g, "**")
      // Продолжение цепочки на следующей строке: «... =\n= ...» — одна цепочка.
      .replace(/=[ \t]*\n[ \t]*=/g, " = ")
      // Нумераторы пунктов в начале строки: «1)», «а)» — не арифметика.
      .replace(/(^|\n)[ \t]*(?:\d{1,2}|[а-яёa-z])\)[ \t]*/gi, "$1")
      // Единицы и ремарки в скобках: «(кг)», «(в столбик справа:)» — выбрасываем.
      .replace(/\([^()]*[а-яёa-z][^()]*\)/gi, " ")
      .replace(/(\d)[ \t]*:[ \t]*(?=\d)/g, "$1/") // школьное деление 160:40
      // Неявное умножение — только внутри строки, \n не съедать.
      .replace(/(\d)[ \t]*\(/g, "$1*(")
      .replace(/\)[ \t]*(?=\d)/g, ")*")
  );
}

const NUMERIC_PART = /^[0-9+\-*/(). ]+$/;

/**
 * Все числа — в sympy.Rational. Скобочная дробь (372/10) не спасает: её
 * вычисляет python-eval ещё ДО SymPy, во float, и 37.2·60−2232 даёт 10⁻¹³
 * вместо нуля, а сравнение Float/Integer капризничает. Rational() из белого
 * списка даёт точную арифметику целиком на стороне SymPy.
 */
function numbersToRationals(expr) {
  return expr.replace(/\d+\.\d+|\d+/g, (m) => {
    const dot = m.indexOf(".");
    if (dot === -1) return `Rational(${m})`;
    const frac = m.length - dot - 1;
    return `Rational(${m.replace(".", "")},1${"0".repeat(frac)})`;
  });
}

/** Разбивает текст на цепочки равенств и отбирает проверяемые числовые пары. */
export function extractNumericPairs(recognizedText) {
  const flat = latexToArithmetic(recognizedText);

  const pairs = [];
  for (const line of flat.split("\n")) {
    if (!line.includes("=")) continue;
    // Двухколоночная запись «16+43=59   73-22=51» — ДВЕ цепочки,
    // разделитель — два и более пробелов.
    for (const segment of line.split(/[ \t]{2,}/)) {
      if (!segment.includes("=")) continue;
      const parts = segment.split("=").map((x) => x.trim().replace(/[.,;]$/, ""));
      for (let i = 0; i + 1 < parts.length; i++) {
        const a = parts[i], b = parts[i + 1];
        if (!a || !b) continue;
        if (!NUMERIC_PART.test(a) || !NUMERIC_PART.test(b)) continue; // переменные/текст — мимо
        if (!/\d/.test(a) || !/\d/.test(b)) continue;
        pairs.push({ line: segment.trim(), a: numbersToRationals(a), b: numbersToRationals(b), shown: { a, b } });
      }
    }
  }
  return pairs;
}

/**
 * Проверяет пары через существующий verify_sympy.py: simplify((a)-(b)) должно
 * дать 0. Ошибка вычисления (деление на ноль, кривой хвост) — «непроверяемо»,
 * а не находка.
 *
 * @returns {Promise<{checked: number, findings: {line: string, a: string, b: string}[]}>}
 */
export async function checkArithmetic(recognizedText) {
  const pairs = extractNumericPairs(recognizedText);
  const findings = [];
  let checked = 0;

  for (const pair of pairs) {
    const expr = `simplify((${pair.a})-(${pair.b}))`;
    if (!isExpressionSafe(expr)) continue;
    let run;
    try {
      run = await runPython({ expression: expr, candidates: ["0"] });
    } catch {
      continue;
    }
    if (run.timedOut || run.code !== 0) continue;
    let report;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      continue;
    }
    if (!report.ok) continue; // непроверяемо — молчим
    checked++;
    if (!report.verified) findings.push(pair);
  }
  return { checked, findings };
}

/**
 * Fire-and-forget: вызывается из роута без await, пользователь не ждёт.
 * При выключенном флаге не делает ничего.
 */
export function detectMisread(recognizedText, meta = {}) {
  if (!ENABLED) return;
  checkArithmetic(recognizedText)
    .then(({ checked, findings }) => {
      console.log("[misread]", { ...meta, проверено_пар: checked, несоответствий: findings.length });
      for (const f of findings) {
        console.warn("[misread] possibly_misread", {
          ...meta,
          строка: f.line,
          не_сходится: `«${f.shown?.a ?? f.a}» ≠ «${f.shown?.b ?? f.b}»`,
        });
      }
    })
    .catch((err) => console.error("[misread] сбой проверки:", err.message));
}
