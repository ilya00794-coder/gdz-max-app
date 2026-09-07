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
// Представительный параллелограмм: угол 62° (заведомо не прямоугольник)
// и стороны 1:1.6 (заведомо не ромб) — требование pg8-geo-3: на чертеже
// доказательства не должно мерещиться свойств, которых нет в условии.
const DEFAULT_PARA_RATIO = 1.6;
// Представительный ромб: диагонали 1:1.5 (равные дали бы квадрат).
const DEFAULT_RHOMBUS = [1.5, 1];
// Представительная трапеция: основания 0.6:1, НЕ равнобокая (верх смещён).
const DEFAULT_TRAP = [0.6, 1];
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

    if (figure.kind === "parallelogram" || figure.kind === "rhombus" || figure.kind === "trapezoid") {
      const markList = (Array.isArray(figure.marks) ? figure.marks : [])
        .filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim().toLowerCase());
      let vertices = ["A", "B", "C", "D"];
      if (labels.length >= 4 && labels.slice(0, 4).every((l) => typeof l === "string" && l.trim() && l.trim().length <= 2)) {
        vertices = labels.slice(0, 4).map((l) => l.trim());
        if (new Set(vertices).size !== 4) return reject("четырёхугольник: буквы вершин повторяются");
      }
      const clash = (letter) => vertices.some((v) => v.toUpperCase() === letter.toUpperCase());
      const extra = (i, def) => {
        const raw = labels[4 + i];
        const letter = typeof raw === "string" && raw.trim() && raw.trim().length <= 2 ? raw.trim() : def;
        if (!clash(letter)) return letter;
        // Буква совпала с вершиной — берём первую свободную из запаса.
        return [def, "O", "E", "F", "K", "P"].find((c) => !clash(c)) ?? def;
      };

      if (figure.kind === "parallelogram") {
        for (const m of markList) if (m !== "диагонали") return reject(`параллелограмм: непонятная отметка «${m}»`);
        let angle = null;
        if (values.length === 1) {
          angle = values[0];
          if (!positive(angle) || angle >= 180) return reject(`параллелограмм: угол ${angle}°`);
          if (Math.min(angle, 180 - angle) < MIN_ANGLE) return reject(`параллелограмм: угол ${angle}° нечитаем`);
        } else if (values.length !== 0) {
          return reject(`параллелограмм: ${values.length} значений (нужно 0 или 1 — угол)`);
        }
        return {
          kind: "parallelogram", angle, // null → представительная форма (62°, 1:1.6) на фронте
          diagonals: markList.includes("диагонали"),
          vertices, oLetter: extra(0, "O"), comment: comment(figure),
        };
      }

      if (figure.kind === "rhombus") {
        // «диагонали» у ромба безвредны (они рисуются всегда) — игнорируем.
        const strange = markList.filter((m) => m !== "диагонали");
        if (strange.length) return reject(`ромб: непонятная отметка «${strange[0]}»`);
        let d1 = null, d2 = null, given = false;
        if (values.length === 2) {
          [d1, d2] = values; given = true;
          if (!positive(d1) || !positive(d2)) return reject("ромб: диагонали не положительные");
          if (Math.max(d1, d2) / Math.min(d1, d2) > MAX_RATIO) return reject(`ромб: вырожденные диагонали ${d1}/${d2}`);
        } else if (values.length !== 0) {
          return reject(`ромб: ${values.length} значений (нужно 0 или 2 — диагонали)`);
        } else {
          [d1, d2] = DEFAULT_RHOMBUS;
        }
        return { kind: "rhombus", d1, d2, given, vertices, oLetter: extra(0, "O"), comment: comment(figure) };
      }

      // trapezoid
      for (const m of markList) {
        if (m !== "средняя линия" && m !== "равнобокая") return reject(`трапеция: непонятная отметка «${m}»`);
      }
      let b1 = null, b2 = null, given = false;
      if (values.length === 2) {
        [b1, b2] = values; given = true;
        if (!positive(b1) || !positive(b2)) return reject("трапеция: основания не положительные");
        if (Math.abs(b1 - b2) < 1e-9) return reject("трапеция: основания равны — это параллелограмм, не трапеция");
        if (Math.max(b1, b2) / Math.min(b1, b2) > MAX_RATIO) return reject(`трапеция: вырожденные основания ${b1}/${b2}`);
      } else if (values.length !== 0) {
        return reject(`трапеция: ${values.length} значений (нужно 0 или 2 — основания)`);
      } else {
        [b1, b2] = DEFAULT_TRAP;
      }
      const midline = markList.includes("средняя линия");
      return {
        kind: "trapezoid", b1, b2, given,
        iso: markList.includes("равнобокая"), midline,
        vertices,
        mLetters: midline ? [extra(0, "M"), extra(1, "N")] : null,
        comment: comment(figure),
      };
    }

    // ---------- окружности (этап 1б, 06.09) ----------
    // Дефолты ВЕЗДЕ неспециальные (правило Ильи): не 90°, не 45°, не «красивые»
    // отношения — чертёж не подсказывает свойств, которых нет в условии.

    if (figure.kind === "circle-angles") {
      // Вписанный и центральный угол на общей дуге. values [вписанный угол].
      let inscribed = 40; // представительный: не 30/45/60, центральный 80 — не прямой
      if (values.length) {
        inscribed = values[0];
        if (!Number.isInteger(inscribed) || inscribed < MIN_ANGLE || inscribed > 85) {
          return reject(`circle-angles: вписанный угол ${inscribed} — не целое ${MIN_ANGLE}..85 (центральный ${inscribed * 2} не влезает в окружность читаемо)`);
        }
      }
      const [center = "O", a = "A", b = "B", c = "C"] = labels.map((l) => String(l ?? "").trim()).filter(Boolean);
      return { kind: "circle-angles", inscribed, labels: [center, a, b, c], hasValue: values.length > 0, comment: comment(figure) };
    }

    if (figure.kind === "circle-chord") {
      // values [радиус, хорда] в одних единицах; пусто — представительные 1 и 1.3
      // (хорда заведомо НЕ диаметр и НЕ равна радиусу). Расстояние до центра
      // вычисляет шаблон: d = sqrt(R² − (c/2)²).
      let radius = 1, chord = 1.3;
      if (values.length) {
        [radius, chord = radius * 1.3] = values;
        if (!positive(radius) || !positive(chord)) return reject(`circle-chord: радиус ${radius}, хорда ${chord}`);
        if (chord > 2 * radius) return reject(`circle-chord: хорда ${chord} длиннее диаметра ${2 * radius}`);
        if (chord < radius / 6) return reject(`circle-chord: хорда ${chord} вырожденно мала при радиусе ${radius}`);
      }
      const [center = "O", a = "A", b = "B"] = labels.map((l) => String(l ?? "").trim()).filter(Boolean);
      return { kind: "circle-chord", radius, chord, labels: [center, a, b], hasValue: values.length > 0, comment: comment(figure) };
    }

    if (figure.kind === "circle-tangent") {
      // values [радиус, расстояние от центра до внешней точки]; пусто —
      // представительные 1 и 1.8 (точка заведомо не на окружности, не 2R).
      let radius = 1, distance = 1.8;
      if (values.length) {
        [radius, distance = radius * 1.8] = values;
        if (!positive(radius) || !positive(distance)) return reject(`circle-tangent: радиус ${radius}, расстояние ${distance}`);
        if (distance <= radius) return reject(`circle-tangent: точка на расстоянии ${distance} внутри/на окружности радиуса ${radius} — касательной из неё нет`);
        if (distance > radius * MAX_RATIO) return reject(`circle-tangent: точка в ${distance / radius} радиусах — чертёж вырожден`);
      }
      const [center = "O", point = "A", touch = "K"] = labels.map((l) => String(l ?? "").trim()).filter(Boolean);
      return { kind: "circle-tangent", radius, distance, labels: [center, point, touch], hasValue: values.length > 0, comment: comment(figure) };
    }

    if (figure.kind === "triangle-circle") {
      // Треугольник со вписанной ИЛИ описанной окружностью. marks[0] —
      // «вписанная»/«описанная»; values — три угла или пусто (46/72/62 —
      // существующий представительный разносторонний непрямоугольный).
      const markList = (Array.isArray(figure.marks) ? figure.marks : [])
        .filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim().toLowerCase());
      const mode = markList.includes("описанная") ? "circum" : markList.includes("вписанная") ? "in" : null;
      if (!mode) return reject("triangle-circle: в marks нужна «вписанная» или «описанная»");
      let angles = DEFAULT_TRI;
      if (values.length) {
        if (values.length !== 3 || !values.every((v) => positive(v))) return reject(`triangle-circle: нужны три угла, получено ${JSON.stringify(values)}`);
        const sum = values[0] + values[1] + values[2];
        if (Math.abs(sum - 180) > 0.5) return reject(`triangle-circle: сумма углов ${sum} ≠ 180`);
        if (values.some((v) => v < MIN_ANGLE)) return reject(`triangle-circle: угол меньше ${MIN_ANGLE}° — чертёж вырожден`);
        angles = values;
      }
      let vertices = ["A", "B", "C"];
      if (labels.length >= 3 && labels.slice(0, 3).every((l) => typeof l === "string" && l.trim() && l.trim().length <= 2)) {
        vertices = labels.slice(0, 3).map((l) => l.trim());
        if (new Set(vertices).size !== 3) return reject("triangle-circle: буквы вершин повторяются");
      }
      return { kind: "triangle-circle", mode, angles, vertices, hasValue: values.length > 0, comment: comment(figure) };
    }

    // ---------- стереометрия без сечений (этап 2, 07.09) ----------
    // Ракурс зашит в шаблон (кабинетная проекция), невидимые рёбра — перечнем
    // на kind. Валидатор ловит кривые параметры; форма проекции — канарейка.

    if (figure.kind === "cube" || figure.kind === "box") {
      const need = 8;
      let vertices = ["A", "B", "C", "D", "A₁", "B₁", "C₁", "D₁"];
      const given = labels.map((l) => String(l ?? "").trim()).filter(Boolean);
      if (given.length) {
        if (given.length !== need) return reject(`${figure.kind}: вершин ${given.length}, нужно ${need}`);
        if (given.some((l) => l.length > 2)) return reject(`${figure.kind}: подпись вершины длиннее 2 символов`);
        if (new Set(given).size !== need) return reject(`${figure.kind}: буквы вершин повторяются`);
        vertices = given;
      }
      let edges; // [длина, глубина, высота]
      if (figure.kind === "cube") {
        let a = 1;
        if (values.length) {
          a = values[0];
          if (!positive(a)) return reject(`cube: ребро ${a}`);
        }
        edges = [a, a, a];
      } else {
        edges = [1.6, 1, 0.75]; // представительный: все разные, заведомо НЕ куб
        if (values.length) {
          if (values.length !== 3 || !values.every(positive)) return reject(`box: нужны три ребра, получено ${JSON.stringify(values)}`);
          edges = values;
        }
      }
      if (Math.max(...edges) / Math.min(...edges) > MAX_RATIO) return reject(`${figure.kind}: отношение рёбер ${Math.max(...edges)}/${Math.min(...edges)} вырожденно`);
      return { kind: "box3d", shape: figure.kind, edges, vertices, hasValue: values.length > 0, comment: comment(figure) };
    }

    if (figure.kind === "pyramid") {
      const markList = (Array.isArray(figure.marks) ? figure.marks : [])
        .filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim().toLowerCase());
      let baseN = 4;
      for (const m of markList) {
        if (m === "треугольная") baseN = 3;
        else if (m === "четырёхугольная" || m === "четырехугольная") baseN = 4;
        else return reject(`pyramid: непонятная отметка «${m}»`);
      }
      let side = 1, height = 1.1; // представительная: не 1:1, не «красивая»
      if (values.length) {
        if (values.length !== 2 || !values.every(positive)) return reject(`pyramid: нужны [сторона, высота], получено ${JSON.stringify(values)}`);
        [side, height] = values;
        if (Math.max(side, height) / Math.min(side, height) > MAX_RATIO) return reject(`pyramid: отношение ${side}/${height} вырожденно`);
      }
      const need = baseN + 1;
      let vertices = baseN === 4 ? ["S", "A", "B", "C", "D"] : ["S", "A", "B", "C"];
      const given = labels.map((l) => String(l ?? "").trim()).filter(Boolean);
      if (given.length) {
        if (given.length !== need) return reject(`pyramid: вершин ${given.length}, нужно ${need} (вершина + основание)`);
        if (given.some((l) => l.length > 2) || new Set(given).size !== need) return reject("pyramid: подписи вершин кривые/повторяются");
        vertices = given;
      }
      return { kind: "pyramid", baseN, side, height, vertices, hasValue: values.length > 0, comment: comment(figure) };
    }

    if (figure.kind === "prism") {
      // Правильная ТРЕУГОЛЬНАЯ призма (четырёхугольная = box).
      let side = 1, height = 1.3;
      if (values.length) {
        if (values.length !== 2 || !values.every(positive)) return reject(`prism: нужны [сторона основания, высота], получено ${JSON.stringify(values)}`);
        [side, height] = values;
        if (Math.max(side, height) / Math.min(side, height) > MAX_RATIO) return reject(`prism: отношение ${side}/${height} вырожденно`);
      }
      let vertices = ["A", "B", "C", "A₁", "B₁", "C₁"];
      const given = labels.map((l) => String(l ?? "").trim()).filter(Boolean);
      if (given.length) {
        if (given.length !== 6) return reject(`prism: вершин ${given.length}, нужно 6`);
        if (given.some((l) => l.length > 2) || new Set(given).size !== 6) return reject("prism: подписи вершин кривые/повторяются");
        vertices = given;
      }
      return { kind: "prism", side, height, vertices, hasValue: values.length > 0, comment: comment(figure) };
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
