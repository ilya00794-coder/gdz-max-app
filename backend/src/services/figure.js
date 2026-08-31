// Валидатор единого поля наглядности figure (№12; слито из visual+drawing
// 31.08.2026 из-за грамматического бюджета structured output — см. backlog).
//
// Принцип группы Б: модель называет ПАРАМЕТРЫ (компактная позиционная форма
// values/labels — семантика в блоке «наглядность» subject-rules.js), рисует
// система детерминированным шаблоном. Этот файл — граница верности:
// противоречивые или вырожденные параметры = отказ от рисунка целиком.
// Отказ честнее кривого рисунка: решение уходит без figure (текстовая
// самодостаточность гарантирована предметными правилами), одна строка в лог.
//
// Наружу отдаётся НОРМАЛИЗОВАННАЯ форма — контракт с шаблонами фронта
// (circlesSvg/numberlineSvg/drawingSvg в webapp/app.js): по именованному
// полю на параметр, без позиционной магии.

const MAX_RATIO = 12; // тоньше — чертёж вырожденно узкий, наглядности ноль
const MAX_LABEL = 30;
const MAX_CIRCLES = 40;
const MAX_POINTS = 4;

/**
 * Числа из подписи: «a = 9 см» → [9]; десятичная запятая понимается;
 * дробь «3/7» даёт и своё значение (0.4285…), и числитель со знаменателем.
 */
