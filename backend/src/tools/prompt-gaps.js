// Замер систематических пробелов промпта по всем (класс, предмет).
//
// npm run prompt-gaps <класс>       — прогнать eval-data/prompt-gaps/tasks-g<N>.json
//
// Для каждой задачи: solveTask двумя моделями (продовый промпт и curriculum,
// воркеры model-compare.js), затем судья (Opus, вслепую — не знает, чья работа):
//   - верен ли финальный ответ (для задач с sympy правду говорит SymPy, судья —
//     только для несверяемых; конфликты SymPy/судья логируются);
//   - чего структурно не хватает школьнику ЭТОГО класса для понимания;
//   - что лишнее (методы старше класса, избыточная строгость).
//
// Честно: «чего не хватает» — субъективная оценка модели, не измерение.
// Правильность — нижняя оценка: эталоны собственные, могут содержать ошибки.
//
// Формат задач: {id, grade, subject, topic, task, answer, reference,
//   confidence: "уверен"|"сомневаюсь", sympy: string|null}.
// Задачи с confidence "сомневаюсь" помечаются в отчёте и исключаются из выводов.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { answersMatch } from "./model-compare.js";
import * as verifyHelpers from "../services/verify.js";
import { getClient } from "../services/anthropicClient.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "../../eval-data/prompt-gaps");
// PG_MODELS=claude-opus-5 — прогон одной моделью (контрольный замер эффекта
// правок промпта: модели не сравниваем, меряем сам промпт).
const MODELS = (process.env.PG_MODELS || "claude-opus-5,claude-haiku-4-5").split(",");
const JUDGE_MODEL = "claude-opus-5";
const JUDGE_CONCURRENCY = 3;

// Воркер — тот же, что в model-compare (он читает только id/grade/subject/task).
function runWorker(model, tasksFile) {
  return new Promise((resolve, reject) => {
    const worker = path.join(HERE, "model-compare.js");
    const child = spawn(process.execPath, [worker, "--worker", model, tasksFile], {
      env: { ...process.env, SOLVER_MODEL: model },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
      if (code !== 0 || !line) return reject(new Error(`воркер ${model} завершился с кодом ${code}`));
      resolve(JSON.parse(line.slice("RESULT_JSON:".length)));
    });
  });
}

const JudgeSchema = z.object({
  answerCorrect: z
    .enum(["верен", "неверен", "неясно"])
    .describe("Совпадает ли финальный ответ решения с эталонным по смыслу (форма записи не важна)."),
  missingForAge: z
    .array(z.string())
    .describe(
      "Чего СТРУКТУРНО не хватает в решении школьнику именно этого класса для понимания: например, нет проверки, нет наименования в ответе, нет опоры на правило, нет рисунка/схемы там, где ребёнку она нужна. Пусто, если ничего. Формулировать коротко и обобщённо."
    ),
  excessive: z
    .array(z.string())
    .describe(
      "Что в решении лишнее для этого класса: методы и термины старших классов, избыточная строгость, взрослые формулировки. Пусто, если ничего."
    ),
  blockFit: z
    .string()
    .describe(
      "Если в решении видны специальные предметные приёмы — буквенные обозначения и словесное " +
        "описание конфигурации в геометрии, единицы и проверка размерности в физике, произношение " +
        "слов в английском, опора на текст произведения, ограничение объёма ответа — оцени одним-двумя " +
        "предложениями, помогают ли они на ЭТОМ уровне сложности или выглядят неуместно/мешают. " +
        "Если таких приёмов не видно — пустая строка."
    ),
  comment: z.string().describe("Итог одним-двумя предложениями."),
});

const JUDGE_SYSTEM = `Ты — опытный методист начальной и средней школы. Тебе показывают задачу,
собственный эталонный ответ составителя (с кратким разбором) и решение, которое приложение
показало ученику. Ты НЕ знаешь, какая система его написала, и не должен догадываться.

Оцени решение глазами ученика указанного класса и его родителя:
1. Верен ли финальный ответ по смыслу (сравни с эталонным; форма записи не важна).
2. Чего структурно не хватает, чтобы ученик ЭТОГО возраста понял решение.
3. Что лишнее: методы/термины старше класса, избыточная строгость.
Будь конкретен и краток. Не переписывай решение, только оценивай.`;

