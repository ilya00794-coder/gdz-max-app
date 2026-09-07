// Юнит-канарейка данные→SVG для webapp/svg-figures.js.
//
// Раньше все фигуры проверялись только глазами Ильи с телефона. Здесь —
// детерминированный прогон всех 11 kind (части 1–4 + группа Б) плюс график
// на фиксированных входах: проверяем, что каждая функция даёт непустой
// валидный <svg> без undefined/NaN в разметке. Тот же прогон служит
// РЕГРЕССИЕЙ: сравнение вывода до/после выноса блока побайтно.
//
// Запуск: node backend/src/tools/svg-canary.mjs <путь-к-svg-модулю>
//   (без аргумента — webapp/svg-figures.js относительно корня проекта)

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const target = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(ROOT, "webapp/svg-figures.js");

const svg = require(target);

// Фиксированные входы — по одному-два на каждый тип, ветки задеты осознанно.
const CASES = [
  ["graph:парабола", () => svg.graphSvg({
    plots: [{
      xRange: [-3, 3],
      points: Array.from({ length: 25 }, (_, i) => { const x = -3 + i * 0.25; return [x, x * x - 1]; }),
      zeros: [-1, 1],
      extrema: [{ x: 0, y: -1, kind: "min" }],
      asymptotes: { vertical: [], horizontal: [] },
    }],
  })],
  ["graph:система-2-прямые", () => svg.graphSvg({
    plots: [
      { xRange: [-2, 4], points: Array.from({ length: 25 }, (_, i) => { const x = -2 + i * 0.25; return [x, x]; }), zeros: [0], extrema: [], asymptotes: { vertical: [], horizontal: [] } },
      { xRange: [-2, 4], points: Array.from({ length: 25 }, (_, i) => { const x = -2 + i * 0.25; return [x, 2 - x]; }), zeros: [2], extrema: [], asymptotes: { vertical: [], horizontal: [] } },
    ],
  })],
  ["circles", () => svg.circlesSvg({ circlesTotal: 12, circlesCrossed: 5, circlesGroupSize: 3 })],
  ["numberline", () => svg.numberlineSvg({ points: [{ value: 2, label: "a" }, { value: 5, label: "b" }], range: [0, 7] })],
  ["rectangle", () => svg.drawingSvg({ kind: "rectangle", width: 6, height: 4, widthLabel: "6 см", heightLabel: "4 см" })],
  ["square", () => svg.drawingSvg({ kind: "square", side: 5, sideLabel: "5 см" })],
  ["adjacent-angles", () => svg.adjacentAnglesSvg({ right: 55, left: 125, letters: ["A", "O", "B", "C"] })],
  ["vertical-angles", () => svg.verticalAnglesSvg({ angle: 50, names: ["∠1", "∠2", "∠3", "∠4"] })],
  ["parallel-lines", () => svg.parallelLinesSvg({ angle: 50, pair: "alternate", names: ["a", "b", "c"] })],
  ["triangle:углы", () => svg.triangleSvg({ angles: [60, 60, 60], vertices: ["A", "B", "C"], equalSides: [], elements: [] })],
  ["triangle:стороны+высота", () => svg.triangleSvg({ sides: [5, 6, 7], vertices: ["A", "B", "C"], equalSides: [[0, 1]], elements: [{ type: "height", from: 1, foot: "H" }] })],
  ["parallelogram", () => svg.parallelogramSvg({ angle: 62, vertices: ["A", "B", "C", "D"], diagonals: true, oLetter: "O" })],
  ["rhombus", () => svg.rhombusSvg({ d1: 8, d2: 6, vertices: ["A", "B", "C", "D"], oLetter: "O", given: true })],
  ["trapezoid", () => svg.trapezoidSvg({ b1: 4, b2: 8, iso: true, given: true, midline: true, vertices: ["A", "B", "C", "D"], mLetters: ["M", "N"] })],
];

