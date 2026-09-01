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