// Предметные акценты судьи (запрос пользователя, 7 класс): геометрия без
// чертежа и единицы измерения в физике.
const SUBJECT_FOCUS = {
  "ОРКСЭ":
    "ОСОБОЕ ВНИМАНИЕ, два вопроса. (1) НЕЙТРАЛЬНОСТЬ: изложение должно объяснять и описывать, " +
    "а не проповедовать — решение не должно утверждать истинность какого-либо вероучения или " +
    "склонять к нему. (2) ГОЛОС: изложение идёт ОТ ЛИЦА ВЕРУЮЩЕГО («мы празднуем», «наш пророк», " +
    "«наша вера») или описательно («в православии принято», «мусульмане считают»)? Первое — дефект: " +
    "модель присваивает ребёнку религиозную принадлежность, которой может не быть. Оба наблюдения фиксируй. " +
    "(3) ЧИТАЕМОСТЬ: не стало ли оговорок-атрибуций («по учению…», «верят, что…») так много, " +
    "что текст трудно читать четверокласснику? Избыток фиксируй в excessive.",
  "Окружающий мир":
    "ОСОБОЕ ВНИМАНИЕ: если задание требует НАБЛЮДЕНИЯ, личного ответа или зависит от места " +
    "(твой край, твоя семья, погода за окном) — проверь, не подменяет ли решение наблюдение " +
    "ГОТОВЫМ ВЫДУМАННЫМ ответом (конкретный список птиц у кормушки, конкретная сегодняшняя погода). " +
    "Честное решение объясняет, КАК выполнить наблюдение, и говорит, что ответ у каждого свой. " +
    "Подмену наблюдения выдумкой фиксируй отдельно в missingForAge.",
  "Геометрия":
    "ОСОБОЕ ВНИМАНИЕ: ученик НЕ видит чертежа. Оцени, понятно ли решение БЕЗ него: " +
    "можно ли из одного текста однозначно понять, о каком угле, какой стороне, какой точке идёт речь. " +
    "Если текст без чертежа неоднозначен — обязательно запиши это в missingForAge с конкретным местом.",
  "Физика":
    "ОСОБОЕ ВНИМАНИЕ: единицы измерения. У каждой ли величины они написаны, показан ли перевод единиц " +
    "(км/ч → м/с, г → кг, см² → м²), есть ли проверка размерности финального ответа. " +
    "Отсутствие любого из этого — в missingForAge.",
};

async function judge(task, solution) {
  const client = getClient();
  const stepsText = (solution.steps ?? [])
    .map((s, i) => `${i + 1}. ${s.title}\n${s.content}`)
    .join("\n\n");
  const response = await client.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { format: zodOutputFormat(JudgeSchema, "judgement") },
    messages: [
      {
        role: "user",
        content: `Класс: ${task.grade}\nПредмет: ${task.subject}\nТема: ${task.topic}

УСЛОВИЕ:
${task.task}

ЭТАЛОННЫЙ ОТВЕТ СОСТАВИТЕЛЯ: ${task.answer}
КРАТКИЙ ЭТАЛОННЫЙ РАЗБОР: ${task.reference}

РЕШЕНИЕ, ПОКАЗАННОЕ УЧЕНИКУ:
${stepsText}

ФИНАЛЬНЫЙ ОТВЕТ РЕШЕНИЯ: ${solution.finalAnswer}${SUBJECT_FOCUS[task.subject] ? "\n\n" + SUBJECT_FOCUS[task.subject] : ""}`,
      },
    ],
  });
  return response.parsed_output;
}

async function pool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, pump));
  return results;
}

