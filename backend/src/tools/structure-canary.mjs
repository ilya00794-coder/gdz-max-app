// Канарейка структуры шагов solver (пробелы №2-4 из prompt-gaps-report).
// node --env-file=.env src/tools/structure-canary.mjs — ~15 вызовов Opus, ~$0.4.
//
// ВАЖНО про регэкспы: банится только КАНЦЕЛЯРСКИЙ шаблон — заголовки
// «Что дано», «Что известно», «Что нужно найти» и голый шаг «Проверка».
// «Проверяем хлопками» и другие предметные приёмы самопроверки — желаемое
// поведение (их просил судья замера), они НЕ ошибка. Первый вариант этой
// канарейки банил слово «провер*» целиком и дал ложный FAIL.

import { solveTask } from "../services/solver.js";
import fs from "node:fs";

const load = (f) => JSON.parse(fs.readFileSync(new URL(`../../${f}`, import.meta.url)));
const byId = {};
for (const g of ["1", "2", "3", "5", "7"]) for (const t of load(`eval-data/prompt-gaps/tasks-g${g}.json`)) byId[t.id] = t;
for (const t of load("eval-data/model-compare/tasks.json")) byId[t.id] = t;

const BAN_TITLE = /^(что дано|что известно|что (нужно|требуется) найти)/i;
const BARE_CHECK_TITLE = /^провер(ка|им|яем)?[\s:]*$/i; // голая «Проверка» без предметного приёма

const oral = [
  ["pg1-rus-1", ["три", "3"]], ["pg1-rus-5", ["4"]], ["pg1-lit-1", ["мышк"]],
  ["pg2-rus-3", ["дубы"]], ["pg2-lit-4", ["пела", "лето"]], ["pg3-rus-4", ["женск"]],
  ["pg3-lit-2", ["олицетворени"]], ["pg5-his-5", ["оседл", "выращива", "запас"]],
  ["pg5-geo-3", ["глобус"]], ["pg5-bio-4", ["фотосинтез", "сами", "готов"]],
];
const multiCause = { id: "multi-1", grade: 7, subject: "История",
  task: "Назовите основные причины Смутного времени в России. Объясните каждую." };
const CAUSE_KEYS = ["династ", "голод", "неурожа", "боярск", "самозван", "опричнин", "хозяйствен", "крестьян", "власт"];
const comput = ["g8-01", "g5-03", "g9-06", "pg7-fiz-4"];

const jobs = [
  ...oral.map(([id, keys]) => ({ task: byId[id], keys, kind: "oral" })),
  { task: multiCause, kind: "multi" },
  ...comput.map((id) => ({ task: byId[id], kind: "comp" })),
];
const done = {};
async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    done[job.task.id] = { job, s: await solveTask({ recognizedText: job.task.task, grade: job.task.grade, subject: job.task.subject }) };
    console.error(".", job.task.id);
  }
}
await Promise.all([worker(), worker(), worker()]);

let fails = 0;
for (const [id] of oral) {
  const { job, s } = done[id];
  const first = (s.steps[0].title + " " + s.steps[0].content).toLowerCase();
  const banned = s.steps.some((x) => BAN_TITLE.test(x.title.trim()) || BARE_CHECK_TITLE.test(x.title.trim()));
  const answerFirst = job.keys.some((k) => first.includes(k));
  if (banned || !answerFirst) fails++;
  console.log(`${banned ? "FAIL шаблон" : "ok  "} | ${answerFirst ? "ответ в 1-м шаге" : "FAIL ответ не в 1-м"} | ${id}: ${s.steps.map((x) => x.title).join(" | ").slice(0, 80)}`);
}
const m = done["multi-1"];
const firstStep = (m.s.steps[0].title + " " + m.s.steps[0].content).toLowerCase();
const hits = CAUSE_KEYS.filter((k) => firstStep.includes(k));
if (hits.length < 2) fails++;
console.log(`${hits.length >= 2 ? "ok  " : "FAIL"} | multi-1: причин в 1-м шаге ${hits.length}`);
for (const id of comput) {
  const { s } = done[id];
  const firstOk = /дано|условие|разбор/i.test(s.steps[0].title + s.steps[0].content);
  const checkOk = /провер/i.test(s.steps.slice(-2).map((x) => x.title + x.content).join(" "));
  const math = /\$[^$]+\$/.test(s.steps.map((x) => x.content).join(""));
  if (!firstOk || !checkOk || !math) fails++;
  console.log(`${firstOk && checkOk && math ? "ok  " : "FAIL"} | ${id}: разбор=${firstOk} проверка=${checkOk} формулы=${math}`);
}
console.log(fails ? `ИТОГ: ${fails} провалов` : "ИТОГ: все проверки прошли");
process.exit(fails ? 1 : 0);