let failed = 0;
// Окружности (этап 1б, 06.09) — валид + дефолтная ветка каждого kind.
CASES.push(
  ["circle-angles:40°", () => svg.circleAnglesSvg({ inscribed: 40, labels: ["O","A","B","C"], hasValue: true })],
  ["circle-angles:дефолт", () => svg.circleAnglesSvg({ inscribed: 40, labels: ["O","A","B","C"], hasValue: false })],
  ["circle-chord:R4-хорда6", () => svg.circleChordSvg({ radius: 4, chord: 6, labels: ["O","A","B"], hasValue: true })],
  ["circle-chord:дефолт", () => svg.circleChordSvg({ radius: 1, chord: 1.3, labels: ["O","A","B"], hasValue: false })],
  ["circle-tangent:R3-d5", () => svg.circleTangentSvg({ radius: 3, distance: 5, labels: ["O","A","K"], hasValue: true })],
  ["circle-tangent:дефолт", () => svg.circleTangentSvg({ radius: 1, distance: 1.8, labels: ["O","A","K"], hasValue: false })],
  ["triangle-circle:вписанная", () => svg.triangleCircleSvg({ mode: "in", angles: [46,72,62], vertices: ["A","B","C"], hasValue: false })],
  ["triangle-circle:описанная", () => svg.triangleCircleSvg({ mode: "circum", angles: [50,68,62], vertices: ["A","B","C"], hasValue: true })],
);

// Стереометрия (этап 2, 07.09).
CASES.push(
  ["cube:ребро-2", () => svg.box3dSvg({ shape: "cube", edges: [2,2,2], vertices: ["A","B","C","D","A₁","B₁","C₁","D₁"], hasValue: true })],
  ["box:дефолт", () => svg.box3dSvg({ shape: "box", edges: [1.6,1,0.75], vertices: ["A","B","C","D","A₁","B₁","C₁","D₁"], hasValue: false })],
  ["pyramid:четырёхугольная", () => svg.pyramidSvg({ baseN: 4, side: 2, height: 2.2, vertices: ["S","A","B","C","D"], hasValue: true })],
  ["pyramid:тетраэдр-дефолт", () => svg.pyramidSvg({ baseN: 3, side: 1, height: 1.1, vertices: ["S","A","B","C"], hasValue: false })],
  ["prism:дефолт", () => svg.prismSvg({ side: 1, height: 1.3, vertices: ["A","B","C","A₁","B₁","C₁"], hasValue: false })],
);

// Сечения (этап 3, 07.09): полигоны — из живого движка (детерминированы).
const { computeSection } = await import("../services/section.js");
const secOf = (solid, pts) => { const r = computeSection(solid, pts); if (!r.ok) throw new Error(r.reason); return r.polygon; };
CASES.push(
  ["section:куб-шестиугольник", () => svg.sectionSvg({ solid: "cube", polygon: secOf("cube", [
    { name: "K", u: "B", v: "C", ratio: [1,1] }, { name: "M", u: "C", v: "D", ratio: [1,1] }, { name: "N", u: "D", v: "D₁", ratio: [1,1] }]) })],
  ["section:куб-треугольник", () => svg.sectionSvg({ solid: "cube", polygon: secOf("cube", [
    { name: "K", u: "A", v: "B", ratio: [1,1] }, { name: "M", u: "A", v: "D", ratio: [1,1] }, { name: "N", u: "A", v: "A₁", ratio: [1,1] }]) })],
  ["section:тетраэдр", () => svg.sectionSvg({ solid: "tetrahedron", polygon: secOf("tetrahedron", [
    { name: "K", u: "D", v: "A", ratio: [1,2] }, { name: "M", u: "D", v: "B", ratio: [1,1] }, { name: "N", u: "D", v: "C", ratio: [1,1] }]) })],
  ["section:призма", () => svg.sectionSvg({ solid: "prism3", polygon: secOf("prism3", [
    { name: "K", u: "A", v: "A₁", ratio: [1,1] }, { name: "M", u: "B", v: "B₁", ratio: [1,2] }, { name: "N", u: "C", v: "C₁", ratio: [2,1] }]) })],
);

for (const [name, run] of CASES) {
  let out;
  try { out = run(); } catch (err) { console.log(`FAIL ${name}: исключение ${err.message}`); failed++; continue; }
  const problems = [];
  if (typeof out !== "string" || !out) problems.push("пустой/не строка");
  else {
    if (!out.startsWith("<svg")) problems.push("не начинается с <svg");
    if (!out.trimEnd().endsWith("</svg>")) problems.push("не кончается </svg>");
    if (/undefined|NaN/.test(out)) problems.push("содержит undefined/NaN");
  }
  const sha = crypto.createHash("sha256").update(out ?? "").digest("hex").slice(0, 12);
  if (problems.length) { console.log(`FAIL ${name}: ${problems.join(", ")}`); failed++; }
  else console.log(`ok   ${name}  len=${String(out.length).padStart(4)}  sha=${sha}`);
}

console.log(failed ? `\nПРОВАЛ: ${failed} из ${CASES.length}` : `\nвсе ${CASES.length} чисто`);
process.exit(failed ? 1 : 0);
