// Чистые генераторы SVG для наглядности (№12): графики функций (mode=plot
// бэкенда) и чертежи частей 1–4 + группа Б. Вынесено из app.js 01.09.2026
// (карта уборки, п.5) — здесь ТОЛЬКО функции данные→SVG, ничего из DOM/состояния.
//
// ВАЖНО про подключение: файл — обычный <script> БЕЗ модулей (на Pages нет
// бандлера). Он должен грузиться ДО app.js (порядок в index.html): его функции
// становятся глобальными, а escapeHtml здесь же используется остальным app.js.
// Node-guard в конце — только для юнит-канарейки (backend/src/tools/svg-canary.mjs);
// в браузере module не определён, guard пропускается.

/**
 * Экранирует текст перед вставкой через innerHTML.
 *
 * Это не только про безопасность. Тексты приходят от модели и полны математики:
 * «16-20<0», «a<b», «x>0». Без экранирования браузер принимает «<b» за начало тега
 * и молча съедает кусок решения. KaTeX это не мешает — он читает текстовые узлы,
 * где сущности уже разобраны обратно в символы.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- график функции: свой SVG, без библиотек ----------
//
// Данные приходят готовыми с бэкенда (verify_sympy mode=plot): points с
// возможными y:null (разрывы), zeros, extrema, asymptotes. Модель координат
// не выдаёт — рисуем только посчитанное SymPy.

const GRAPH_W = 340;
const GRAPH_H = 210;
const GRAPH_PAD = { top: 12, right: 14, bottom: 24, left: 34 };
const GRAPH_ACCENT = "#185FA5";
const GRAPH_GREY = "#C8C7C0";

/** Число для подписи: до двух знаков, без хвостовых нулей, запятая как в тетради. */
function graphNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(".", ",").replace("-", "−");
}

/**
 * Окно по y: у функций с асимптотами значения улетают в тысячи, и без обрезки
 * весь график схлопнулся бы в горизонтальную линию. Берём срединные 88%
 * значений, но обязательно включаем ось x, экстремумы и горизонтальные
 * асимптоты — то, что должно быть видно всегда.
 */
function graphYWindow(graph) {
  const ys = [];
  for (const plot of graph.plots) {
    for (const [, y] of plot.points) if (y !== null) ys.push(y);
  }
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  let lo = ys[Math.floor(ys.length * 0.06)];
  let hi = ys[Math.ceil(ys.length * 0.94) - 1];
  const mustSee = [0];
  for (const plot of graph.plots) {
    for (const e of plot.extrema) mustSee.push(e.y);
    for (const h of plot.asymptotes.horizontal) mustSee.push(h);
  }
  lo = Math.min(lo, ...mustSee);
  hi = Math.max(hi, ...mustSee);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  // Границы округляем до «красивых» значений (шаг 1, 2, 5, 10 и кратные),
  // как на осях в учебнике: подпись «−9,72» на краю оси только путает.
  const step = graphNiceStep(hi - lo);
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step };
}

/** Красивый шаг оси: 1, 2, 5 или 10, умноженные на степень десятки. */
function graphNiceStep(range) {
  const power = Math.pow(10, Math.floor(Math.log10(range / 5)));
  for (const mult of [1, 2, 5, 10]) {
    if (range / (mult * power) <= 6) return mult * power;
  }
  return 10 * power;
}

/** Точка пересечения двух полилиний (для системы — это и есть ответ). */
function graphIntersections(plots) {
  if (plots.length !== 2) return [];
  const [a, b] = plots;
  const found = [];
  for (let i = 1; i < a.points.length && found.length < 3; i++) {
    const [x0, ya0] = a.points[i - 1], [x1, ya1] = a.points[i];
    const yb0 = b.points[i - 1][1], yb1 = b.points[i][1];
    if (ya0 === null || ya1 === null || yb0 === null || yb1 === null) continue;
    const d0 = ya0 - yb0, d1 = ya1 - yb1;
    if (d0 === 0) { found.push([x0, ya0]); continue; }
    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      found.push([x0 + t * (x1 - x0), ya0 + t * (ya1 - ya0)]);
    }
  }
  return found;
}

