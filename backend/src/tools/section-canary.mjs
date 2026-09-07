// Канарейка движка сечений (этап 3, 07.09): математические эталоны, посчитанные
// руками. ШЕСТИУГОЛЬНИК — обязательный тест обхода (сломается сортировка →
// звезда, стороны неравны). Запуск: node backend/src/tools/section-canary.mjs
import { computeSection } from "../services/section.js";
const eq = (a, b) => Math.abs(a - b) < 1e-7;
const eqP = (p, q) => eq(p[0], q[0]) && eq(p[1], q[1]) && eq(p[2], q[2]);
let fail = 0;
const ck = (cond, name) => { if (!cond) { fail++; console.log("FAIL:", name); } else console.log("ok  ", name); };

let r = computeSection("cube", [
  { name: "K", u: "A", v: "B", ratio: [1, 1] }, { name: "M", u: "A", v: "D", ratio: [1, 1] }, { name: "N", u: "A", v: "A₁", ratio: [1, 1] },
]);
ck(r.ok && r.polygon.length === 3 && [[0.5,0,0],[0,0.5,0],[0,0,0.5]].every((w) => r.polygon.some((q) => eqP(q.p, w))), "треугольник у вершины: точные координаты");

r = computeSection("cube", [
  { name: "K", u: "B", v: "C", ratio: [1, 1] }, { name: "M", u: "C", v: "D", ratio: [1, 1] }, { name: "N", u: "D", v: "D₁", ratio: [1, 1] },
]);
{
  const want = [[1,0.5,0],[0.5,1,0],[0,1,0.5],[0,0.5,1],[0.5,0,1],[1,0,0.5]];
  ck(r.ok && r.polygon.length === 6 && want.every((w) => r.polygon.some((q) => eqP(q.p, w))), "ШЕСТИУГОЛЬНИК: 6 середин рёбер");
  let sidesOk = true;
  for (let i = 0; i < 6; i++) {
    const a = r.polygon[i].p, b = r.polygon[(i + 1) % 6].p;
    if (!eq(Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]), Math.SQRT2 / 2)) sidesOk = false;
  }
  ck(sidesOk, "шестиугольник правильный: обход верен (не звезда)");
}
r = computeSection("cube", [
  { name: "K", u: "A", v: "B", ratio: [1, 1] }, { name: "M", u: "D", v: "C", ratio: [1, 1] }, { name: "N", u: "A₁", v: "B₁", ratio: [1, 1] },
]);
ck(r.ok && r.polygon.length === 4, "квадрат x=0.5: 4 вершины");

r = computeSection("tetrahedron", [
  { name: "D", u: "D", v: "A", ratio: [0, 1] }, { name: "K", u: "A", v: "B", ratio: [1, 1] }, { name: "M", u: "B", v: "C", ratio: [1, 1] },
]);
ck(r.ok && r.polygon.length === 3 && r.polygon.some((q) => q.name === "D"), "тетраэдр через вершину");

ck(!computeSection("cube", [{name:"K",u:"A",v:"C₁",ratio:[1,1]},{name:"M",u:"A",v:"B",ratio:[1,1]},{name:"N",u:"A",v:"D",ratio:[1,1]}]).ok, "не-ребро → reject");
ck(!computeSection("cube", [{name:"K",u:"A",v:"B",ratio:[1,3]},{name:"M",u:"A",v:"B",ratio:[1,1]},{name:"N",u:"A",v:"B",ratio:[3,1]}]).ok, "коллинеарные → reject");
ck(!computeSection("cube", [{name:"K",u:"A",v:"B",ratio:[-1,2]},{name:"M",u:"A",v:"D",ratio:[1,1]},{name:"N",u:"A",v:"A₁",ratio:[1,1]}]).ok, "отношение −1 → reject");
ck(computeSection("prism3", [{name:"K",u:"A",v:"B",ratio:[1,2]},{name:"M",u:"B",v:"C",ratio:[2,1]},{name:"N",u:"A",v:"A₁",ratio:[1,3]}]).ok, "призма косая: выпуклый обход");
ck(computeSection("pyramid4", [{name:"K",u:"S",v:"A",ratio:[1,1]},{name:"M",u:"S",v:"B",ratio:[1,2]},{name:"N",u:"S",v:"C",ratio:[2,1]}]).ok, "пирамида косая: выпуклый обход");

console.log(fail === 0 ? "\nвсе чисто" : `\nПРОВАЛ: ${fail}`);
process.exit(fail ? 1 : 0);
