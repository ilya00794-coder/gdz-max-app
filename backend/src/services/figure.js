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
// Углы: тоньше 8° дуга и подпись сливаются — отказ честнее нечитаемого чертежа.
const MIN_ANGLE = 8;
// Представительный угол для задач без чисел (доказательства): заведомо
// НЕспециальный — не 90° (перпендикуляр) и не 45/60 (красивые кратные),
// чтобы ученик не увидел на чертеже свойств, которых нет в условии.
const DEFAULT_ANGLE = 62;
const PAIR_KINDS = { "накрест лежащие": "alternate", "соответственные": "corresponding", "односторонние": "co-interior" };
// Представительные углы треугольника для задач без чисел: заведомо
// разносторонний и заведомо не прямоугольный (разности углов ≥10°, до 90°
// далеко) — и равнобедренный, заведомо не равносторонний (65/50/65, не 60).
const DEFAULT_TRI = [46, 72, 62];
const DEFAULT_ISO_BASE = 65;
const ELEMENT_KINDS = { "медиана": "median", "высота": "height", "биссектриса": "bisector" };

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

    if (figure.kind === "adjacent-angles") {
      let [right, left] = values;
      if (values.length === 0) { right = DEFAULT_ANGLE; left = 180 - DEFAULT_ANGLE; }
      if (!positive(right) || !positive(left)) return reject("смежные: углы не положительные");
      if (Math.abs(right + left - 180) > 0.01) return reject(`смежные: сумма ${right} + ${left} ≠ 180 — противоречие`);
      if (Math.min(right, left) < MIN_ANGLE) return reject(`смежные: угол ${Math.min(right, left)}° нечитаемо мал`);
      let letters = null;
      if (labels.length === 4 && labels.every((l) => typeof l === "string" && l.trim() && l.trim().length <= 4)) {
        letters = labels.map((l) => l.trim());
        if (new Set(letters).size !== 4) letters = null; // повторы букв — рисуем без букв
      }
      return { kind: "adjacent-angles", right, left, letters, comment: comment(figure) };
    }

    if (figure.kind === "vertical-angles") {
      const angle = values.length === 0 ? DEFAULT_ANGLE : values[0];
      if (!positive(angle) || angle >= 180) return reject(`вертикальные: угол ${angle}°`);
      if (Math.min(angle, 180 - angle) < MIN_ANGLE) return reject(`вертикальные: угол ${angle}° нечитаемо близок к прямой`);
      let names = ["∠1", "∠2", "∠3", "∠4"];
      if (labels.length === 4 && labels.every((l) => typeof l === "string" && l.trim() && l.trim().length <= 6)) {
        names = labels.map((l) => l.trim());
      }
      return { kind: "vertical-angles", angle, names, comment: comment(figure) };
    }

    if (figure.kind === "parallel-lines") {
      const angle = values.length === 0 ? DEFAULT_ANGLE : values[0];
      if (!positive(angle) || angle >= 180) return reject(`параллельные: угол ${angle}°`);
      if (Math.min(angle, 180 - angle) < MIN_ANGLE) return reject(`параллельные: секущая под ${angle}° нечитаемо близка к прямым`);
      const markList = Array.isArray(figure.marks) ? figure.marks.filter((m) => typeof m === "string" && m.trim()) : [];
      let pair = null;
      if (markList.length === 1) {
        pair = PAIR_KINDS[markList[0].trim().toLowerCase()] ?? undefined;
        if (pair === undefined) return reject(`параллельные: неизвестная пара углов «${markList[0]}»`);
      } else if (markList.length > 1) {
        return reject(`параллельные: ${markList.length} отметок пар вместо одной`);
      }
      let names = ["a", "b", "c"];
      if (labels.length === 3 && labels.every((l) => typeof l === "string" && l.trim() && l.trim().length <= 4)) {
        names = labels.map((l) => l.trim());
      }
      return { kind: "parallel-lines", angle, pair, names, comment: comment(figure) };
    }

    if (figure.kind === "triangle") {
      const markList = (Array.isArray(figure.marks) ? figure.marks : [])
        .filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
      let vertices = ["A", "B", "C"];
      if (labels.length >= 3 && labels.slice(0, 3).every((l) => typeof l === "string" && l.trim() && l.trim().length <= 2)) {
        vertices = labels.slice(0, 3).map((l) => l.trim());
        if (new Set(vertices).size !== 3) return reject("треугольник: буквы вершин повторяются");
      }
      const sideNames = [vertices[0] + vertices[1], vertices[1] + vertices[2], vertices[2] + vertices[0]]; // [AB, BC, CA]
      const sideIndex = (name) => {
        const canon = name.toUpperCase();
        return sideNames.findIndex((sn) => sn.toUpperCase() === canon || (sn[1] + sn[0]).toUpperCase() === canon);
      };

      // Разбор marks: тип values, равные стороны, элементы.
      let valuesKind = null; // "углы" | "стороны"
      const equalSides = [];
      const elements = [];
      for (const m of markList) {
        const low = m.toLowerCase();
        if (low === "углы" || low === "стороны") {
          if (valuesKind) return reject("треугольник: тип values указан дважды");
          valuesKind = low;
          continue;
        }
        const eq = low.match(/^равные стороны\s+([а-яa-z]{2})\s+([а-яa-z]{2})$/i);
        if (eq) {
          const i1 = sideIndex(eq[1]), i2 = sideIndex(eq[2]);
          if (i1 < 0 || i2 < 0 || i1 === i2) return reject(`треугольник: непонятные равные стороны «${m}»`);
          equalSides.push([i1, i2]);
          continue;
        }
        const el = low.match(/^(медиана|высота|биссектриса)\s+([а-яa-z])$/i);
        if (el) {
          const from = vertices.findIndex((v) => v.toUpperCase() === el[2].toUpperCase());
          if (from < 0) return reject(`треугольник: элемент из неизвестной вершины «${m}»`);
          elements.push({ type: ELEMENT_KINDS[el[1]], from });
          continue;
        }
        return reject(`треугольник: непонятная отметка «${m}»`);
      }
      if (elements.length > 2) return reject(`треугольник: ${elements.length} элементов (максимум 2)`);
      if (equalSides.length > 1) return reject("треугольник: больше одной пары равных сторон (равносторонний не рисуем)");

      // Буквы оснований элементов — labels после вершин; дефолт D, E.
      const defaultFeet = ["D", "E"];
      elements.forEach((el, i) => {
        const raw = labels[3 + i];
        const foot = typeof raw === "string" && raw.trim() && raw.trim().length <= 2 ? raw.trim() : defaultFeet[i];
        el.foot = vertices.some((v) => v.toUpperCase() === foot.toUpperCase()) ? defaultFeet[i] : foot;
      });

      let angles = null, sides = null;
      if (values.length === 3) {
        if (!valuesKind) return reject("треугольник: values даны, но marks не говорит «углы» или «стороны»");
        if (!values.every(positive)) return reject("треугольник: значения не положительные");
        if (valuesKind === "углы") {
          if (Math.abs(values[0] + values[1] + values[2] - 180) > 0.5) {
            return reject(`треугольник: сумма углов ${values[0]}+${values[1]}+${values[2]} ≠ 180 — противоречие`);
          }
          if (Math.min(...values) < MIN_ANGLE) return reject(`треугольник: угол ${Math.min(...values)}° нечитаемо мал`);
          angles = values;
        } else {
          const [ab, bc, ca] = values;
          if (ab + bc <= ca || bc + ca <= ab || ca + ab <= bc) {
            return reject(`треугольник: стороны ${values.join("/")} нарушают неравенство треугольника`);
          }
          if (Math.max(...values) / Math.min(...values) > MAX_RATIO) {
            return reject(`треугольник: вырожденные пропорции сторон ${values.join("/")}`);
          }
          sides = values;
        }
      } else if (values.length !== 0) {
        return reject(`треугольник: ${values.length} значений (нужно 0 или 3)`);
      } else if (equalSides.length === 1) {
        // Представительный равнобедренный: равные углы против равных сторон.
        // Сторона i лежит против вершины (i+2)%3; равные стороны i1,i2 →
        // равные углы при вершинах (i1+2)%3 и (i2+2)%3.
        const a1 = (equalSides[0][0] + 2) % 3, a2 = (equalSides[0][1] + 2) % 3;
        angles = [0, 0, 0];
        angles[a1] = DEFAULT_ISO_BASE;
        angles[a2] = DEFAULT_ISO_BASE;
        angles[3 - a1 - a2] = 180 - 2 * DEFAULT_ISO_BASE;
      } else {
        angles = DEFAULT_TRI;
      }

      // Непротиворечивость отметки равенства с числами.
      for (const [i1, i2] of equalSides) {
        if (sides && Math.abs(sides[i1] - sides[i2]) > 1e-9) {
          return reject(`треугольник: отмечены равными стороны ${sideNames[i1]} и ${sideNames[i2]}, а длины разные`);
        }
        if (angles) {
          const a1 = (i1 + 2) % 3, a2 = (i2 + 2) % 3;
          if (Math.abs(angles[a1] - angles[a2]) > 0.5) {
            return reject(`треугольник: равные стороны ${sideNames[i1]}=${sideNames[i2]} требуют равных углов при ${vertices[a1]} и ${vertices[a2]}`);
          }
        }
      }

      return { kind: "triangle", vertices, angles, sides, equalSides, elements, comment: comment(figure) };
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