/** Собирает SVG-разметку графика. Внутрь попадают только числа — экранировать нечего. */
function graphSvg(graph) {
  const win = graphYWindow(graph);
  if (!win) return "";
  const [xa, xb] = graph.plots[0].xRange;
  const plotW = GRAPH_W - GRAPH_PAD.left - GRAPH_PAD.right;
  const plotH = GRAPH_H - GRAPH_PAD.top - GRAPH_PAD.bottom;
  const sx = (x) => GRAPH_PAD.left + ((x - xa) / (xb - xa)) * plotW;
  const sy = (y) => GRAPH_PAD.top + ((win.hi - y) / (win.hi - win.lo)) * plotH;
  const inWin = (y) => y !== null && y >= win.lo && y <= win.hi;

  const parts = [];

  // Оси: x — на y=0 (окно всегда включает 0), y — на x=0 либо у левого края.
  const axisY = sy(0);
  const axisX = xa <= 0 && 0 <= xb ? sx(0) : GRAPH_PAD.left;
  parts.push(`<line x1="${GRAPH_PAD.left}" y1="${axisY}" x2="${GRAPH_W - GRAPH_PAD.right}" y2="${axisY}" stroke="#B4B3AC" stroke-width="1"/>`);
  parts.push(`<line x1="${axisX}" y1="${GRAPH_PAD.top}" x2="${axisX}" y2="${GRAPH_H - GRAPH_PAD.bottom}" stroke="#B4B3AC" stroke-width="1"/>`);
  // Подписи осей и краёв — засечек мало, сетки нет.
  parts.push(`<text x="${GRAPH_W - GRAPH_PAD.right}" y="${axisY - 5}" font-size="11" fill="#888780" text-anchor="end">x</text>`);
  parts.push(`<text x="${axisX + 5}" y="${GRAPH_PAD.top + 9}" font-size="11" fill="#888780">y</text>`);
  parts.push(`<text x="${sx(xa)}" y="${GRAPH_H - 8}" font-size="11" fill="#888780" text-anchor="start">${graphNumber(xa)}</text>`);
  parts.push(`<text x="${sx(xb)}" y="${GRAPH_H - 8}" font-size="11" fill="#888780" text-anchor="end">${graphNumber(xb)}</text>`);
  parts.push(`<text x="${GRAPH_PAD.left - 4}" y="${sy(win.hi) + 10}" font-size="11" fill="#888780" text-anchor="end">${graphNumber(win.hi)}</text>`);
  parts.push(`<text x="${GRAPH_PAD.left - 4}" y="${sy(win.lo)}" font-size="11" fill="#888780" text-anchor="end">${graphNumber(win.lo)}</text>`);

  // Асимптоты — тонкий серый пунктир.
  for (const plot of graph.plots) {
    for (const v of plot.asymptotes.vertical) {
      if (v < xa || v > xb) continue;
      parts.push(`<line x1="${sx(v)}" y1="${GRAPH_PAD.top}" x2="${sx(v)}" y2="${GRAPH_H - GRAPH_PAD.bottom}" stroke="${GRAPH_GREY}" stroke-width="1" stroke-dasharray="4 4"/>`);
    }
    for (const h of plot.asymptotes.horizontal) {
      if (h < win.lo || h > win.hi) continue;
      parts.push(`<line x1="${GRAPH_PAD.left}" y1="${sy(h)}" x2="${GRAPH_W - GRAPH_PAD.right}" y2="${sy(h)}" stroke="${GRAPH_GREY}" stroke-width="1" stroke-dasharray="4 4"/>`);
    }
  }

  // Кривые. Разрыв (y:null) и вылет за окно рвут полилинию: гипербола — две
  // ветви, а не линия через ноль. Вторая функция — тот же цвет, тоньше и пунктиром.
  graph.plots.forEach((plot, idx) => {
    const segments = [];
    let current = [];
    for (const [x, y] of plot.points) {
      if (!inWin(y)) {
        if (current.length > 1) segments.push(current);
        current = [];
        continue;
      }
      current.push(`${sx(x).toFixed(1)},${sy(y).toFixed(1)}`);
    }
    if (current.length > 1) segments.push(current);
    const d = segments.map((seg) => "M" + seg.join(" L")).join(" ");
    const style = idx === 0
      ? `stroke="${GRAPH_ACCENT}" stroke-width="2.2"`
      : `stroke="${GRAPH_ACCENT}" stroke-width="1.4" stroke-dasharray="7 5"`;
    if (d) parts.push(`<path d="${d}" fill="none" ${style} stroke-linejoin="round" class="graph-line"/>`);
  });

  // Особые точки: нули — залитые кружки на оси, экстремумы — с белой серединой.
  for (const plot of graph.plots) {
    for (const z of plot.zeros) {
      if (z < xa || z > xb) continue;
      parts.push(`<circle cx="${sx(z)}" cy="${sy(0)}" r="3.5" fill="${GRAPH_ACCENT}" class="graph-zero"/>`);
      parts.push(`<text x="${sx(z)}" y="${sy(0) + 15}" font-size="11" fill="#444441" text-anchor="middle">${graphNumber(z)}</text>`);
    }
    for (const e of plot.extrema) {
      if (e.x < xa || e.x > xb || !inWin(e.y)) continue;
      parts.push(`<circle cx="${sx(e.x)}" cy="${sy(e.y)}" r="3.5" fill="#fff" stroke="${GRAPH_ACCENT}" stroke-width="2" class="graph-extremum"/>`);
      parts.push(`<text x="${sx(e.x)}" y="${sy(e.y) + (e.kind === "max" ? -8 : 16)}" font-size="11" fill="#444441" text-anchor="middle">(${graphNumber(e.x)}; ${graphNumber(e.y)})</text>`);
    }
  }

  // Пересечение двух функций — для системы это и есть ответ, выделяем сильнее.
  for (const [ix, iy] of graphIntersections(graph.plots)) {
    if (!inWin(iy)) continue;
    parts.push(`<circle cx="${sx(ix)}" cy="${sy(iy)}" r="4.5" fill="${GRAPH_ACCENT}" class="graph-intersection"/>`);
    parts.push(`<text x="${sx(ix)}" y="${sy(iy) - 9}" font-size="12" font-weight="500" fill="#04234F" text-anchor="middle">(${graphNumber(ix)}; ${graphNumber(iy)})</text>`);
  }

  return `<svg viewBox="0 0 ${GRAPH_W} ${GRAPH_H}" role="img" aria-label="График функции">${parts.join("")}</svg>`;
}