async function main() {
  const gradeArg = process.argv[2];
  if (!gradeArg) {
    console.error("Использование: npm run prompt-gaps <класс 1-11>");
    process.exit(1);
  }
  const tasksFile = path.join(DATA_DIR, `tasks-g${gradeArg}.json`);
  const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
  console.error(`Класс ${gradeArg}: задач ${tasks.length}; solver ×2 модели, судья ${JUDGE_MODEL}.\n`);

  // Чекпойнт solver-фазы: решения пишутся на диск сразу, как получены.
  // Урок 7 класса: судейство упало по таймауту, и оплаченные 110 решений
  // пропали — теперь при рестарте solver не перезапускается.
  const checkpointFile = path.join(DATA_DIR, `solver-checkpoint-g${gradeArg}.json`);
  let byModel;
  if (fs.existsSync(checkpointFile)) {
    byModel = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
    const complete = MODELS.every((m) => (byModel[m] ?? []).length === tasks.length);
    if (complete) {
      console.error(`Найден чекпойнт solver-фазы (${checkpointFile}) — решатели НЕ перезапускаются.`);
    } else {
      byModel = null;
    }
  }
  if (!byModel) {
    const workerResults = await Promise.all(MODELS.map((m) => runWorker(m, tasksFile)));
    byModel = Object.fromEntries(MODELS.map((m, i) => [m, workerResults[i]]));
    fs.writeFileSync(checkpointFile, JSON.stringify(byModel));
    console.error(`Чекпойнт solver-фазы записан: ${checkpointFile}`);
  }

  // Судейство: пары (задача, модель) — вперемешку, судья слеп к автору.
  const jobs = [];
  for (const task of tasks)
    for (const model of MODELS) jobs.push({ task, model, r: byModel[model].find((x) => x.id === task.id) });

  let done = 0;
  const judged = await pool(
    jobs,
    async (job) => {
      let verdict = null;
      if (!job.r.error) {
        // Одна повторная попытка: structured output изредка падает на парсинге
        // (оборванная JSON-строка) — на 3 классе это стоило одного вердикта.
        try {
          verdict = await judge(job.task, job.r.solution);
        } catch {
          try {
            verdict = await judge(job.task, job.r.solution);
          } catch (err) {
            verdict = { judgeError: err.message };
          }
        }
      }
      // Для sympy-задач правильность решает SymPy по эталону, не судья.
      let sympyCorrect = null;
      if (job.task.sympy !== null && !job.r.error) {
        const m = await answersMatch(job.r.finalAnswer, job.task.sympy, verifyHelpers);
        sympyCorrect = m.match;
      }
      done++;
      console.error(`  судья: ${done}/${jobs.length}`);
      return { ...job, verdict, sympyCorrect };
    },
    JUDGE_CONCURRENCY
  );

  // ---------- сводка ----------
  const isCorrect = (j) =>
    j.r.error ? false : j.sympyCorrect !== null ? j.sympyCorrect : j.verdict?.answerCorrect === "верен";

  console.log(`\n===== КЛАСС ${gradeArg}: сводка (${tasks.length} задач × 2 модели) =====`);
  const subjects = [...new Set(tasks.map((t) => t.subject))];
  for (const subject of subjects) {
    const line = MODELS.map((model) => {
      const js = judged.filter((j) => j.task.subject === subject && j.model === model);
      const ok = js.filter(isCorrect).length;
      return `${model.includes("opus") ? "opus" : "haiku"} ${ok}/${js.length}`;
    }).join("   ");
    console.log(`  ${subject.padEnd(22)} ${line}`);
  }

  const doubtful = tasks.filter((t) => t.confidence !== "уверен");
  if (doubtful.length) console.log(`\nСомнительные эталоны (исключить из выводов): ${doubtful.map((t) => t.id).join(", ")}`);

  const conflicts = judged.filter(
    (j) => j.sympyCorrect !== null && j.verdict?.answerCorrect && (j.verdict.answerCorrect === "верен") !== j.sympyCorrect
  );
  if (conflicts.length)
    console.log(`\nКонфликты SymPy/судья: ${conflicts.map((j) => `${j.task.id}(${j.model})`).join(", ")}`);

  console.log("\n--- чего не хватает (судья, по задачам) ---");
  for (const j of judged) {
    for (const m of j.verdict?.missingForAge ?? [])
      console.log(`  [${j.task.id} ${j.model.includes("opus") ? "opus" : "haiku"}] ${m}`);
  }
  console.log("\n--- лишнее (судья, по задачам) ---");
  for (const j of judged) {
    for (const m of j.verdict?.excessive ?? [])
      console.log(`  [${j.task.id} ${j.model.includes("opus") ? "opus" : "haiku"}] ${m}`);
  }

  const wrong = judged.filter((j) => !isCorrect(j));
  console.log(`\n--- неверные/ошибки (${wrong.length}) ---`);
  for (const j of wrong)
    console.log(
      `  ${j.task.id} ${j.model}: «${j.r.error ?? j.r.finalAnswer}» (эталон: «${j.task.answer}»)${j.verdict?.comment ? " — " + j.verdict.comment : ""}`
    );

  const dump = path.join(DATA_DIR, `last-run-g${gradeArg}.json`);
  fs.writeFileSync(
    dump,
    JSON.stringify(judged.map(({ task, model, r, verdict, sympyCorrect }) => ({ task, model, r, verdict, sympyCorrect })), null, 2)
  );
  console.log(`\nПолный дамп: ${dump}`);
  fs.rmSync(checkpointFile, { force: true }); // прогон завершён — чекпойнт больше не нужен
}

main().catch((err) => {
  console.error("prompt-gaps не удался:", err.message);
  process.exit(1);
});
