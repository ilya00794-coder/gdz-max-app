// Движок сечений многогранников (этап 3 чертежей, 07.09.2026).
//
// Модель НЕ рисует форму: она называет ТРИ точки на рёбрах («K на AD,
// AK:KD=1:2»), полигон вычисляется здесь детерминированно — плоскость
// через точки ∩ рёбра солида. Все солиды ВЫПУКЛЫ, поэтому сечение —
// выпуклый замкнутый полигон ТЕОРЕМОЙ; алгоритмическое звено — только
// ПОРЯДОК обхода, и он страхуется проверкой выпуклости: нарушение = БАГ
// ДВИЖКА (EngineBugError, канарейка падает, показ невозможен), а не
// reject входа.
//
// Чистая числовая геометрия (float, EPS): входного кода нет — только
// числа из провалидированной структуры, AST/песочница не нужны.

const EPS = 1e-9;

// Канонические солиды. Раскладка букв согласована с моделями этапа 2
// (A — фронт-лево-низ, глубина от фронта, верхний этаж с ₁).
const S3 = Math.sqrt(3);
export const SOLIDS = {
  cube: {
    verts: {
      A: [0, 0, 0], B: [1, 0, 0], C: [1, 1, 0], D: [0, 1, 0],
      "A₁": [0, 0, 1], "B₁": [1, 0, 1], "C₁": [1, 1, 1], "D₁": [0, 1, 1],
    },
    edges: [["A","B"],["B","C"],["C","D"],["D","A"],["A₁","B₁"],["B₁","C₁"],["C₁","D₁"],["D₁","A₁"],["A","A₁"],["B","B₁"],["C","C₁"],["D","D₁"]],
  },
  tetrahedron: {
    verts: { A: [0, 0, 0], B: [1, 0, 0], C: [0.5, S3 / 2, 0], D: [0.5, S3 / 6, Math.sqrt(2 / 3)] },
    edges: [["A","B"],["B","C"],["C","A"],["D","A"],["D","B"],["D","C"]],
  },
  pyramid4: {
    verts: { A: [0, 0, 0], B: [1, 0, 0], C: [1, 1, 0], D: [0, 1, 0], S: [0.5, 0.5, 1.1] },
    edges: [["A","B"],["B","C"],["C","D"],["D","A"],["S","A"],["S","B"],["S","C"],["S","D"]],
  },
  prism3: {
    verts: { A: [0, 0, 0], B: [1, 0, 0], C: [0.5, S3 / 2, 0], "A₁": [0, 0, 1.2], "B₁": [1, 0, 1.2], "C₁": [0.5, S3 / 2, 1.2] },
    edges: [["A","B"],["B","C"],["C","A"],["A₁","B₁"],["B₁","C₁"],["C₁","A₁"],["A","A₁"],["B","B₁"],["C","C₁"]],
  },
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/** Баг алгоритма обхода (не входных данных): наружу как исключение. */
export class EngineBugError extends Error {}

/**
 * @param {string} solid - ключ SOLIDS
 * @param {{name:string,u:string,v:string,ratio:[number,number]}[]} points -
 *   ровно три точки: на ребре u-v, u→точка : точка→v = ratio[0]:ratio[1]
 *   (ratio [0,k] — точка в вершине u).
 * @returns {{ok:true, polygon:{name:string|null,p:number[]}[]} | {ok:false, reason:string}}
 */
export function computeSection(solid, points) {
  const def = SOLIDS[solid];
  if (!def) return { ok: false, reason: `неизвестный многогранник «${solid}»` };
  if (!Array.isArray(points) || points.length !== 3) return { ok: false, reason: `нужно ровно 3 точки, получено ${points?.length}` };

  const edgeSet = new Set(def.edges.map(([u, v]) => [u, v].sort().join("|")));
  const given = [];
  for (const pt of points) {
    const { name, u, v, ratio } = pt;
    if (!def.verts[u] || !def.verts[v] || !edgeSet.has([u, v].sort().join("|"))) {
      return { ok: false, reason: `«${u}–${v}» — не ребро (${solid})` };
    }
    const [au, av] = ratio ?? [];
    if (!Number.isFinite(au) || !Number.isFinite(av) || au < 0 || av < 0 || au + av <= 0) {
      return { ok: false, reason: `точка ${name}: отношение ${au}:${av} некорректно` };
    }
    const t = au / (au + av); // 0 = в вершине u, 1 = в вершине v
    given.push({ name, p: add(def.verts[u], mul(sub(def.verts[v], def.verts[u]), t)) });
  }

  // Плоскость по трём точкам.
  const n = cross(sub(given[1].p, given[0].p), sub(given[2].p, given[0].p));
  if (norm(n) < EPS) return { ok: false, reason: "три точки коллинеарны — плоскость не определена" };

  // Пересечение плоскости с каждым ребром (включая вершины на плоскости).
  const raw = [];
  const pushUniq = (p, name = null) => {
    for (const q of raw) if (norm(sub(q.p, p)) < 1e-7) { if (name && !q.name) q.name = name; return; }
    raw.push({ p, name });
  };
  for (const [u, v] of def.edges) {
    const s1 = dot(n, sub(def.verts[u], given[0].p));
    const s2 = dot(n, sub(def.verts[v], given[0].p));
    if (Math.abs(s1) < EPS) pushUniq(def.verts[u], u);
    if (Math.abs(s2) < EPS) pushUniq(def.verts[v], v);
    if (s1 * s2 < -EPS * EPS) {
      const t = s1 / (s1 - s2);
      pushUniq(add(def.verts[u], mul(sub(def.verts[v], def.verts[u]), t)));
    }
  }
  // Имена заданных точек — на свои вершины полигона.
  for (const g of given) {
    for (const q of raw) if (norm(sub(q.p, g.p)) < 1e-7) q.name = q.name ?? g.name;
  }
  if (raw.length < 3) return { ok: false, reason: `плоскость даёт ${raw.length} точек — сечения нет` };

  // Порядок обхода: угол вокруг центроида в базисе плоскости.
  const cN = mul(n, 1 / norm(n));
  let e1 = cross(cN, Math.abs(cN[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  e1 = mul(e1, 1 / norm(e1));
  const e2 = cross(cN, e1);
  const c = mul(raw.reduce((s, q) => add(s, q.p), [0, 0, 0]), 1 / raw.length);
  const ang = (q) => Math.atan2(dot(sub(q.p, c), e2), dot(sub(q.p, c), e1));
  const polygon = [...raw].sort((a, b) => ang(a) - ang(b));

  // ГАРАНТИЯ ОБХОДА (требование Ильи): сечение выпуклого солида выпукло
  // теоремой — если после сортировки полигон не выпуклый, это баг движка.
  const m = polygon.length;
  let sign = 0;
  for (let i = 0; i < m; i++) {
    const a = polygon[i].p, b = polygon[(i + 1) % m].p, d = polygon[(i + 2) % m].p;
    const z = dot(cN, cross(sub(b, a), sub(d, b)));
    if (Math.abs(z) < EPS) continue; // коллинеарный стык (вершина солида на плоскости)
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) {
      throw new EngineBugError(`обход дал невыпуклый полигон (${m} вершин, солид ${solid}) — баг сортировки, не входа`);
    }
  }
  return { ok: true, polygon };
}
