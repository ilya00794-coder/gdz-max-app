// Валидатор чертежа (№12, чертежи — часть 1: прямоугольник/квадрат).
//
// Принцип группы Б: модель называет ПАРАМЕТРЫ, чертит система детерминированным
// шаблоном (webapp/app.js, drawingSvg). Этот файл — граница верности:
// противоречивые или вырожденные параметры = отказ от чертежа целиком.
// Отказ честнее кривого чертежа: решение уходит без drawing (текстовая
// самодостаточность гарантирована предметным блоком геометрии), одна строка
// в лог. Чертёж — усиление, не условие, как график.

const MAX_RATIO = 12; // тоньше — чертёж вырожденно узкий, наглядности ноль
const MAX_LABEL = 30;

/** Числа из подписи: «a = 9 см» → [9]; десятичная запятая понимается. */
function labelNumbers(label) {
  return (label.match(/\d+(?:[.,]\d+)?/g) ?? []).map((s) => Number(s.replace(",", ".")));
}

/** Единица длины из подписи («6 см» → «см»), null, если её нет. */
function labelUnit(label) {
  const m = label.match(/\d\s*(мм|см|дм|км|м)(?=[^а-яё]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Подпись не должна противоречить масштабу: если в ней есть числа, одно из
 * них обязано совпадать со значением стороны — иначе ученик увидит «6 см»
 * на стороне длиной 5.
 */
function labelConsistent(label, value) {
  if (typeof label !== "string" || !label.trim() || label.length > MAX_LABEL) return false;
  const nums = labelNumbers(label);
  return nums.length === 0 || nums.some((n) => Math.abs(n - value) < 1e-9);
}

function positive(n) {
  return Number.isFinite(n) && n > 0;
}

/**
 * Проверяет параметры чертежа от solver; возвращает нормализованный объект
 * для фронта либо null (отказ). Никогда не бросает: чертёж не должен
 * уронить решение.
 */
export function validateDrawing(drawing) {
  if (!drawing || typeof drawing !== "object") return null;
  const reject = (reason) => {
    console.warn(`[drawing] отказ от чертежа: ${reason}`);
    return null;
  };

  try {
    if (drawing.kind === "rectangle") {
      const { width, height, widthLabel, heightLabel } = drawing;
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
        comment: typeof drawing.comment === "string" ? drawing.comment.trim() : "",
      };
    }

    // Схема solver сжата (грамматика structured output у предела): квадрат
    // приходит как width/widthLabel при height null — здесь нормализуем
    // в side/sideLabel, которые ждёт шаблон фронта.
    if (drawing.kind === "square") {
      const side = drawing.width;
      const sideLabel = drawing.widthLabel;
      if (!positive(side)) return reject("сторона квадрата не положительное число");
      if (!labelConsistent(sideLabel, side)) return reject(`подпись стороны «${sideLabel}» не согласуется с ${side}`);
      return {
        kind: "square",
        side,
        sideLabel: sideLabel.trim(),
        comment: typeof drawing.comment === "string" ? drawing.comment.trim() : "",
      };
    }

    return reject(`неизвестный kind «${drawing.kind}»`);
  } catch (err) {
    return reject(`ошибка валидации: ${err.message}`);
  }
}