function labelNumbers(label) {
  const toNum = (str) => Number(str.replace(",", "."));
  const out = [];
  for (const m of label.matchAll(/(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/g)) {
    const den = toNum(m[2]);
    if (den) out.push(toNum(m[1]) / den);
  }
  for (const m of label.matchAll(/\d+(?:[.,]\d+)?/g)) out.push(toNum(m[0]));
  return out;
}

/** Единица длины из подписи («6 см» → «см»), null, если её нет. */
function labelUnit(label) {
  const m = label.match(/\d\s*(мм|см|дм|км|м)(?=[^а-яё]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Подпись не должна противоречить масштабу: если в ней есть числа, одно из
 * них обязано совпадать со значением — иначе ученик увидит «6 см» на
 * стороне длиной 5.
 */
function labelConsistent(label, value) {
  if (typeof label !== "string" || !label.trim() || label.length > MAX_LABEL) return false;
  const nums = labelNumbers(label);
  return nums.length === 0 || nums.some((n) => Math.abs(n - value) < 1e-9);
}

function positive(n) {
  return Number.isFinite(n) && n > 0;
}

function comment(figure) {
  return typeof figure.comment === "string" ? figure.comment.trim() : "";
}

/**
 * Проверяет параметры figure от solver; возвращает нормализованный объект
 * для фронта либо null (отказ). Никогда не бросает: рисунок не должен
 * уронить решение.
 */
export function validateFigure(figure) {
  if (!figure || typeof figure !== "object") return null;
  const reject = (reason) => {
    console.warn(`[figure] отказ от рисунка: ${reason}`);
    return null;
  };

  try {
    const values = Array.isArray(figure.values) ? figure.values : [];
    const labels = Array.isArray(figure.labels) ? figure.labels : [];

    if (figure.kind === "circles") {
      const [total, crossed = 0, groupSize = 0] = values;
      if (!positive(total) || total > MAX_CIRCLES || !Number.isInteger(total)) {
        return reject(`кружки: всего ${total} — не целое 1..${MAX_CIRCLES}`);
      }
      if (!Number.isInteger(crossed) || crossed < 0 || crossed > total) {
        return reject(`кружки: зачеркнуть ${crossed} при всего ${total}`);
      }
      if (groupSize !== 0 && (!Number.isInteger(groupSize) || groupSize < 2)) {
        return reject(`кружки: размер группы ${groupSize}`);
      }
      return {
        kind: "circles",
        circlesTotal: total,
        circlesCrossed: crossed,
        circlesGroupSize: groupSize || null,
        comment: comment(figure),
      };
    }

    if (figure.kind === "numberline") {
      if (values.length < 1 || values.length > MAX_POINTS) {
        return reject(`луч: ${values.length} точек (нужно 1..${MAX_POINTS})`);
      }
      if (!values.every(Number.isFinite)) return reject("луч: нечисловая координата");
      if (labels.length !== values.length) {
        return reject(`луч: подписей ${labels.length} на ${values.length} точек`);
      }
      const points = values.map((value, i) => {
        const label = String(labels[i] ?? "").trim();
        return { value, label: label || String(value) };
      });
      // Подпись точки, содержащая число, обязана быть этой точкой (допуск
      // на округление дробей вроде 3/7 → 0.4286 — сотая достаточна).
      for (const pnt of points) {
        const nums = labelNumbers(pnt.label);
        if (nums.length && !nums.some((n) => Math.abs(n - Math.abs(pnt.value)) < 0.01)) {
          return reject(`луч: подпись «${pnt.label}» не согласуется с ${pnt.value}`);
        }
      }
      let range = null;
      if (Array.isArray(figure.range) && figure.range.length === 2) {
        const [a, b] = figure.range;
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) range = [a, b];
      }
      return { kind: "numberline", points, range, comment: comment(figure) };
    }

    if (figure.kind === "rectangle") {
      const [width, height] = values;
      const [widthLabel, heightLabel] = labels;
      if (!positive(width) || !positive(height)) return reject("стороны не положительные числа");
      if (Math.max(width, height) / Math.min(width, height) > MAX_RATIO) {
        return reject(`вырожденные пропорции ${width}:${height}`);
      }
      if (!labelConsistent(widthLabel, width)) return reject(`подпись длины «${widthLabel}» не согласуется с ${width}`);
      if (!labelConsistent(heightLabel, height)) return reject(`подпись ширины «${heightLabel}» не согласуется с ${height}`);
      const uw = labelUnit(widthLabel);
      const uh = labelUnit(heightLabel);
      if (uw && uh && uw !== uh) return reject(`разные единицы в подписях: «${widthLabel}» и «${heightLabel}» — масштаб был бы ложным`);
      return {
        kind: "rectangle",
        width,
        height,
        widthLabel: widthLabel.trim(),
        heightLabel: heightLabel.trim(),
        comment: comment(figure),
      };
    }

    if (figure.kind === "square") {
      const [side] = values;
      const [sideLabel] = labels;
      if (!positive(side)) return reject("сторона квадрата не положительное число");
      if (!labelConsistent(sideLabel, side)) return reject(`подпись стороны «${sideLabel}» не согласуется с ${side}`);
      return { kind: "square", side, sideLabel: sideLabel.trim(), comment: comment(figure) };
    }

    return reject(`неизвестный kind «${figure.kind}»`);
  } catch (err) {
    return reject(`ошибка валидации: ${err.message}`);
  }
}

/**
 * Обратная совместимость со старым кэшем: записи до 31.08.2026 хранят
 * visual (сырая форма модели) и/или drawing (уже нормализованный) вместо
 * figure. Старые решения обязаны РЕНДЕРИТЬСЯ, а не прятать карточку.
 */
export function legacyFigure(cached) {
  if (!cached || typeof cached !== "object") return null;
  const d = cached.drawing;
  if (d && (d.kind === "rectangle" || d.kind === "square")) return d;
  const v = cached.visual;
  if (v && v.kind === "circles") {
    return validateFigure({
      kind: "circles",
      values: [v.circlesTotal ?? 0, v.circlesCrossed ?? 0, v.circlesGroupSize ?? 0],
      labels: [],
      comment: v.comment ?? "",
    });
  }
  if (v && v.kind === "numberline") {
    const points = Array.isArray(v.points) ? v.points : [];
    return validateFigure({
      kind: "numberline",
      values: points.map((pnt) => pnt?.value),
      labels: points.map((pnt) => pnt?.label ?? ""),
      range: v.range ?? null,
      comment: v.comment ?? "",
    });
  }
  return null;
}