/** Заполняет карточку графика или прячет её, если графика нет (старый кэш, отказ бэкенда). */
// ---------- параметрические рисунки (№12, группа Б): кружки и числовой луч ----------
// Принцип графика: модель называет только ПАРАМЕТРЫ (числа из условия),
// рисует система детерминированным шаблоном. Верность рисунка = верность
// чисел, а числа сверяемы с условием — свободного рисования здесь нет.

function circlesSvg(v) {
  const total = Math.min(Math.max(1, Math.round(v.circlesTotal ?? 0)), 40);
  const crossed = Math.min(Math.max(0, Math.round(v.circlesCrossed ?? 0)), total);
  const group = v.circlesGroupSize ? Math.max(2, Math.round(v.circlesGroupSize)) : null;
  const perRow = 10, r = 9, gap = 26, gapGroup = 12;
  const cols = Math.min(total, perRow);
  const rows = Math.ceil(total / perRow);
  const extra = group ? Math.floor((cols - 1) / group) * gapGroup : 0;
  const w = cols * gap + extra + 8, h = rows * gap + 8;
  let out = "";
  for (let i = 0; i < total; i++) {
    const col = i % perRow, row = Math.floor(i / perRow);
    const gx = group ? Math.floor(col / group) * gapGroup : 0;
    const cx = 4 + r + col * gap + gx, cy = 4 + r + row * gap;
    const isCrossed = i >= total - crossed;
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${isCrossed ? "none" : "#185FA5"}" fill-opacity="${isCrossed ? 0 : 0.25}" stroke="#185FA5" stroke-width="1.5"/>`;
    if (isCrossed) out += `<path d="M${cx - r * 0.7} ${cy - r * 0.7} L${cx + r * 0.7} ${cy + r * 0.7} M${cx + r * 0.7} ${cy - r * 0.7} L${cx - r * 0.7} ${cy + r * 0.7}" stroke="#B54141" stroke-width="1.8"/>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" role="img">${out}</svg>`;
}

function numberlineSvg(v) {
  const pts = (v.points ?? []).filter((p) => Number.isFinite(p.value)).slice(0, 8);
  if (!pts.length || !v.range) return "";
  let [a, b] = v.range;
  if (!(b > a)) { a = Math.min(...pts.map((p) => p.value)) - 1; b = Math.max(...pts.map((p) => p.value)) + 1; }
  const W = 320, H = 66, pad = 18, y = 40;
  const X = (val) => pad + ((val - a) / (b - a)) * (W - 2 * pad);
  let out = `<line x1="4" y1="${y}" x2="${W - 4}" y2="${y}" stroke="#5B5A54" stroke-width="1.5"/>` +
    `<path d="M${W - 10} ${y - 4} L${W - 4} ${y} L${W - 10} ${y + 4}" fill="none" stroke="#5B5A54" stroke-width="1.5"/>`;
  const step = graphNiceStep((b - a) / 6);
  for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) {
    const x = X(t);
    out += `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="#8B8A84" stroke-width="1"/>` +
      `<text x="${x}" y="${y + 18}" font-size="10" text-anchor="middle" fill="#8B8A84">${Number(t.toFixed(6))}</text>`;
  }
  for (const p of pts) {
    const x = X(p.value);
    out += `<circle cx="${x}" cy="${y}" r="4" fill="#185FA5"/>` +
      `<text x="${x}" y="${y - 10}" font-size="11" text-anchor="middle" fill="#185FA5">${escapeHtml(p.label || String(p.value))}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img">${out}</svg>`;
}

// ---------- чертежи (№12, чертежи — часть 1): прямоугольник и квадрат ----------
// Тот же принцип, что кружки и луч: модель назвала параметры, бэкенд их
// провалидировал (services/drawing.js), здесь — только детерминированный шаблон.
// Пропорции чертежа истинные (масштаб width:height как в условии).

function drawingSvg(d) {
  const isSquare = d.kind === "square";
  const w = isSquare ? d.side : d.width;
  const h = isSquare ? d.side : d.height;
  if (!(w > 0) || !(h > 0)) return "";
  const MAXW = 230, MAXH = 160;
  const k = Math.min(MAXW / w, MAXH / h);
  const rw = w * k, rh = h * k;
  const padL = 30, padT = 12, padR = 14, padB = 30; // слева и снизу — место под подписи
  const W = padL + rw + padR, H = padT + rh + padB;
  let out = `<rect x="${padL}" y="${padT}" width="${rw}" height="${rh}" fill="#185FA5" fill-opacity="0.06" stroke="#185FA5" stroke-width="2"/>`;
  // Подпись горизонтальной стороны — под нижней стороной, по центру.
  const bottomLabel = isSquare ? d.sideLabel : d.widthLabel;
  out += `<text x="${padL + rw / 2}" y="${padT + rh + 19}" font-size="13" text-anchor="middle" fill="#444441">${escapeHtml(bottomLabel || "")}</text>`;
  // У прямоугольника — вторая подпись слева, вертикально вдоль стороны.
  if (!isSquare) {
    const cx = padL - 10, cy = padT + rh / 2;
    out += `<text x="${cx}" y="${cy}" font-size="13" text-anchor="middle" fill="#444441" transform="rotate(-90 ${cx} ${cy})">${escapeHtml(d.heightLabel || "")}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: ${isSquare ? "квадрат" : "прямоугольник"}">${out}</svg>`;
}

// ---------- чертежи углов (№12, часть 2) ----------
// Примитив «дуга угла + подпись» ОБЩИЙ: его же будут использовать
// треугольники и четырёхугольники (части 3–4). Углы — математические
// (против часовой от положительного направления x), y экрана учитён внутри.

const FIG_ACCENT = "#185FA5";
const FIG_LINE = "#5B5A54";
const FIG_TEXT = "#444441";

function figPoint(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
}

/** Дуга от from к to против часовой (видимой), радиуса r. */
function angleArc(cx, cy, r, from, to, color = FIG_ACCENT) {
  const [x1, y1] = figPoint(cx, cy, r, from);
  const [x2, y2] = figPoint(cx, cy, r, to);
  const span = (((to - from) % 360) + 360) % 360;
  const large = span > 180 ? 1 : 0;
  return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 0 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
}

/** Подпись у биссектрисы дуги (текст значения или обозначения угла). */
function angleText(cx, cy, r, from, to, text, color = FIG_TEXT, size = 11) {
  const span = (((to - from) % 360) + 360) % 360;
  const [x, y] = figPoint(cx, cy, r, from + span / 2);
  return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="${size}" text-anchor="middle" fill="${color}">${escapeHtml(text)}</text>`;
}

function figDeg(v) {
  return `${Number(v.toFixed(1))}°`;
}

function adjacentAnglesSvg(f) {
  const W = 300, H = 170, cx = 150, cy = 128;
  const rayLen = 96;
  const [rx, ry] = figPoint(cx, cy, rayLen, f.right);
  let out = `<line x1="22" y1="${cy}" x2="278" y2="${cy}" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  out += `<line x1="${cx}" y1="${cy}" x2="${rx.toFixed(1)}" y2="${ry.toFixed(1)}" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  out += angleArc(cx, cy, 32, 0, f.right) + angleText(cx, cy, 50, 0, f.right, figDeg(f.right), FIG_ACCENT);
  out += angleArc(cx, cy, 24, f.right, 180) + angleText(cx, cy, 44, f.right, 180, figDeg(f.left), FIG_ACCENT);
  if (f.letters) {
    const [A, O, B, C] = f.letters;
    const [lx, ly] = figPoint(cx, cy, rayLen + 13, f.right);
    out += `<text x="18" y="${cy + 16}" font-size="12" fill="${FIG_TEXT}">${escapeHtml(A)}</text>`;
    out += `<text x="${cx}" y="${cy + 16}" font-size="12" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(O)}</text>`;
    out += `<text x="278" y="${cy + 16}" font-size="12" text-anchor="end" fill="${FIG_TEXT}">${escapeHtml(B)}</text>`;
    out += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="12" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(C)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: смежные углы">${out}</svg>`;
}

function verticalAnglesSvg(f) {
  const W = 300, H = 190, cx = 150, cy = 95, len = 118;
  const a = f.angle;
  const [x2, y2] = figPoint(cx, cy, len, a);
  const [x3, y3] = figPoint(cx, cy, len, a + 180);
  let out = `<line x1="${cx - len}" y1="${cy}" x2="${cx + len}" y2="${cy}" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  out += `<line x1="${x3.toFixed(1)}" y1="${y3.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  // Четыре сектора от данного угла против часовой: ∠1 = a, ∠2 = 180−a, ∠3 = a, ∠4 = 180−a.
  const sectors = [ [0, a, a], [a, 180, 180 - a], [180, 180 + a, a], [180 + a, 360, 180 - a] ];
  sectors.forEach(([from, to, val], i) => {
    out += angleArc(cx, cy, 24 + (i % 2) * 5, from, to);
    out += angleText(cx, cy, 52, from, to, `${f.names[i]} = ${figDeg(val)}`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: вертикальные углы">${out}</svg>`;
}

function parallelLinesSvg(f) {
  const W = 300, H = 200, y1 = 58, y2 = 142;
  const a = f.angle;
  // Секущая идёт сверху-справа вниз-влево при остром угле: пересечения P1 и P2.
  const p1x = 128;
  const p2x = p1x + (y2 - y1) / Math.tan((a * Math.PI) / 180);
  const dirDown = -a; // экранное направление секущей вниз от P1
  const [t1x, t1y] = figPoint(p1x, y1, 40, dirDown + 180);
  const [t2x, t2y] = figPoint(p2x, y2, 40, dirDown);
  let out = `<line x1="20" y1="${y1}" x2="280" y2="${y1}" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  out += `<line x1="20" y1="${y2}" x2="280" y2="${y2}" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  out += `<line x1="${t1x.toFixed(1)}" y1="${t1y.toFixed(1)}" x2="${t2x.toFixed(1)}" y2="${t2y.toFixed(1)}" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  // Шевроны параллельности на обеих прямых.
  for (const y of [y1, y2]) {
    out += `<path d="M246 ${y - 5} L254 ${y} L246 ${y + 5}" fill="none" stroke="${FIG_LINE}" stroke-width="1.4"/>`;
  }
  // Данный угол — у верхней прямой, между правым направлением и секущей вниз.
  out += angleArc(p1x, y1, 26, dirDown, 0) + angleText(p1x, y1, 44, dirDown, 0, figDeg(a), FIG_ACCENT);
  // Парный угол у нижней прямой — по типу пары.
  const dirUp = 180 - a; // направление секущей вверх от P2
  if (f.pair === "alternate") {
    out += angleArc(p2x, y2, 26, dirUp, 180) + angleText(p2x, y2, 44, dirUp, 180, figDeg(a), FIG_ACCENT);
  } else if (f.pair === "corresponding") {
    out += angleArc(p2x, y2, 26, dirDown, 0) + angleText(p2x, y2, 44, dirDown, 0, figDeg(a), FIG_ACCENT);
  } else if (f.pair === "co-interior") {
    out += angleArc(p2x, y2, 26, 0, dirUp) + angleText(p2x, y2, 46, 0, dirUp, figDeg(180 - a), FIG_ACCENT);
  }
  const [n1, n2, n3] = f.names;
  out += `<text x="284" y="${y1 + 4}" font-size="12" font-style="italic" fill="${FIG_TEXT}">${escapeHtml(n1)}</text>`;
  out += `<text x="284" y="${y2 + 4}" font-size="12" font-style="italic" fill="${FIG_TEXT}">${escapeHtml(n2)}</text>`;
  out += `<text x="${(t1x + 8).toFixed(1)}" y="${(t1y + 2).toFixed(1)}" font-size="12" font-style="italic" fill="${FIG_TEXT}">${escapeHtml(n3)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: параллельные прямые с секущей">${out}</svg>`;
}

// ---------- треугольник (№12, часть 3) ----------
// Примитив «отметка равенства отрезков» ОБЩИЙ — четырёхугольники (часть 4)
// используют его же, как и angleArc.

/** Короткий штрих поперёк отрезка в его середине — школьная отметка равенства. */
function tickMark(x1, y1, x2, y2, color = FIG_LINE) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
  return `<line x1="${(mx - nx * 5).toFixed(1)}" y1="${(my - ny * 5).toFixed(1)}" x2="${(mx + nx * 5).toFixed(1)}" y2="${(my + ny * 5).toFixed(1)}" stroke="${color}" stroke-width="1.6"/>`;
}

/** Математический угол (градусы) направления из точки p в точку q, y экрана учтён. */
function figDir(p, q) {
  return (Math.atan2(-(q[1] - p[1]), q[0] - p[0]) * 180) / Math.PI;
}

function triangleSvg(f) {
  // Координаты вершин: основание AC горизонтально, B сверху.
  let A, B, C;
  if (f.sides) {
    const [ab, bc, ca] = f.sides;
    const cosA = (ab * ab + ca * ca - bc * bc) / (2 * ab * ca);
    A = [0, 0]; C = [ca, 0];
    B = [ab * cosA, -ab * Math.sqrt(Math.max(0, 1 - cosA * cosA))];
  } else {
    const [alpha, beta, gamma] = f.angles.map((d) => (d * Math.PI) / 180);
    const ab = Math.sin(gamma) / Math.sin(beta);
    A = [0, 0]; C = [1, 0];
    B = [ab * Math.cos(alpha), -ab * Math.sin(alpha)];
  }
  // Вписываем в кадр.
  const W = 300, H = 215, pad = 34;
  const xs = [A[0], B[0], C[0]], ys = [A[1], B[1], C[1]];
  const k = Math.min((W - 2 * pad) / (Math.max(...xs) - Math.min(...xs)), (H - 2 * pad) / (Math.max(...ys) - Math.min(...ys)));
  const ox = pad - Math.min(...xs) * k, oy = pad - Math.min(...ys) * k;
  const tr = (p) => [p[0] * k + ox, p[1] * k + oy];
  [A, B, C] = [tr(A), tr(B), tr(C)];
  const V = [A, B, C];
  const P = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

  let out = `<path d="M${P(A)} L${P(B)} L${P(C)} Z" fill="${FIG_ACCENT}" fill-opacity="0.05" stroke="${FIG_LINE}" stroke-width="1.8"/>`;

  // Дуги углов со значениями — когда заданы углы; подписи сторон — когда стороны.
  if (f.angles && !f.sides) {
    V.forEach((v, i) => {
      const [p, q] = [V[(i + 1) % 3], V[(i + 2) % 3]];
      let d1 = figDir(v, p), d2 = figDir(v, q);
      if ((((d2 - d1) % 360) + 360) % 360 > 180) [d1, d2] = [d2, d1];
      out += angleArc(v[0], v[1], 20, d1, d2) + angleText(v[0], v[1], 36, d1, d2, figDeg(f.angles[i]), FIG_ACCENT, 10.5);
    });
  }
  if (f.sides) {
    const mids = [[A, B, f.sides[0]], [B, C, f.sides[1]], [C, A, f.sides[2]]];
    const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3;
    for (const [p, q, val] of mids) {
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      const dl = Math.hypot(mx - cx, my - cy) || 1;
      out += `<text x="${(mx + ((mx - cx) / dl) * 13).toFixed(1)}" y="${(my + ((my - cy) / dl) * 13 + 4).toFixed(1)}" font-size="11" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(String(val))}</text>`;
    }
  }

  // Отметки равных сторон (пара индексов по [AB, BC, CA]).
  const sidePts = [[A, B], [B, C], [C, A]];
  for (const pair of f.equalSides) {
    for (const i of pair) out += tickMark(...sidePts[i][0], ...sidePts[i][1]);
  }

  // Элементы: медиана/высота/биссектриса — основание считаем честной геометрией;
  // совпавшие основания (равнобедренный) рисуются одной точкой с одной буквой.
  const feet = [];
  for (const el of f.elements) {
    const v = V[el.from];
    const [p, q] = [V[(el.from + 1) % 3], V[(el.from + 2) % 3]];
    let foot;
    if (el.type === "median") {
      foot = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    } else if (el.type === "height") {
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const t = ((v[0] - p[0]) * dx + (v[1] - p[1]) * dy) / (dx * dx + dy * dy);
      foot = [p[0] + t * dx, p[1] + t * dy];
      if (t < 0 || t > 1) {
        const from = t < 0 ? p : q;
        out += `<line x1="${from[0].toFixed(1)}" y1="${from[1].toFixed(1)}" x2="${foot[0].toFixed(1)}" y2="${foot[1].toFixed(1)}" stroke="${FIG_LINE}" stroke-width="1.2" stroke-dasharray="4 4"/>`;
      }
    } else {
      const vp = Math.hypot(p[0] - v[0], p[1] - v[1]);
      const vq = Math.hypot(q[0] - v[0], q[1] - v[1]);
      const t = vp / (vp + vq);
      foot = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
    }
    const twin = feet.find((g) => Math.hypot(g.foot[0] - foot[0], g.foot[1] - foot[1]) < 3);
    if (twin) { twin.merged = true; continue; } // совпадение показываем честно: одна линия, одна буква
    out += `<line x1="${v[0].toFixed(1)}" y1="${v[1].toFixed(1)}" x2="${foot[0].toFixed(1)}" y2="${foot[1].toFixed(1)}" stroke="${FIG_ACCENT}" stroke-width="1.7"/>`;
    feet.push({ foot, letter: el.foot });
  }
  for (const g of feet) {
    out += `<circle cx="${g.foot[0].toFixed(1)}" cy="${g.foot[1].toFixed(1)}" r="2.4" fill="${FIG_ACCENT}"/>`;
    out += `<text x="${g.foot[0].toFixed(1)}" y="${(g.foot[1] + 15).toFixed(1)}" font-size="12" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(g.letter)}</text>`;
  }

  // Буквы вершин — наружу от центра тяжести.
  const gx = (A[0] + B[0] + C[0]) / 3, gy = (A[1] + B[1] + C[1]) / 3;
  V.forEach((v, i) => {
    const dl = Math.hypot(v[0] - gx, v[1] - gy) || 1;
    const lx = v[0] + ((v[0] - gx) / dl) * 15, ly = v[1] + ((v[1] - gy) / dl) * 15;
    out += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" font-size="13" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(f.vertices[i])}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: треугольник">${out}</svg>`;
}

// ---------- четырёхугольники (№12, часть 4) ----------
// Переиспользуют angleArc/angleText (дуги углов) и tickMark (равенство сторон).
// Точки пересечения диагоналей и концы средней линии ВЫЧИСЛЯЮТСЯ из координат,
// а не рисуются символически.

/** Обход вершин, буквы наружу от центра, общий низ фигур части 4. */
function quadShell(pts, vertices, W, H) {
  const P = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  let out = `<path d="M${pts.map(P).join(" L")} Z" fill="${FIG_ACCENT}" fill-opacity="0.05" stroke="${FIG_LINE}" stroke-width="1.8"/>`;
  const gx = pts.reduce((a, p) => a + p[0], 0) / 4, gy = pts.reduce((a, p) => a + p[1], 0) / 4;
  pts.forEach((v, i) => {
    const dl = Math.hypot(v[0] - gx, v[1] - gy) || 1;
    out += `<text x="${(v[0] + ((v[0] - gx) / dl) * 14).toFixed(1)}" y="${(v[1] + ((v[1] - gy) / dl) * 14 + 4).toFixed(1)}" font-size="13" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(vertices[i])}</text>`;
  });
  return out;
}

function parallelogramSvg(f) {
  const W = 320, H = 190;
  const angle = f.angle ?? 62; // представительная форма: не прямоугольник
  const rad = (Math.min(angle, 180 - angle) * Math.PI) / 180;
  // Стороны 1.6:1 — представительная форма заведомо не ромб; наклон по углу.
  const side = 88, base = side * 1.6;
  const dx = side * Math.cos(rad), dy = side * Math.sin(rad);
  const x0 = (W - base - dx) / 2, y0 = (H + dy) / 2 + 8;
  // Обход по кругу: A (низ лев), B (верх лев), C (верх прав), D (низ прав).
  const A = [x0, y0], B = [x0 + dx, y0 - dy], C = [x0 + dx + base, y0 - dy], D = [x0 + base, y0];
  const pts = [A, B, C, D];
  let out = quadShell(pts, f.vertices, W, H);
  if (f.angle !== null) {
    // Углы: при A = angle, дальше по кругу 180−angle, angle, 180−angle.
    const vals = [angle, 180 - angle, angle, 180 - angle];
    pts.forEach((v, i) => {
      const [p, q] = [pts[(i + 1) % 4], pts[(i + 3) % 4]];
      let d1 = figDir(v, p), d2 = figDir(v, q);
      if ((((d2 - d1) % 360) + 360) % 360 > 180) [d1, d2] = [d2, d1];
      out += angleArc(v[0], v[1], 16, d1, d2) + angleText(v[0], v[1], 33, d1, d2, figDeg(vals[i]), FIG_ACCENT, 10.5);
    });
  }
  if (f.diagonals) {
    const O = [(A[0] + C[0]) / 2, (A[1] + C[1]) / 2]; // вычислено: диагонали параллелограмма делятся пополам
    out += `<line x1="${A[0].toFixed(1)}" y1="${A[1].toFixed(1)}" x2="${C[0].toFixed(1)}" y2="${C[1].toFixed(1)}" stroke="${FIG_ACCENT}" stroke-width="1.5"/>`;
    out += `<line x1="${B[0].toFixed(1)}" y1="${B[1].toFixed(1)}" x2="${D[0].toFixed(1)}" y2="${D[1].toFixed(1)}" stroke="${FIG_ACCENT}" stroke-width="1.5"/>`;
    out += `<circle cx="${O[0].toFixed(1)}" cy="${O[1].toFixed(1)}" r="2.4" fill="${FIG_ACCENT}"/>`;
    out += `<text x="${(O[0] + 9).toFixed(1)}" y="${(O[1] - 7).toFixed(1)}" font-size="12" fill="${FIG_TEXT}">${escapeHtml(f.oLetter)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: параллелограмм">${out}</svg>`;
}

function rhombusSvg(f) {
  const W = 300, H = 220, pad = 30;
  const k = Math.min((W - 2 * pad) / f.d1, (H - 2 * pad) / f.d2);
  const cx = W / 2, cy = H / 2;
  const hx = (f.d1 * k) / 2, hy = (f.d2 * k) / 2;
  // Диагональ AC горизонтальна, BD вертикальна; обход A, B, C, D по кругу.
  const A = [cx - hx, cy], B = [cx, cy - hy], C = [cx + hx, cy], D = [cx, cy + hy];
  let out = quadShell([A, B, C, D], f.vertices, W, H);
  out += `<line x1="${A[0].toFixed(1)}" y1="${A[1]}" x2="${C[0].toFixed(1)}" y2="${C[1]}" stroke="${FIG_ACCENT}" stroke-width="1.5"/>`;
  out += `<line x1="${B[0]}" y1="${B[1].toFixed(1)}" x2="${D[0]}" y2="${D[1].toFixed(1)}" stroke="${FIG_ACCENT}" stroke-width="1.5"/>`;
  out += `<circle cx="${cx}" cy="${cy}" r="2.4" fill="${FIG_ACCENT}"/>`; // вычислено: центр ромба
  out += `<text x="${cx + 9}" y="${cy - 7}" font-size="12" fill="${FIG_TEXT}">${escapeHtml(f.oLetter)}</text>`;
  if (f.given) {
    out += `<text x="${cx - hx / 2}" y="${cy - 6}" font-size="11" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(String(f.d1))}</text>`;
    out += `<text x="${cx + 7}" y="${cy - hy / 2}" font-size="11" fill="${FIG_TEXT}">${escapeHtml(String(f.d2))}</text>`;
  }
  // Все стороны ромба равны — отметки на каждой (общий примитив).
  for (const [p, q] of [[A, B], [B, C], [C, D], [D, A]]) out += tickMark(p[0], p[1], q[0], q[1]);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: ромб">${out}</svg>`;
}

function trapezoidSvg(f) {
  const W = 320, H = 190, pad = 30;
  const k = (W - 2 * pad) / Math.max(f.b1, f.b2);
  const top = f.b1 * k, bottom = f.b2 * k, h = 96;
  const y0 = (H + h) / 2, x0 = (W - bottom) / 2;
  // Верхнее основание: равнобокая — по центру; иначе смещено влево
  // (представительная форма заведомо не равнобокая).
  const shift = f.iso ? (bottom - top) / 2 : (bottom - top) * 0.24;
  const A = [x0, y0], B = [x0 + shift, y0 - h], C = [x0 + shift + top, y0 - h], D = [x0 + bottom, y0];
  let out = quadShell([A, B, C, D], f.vertices, W, H);
  if (f.given) {
    out += `<text x="${(B[0] + C[0]) / 2}" y="${B[1] - 8}" font-size="11" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(String(f.b1))}</text>`;
    out += `<text x="${(A[0] + D[0]) / 2}" y="${A[1] + 16}" font-size="11" text-anchor="middle" fill="${FIG_TEXT}">${escapeHtml(String(f.b2))}</text>`;
  }
  if (f.iso) { out += tickMark(A[0], A[1], B[0], B[1]) + tickMark(C[0], C[1], D[0], D[1]); }
  if (f.midline) {
    // Вычислено: середины боковых сторон.
    const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], N = [(C[0] + D[0]) / 2, (C[1] + D[1]) / 2];
    out += `<line x1="${M[0].toFixed(1)}" y1="${M[1].toFixed(1)}" x2="${N[0].toFixed(1)}" y2="${N[1].toFixed(1)}" stroke="${FIG_ACCENT}" stroke-width="1.7"/>`;
    out += `<text x="${(M[0] - 10).toFixed(1)}" y="${(M[1] + 4).toFixed(1)}" font-size="12" text-anchor="end" fill="${FIG_TEXT}">${escapeHtml(f.mLetters[0])}</text>`;
    out += `<text x="${(N[0] + 10).toFixed(1)}" y="${(N[1] + 4).toFixed(1)}" font-size="12" fill="${FIG_TEXT}">${escapeHtml(f.mLetters[1])}</text>`;
    if (f.given) {
      out += `<text x="${((M[0] + N[0]) / 2).toFixed(1)}" y="${((M[1] + N[1]) / 2 - 7).toFixed(1)}" font-size="11" text-anchor="middle" fill="${FIG_ACCENT}">${escapeHtml(String((f.b1 + f.b2) / 2))}</text>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Чертёж: трапеция">${out}</svg>`;
}


// Экспорт для Node-канарейки (в браузере module не определён — пропускается).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { escapeHtml, graphNumber, graphYWindow, graphNiceStep, graphIntersections, graphSvg, circlesSvg, numberlineSvg, drawingSvg, figPoint, angleArc, angleText, figDeg, adjacentAnglesSvg, verticalAnglesSvg, parallelLinesSvg, tickMark, figDir, triangleSvg, quadShell, parallelogramSvg, rhombusSvg, trapezoidSvg };
}
