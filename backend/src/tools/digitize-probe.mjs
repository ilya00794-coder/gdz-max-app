// ПРОБА ОЦИФРОВКИ (стенд): первый PDF из ~/gdz-books → 8 страниц из середины →
// qwen3-vl-plus извлекает задачи структурой → SymPy-проверка эталонов.
// Выход: scratchpad/digitize-probe.json + агрегаты в stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const SB = process.env.SB;
const BOOKS = path.join(os.homedir(), "gdz-books");
const pdfs = fs.readdirSync(BOOKS).filter((f) => f.toLowerCase().endsWith(".pdf"));
if (!pdfs.length) { console.error("нет PDF в ~/gdz-books"); process.exit(2); }
const pdf = path.join(BOOKS, pdfs[0]);
console.log("книга:", pdfs[0]);

// текстовый слой?
let textLayer = "";
try { textLayer = execFileSync("pdftotext", ["-f", "20", "-l", "22", pdf, "-"], { timeout: 30000 }).toString(); } catch {}
console.log("текстовый слой:", textLayer.trim().length > 200 ? `ЕСТЬ (~${textLayer.trim().length} симв. на 3 стр.)` : "нет/скан");

// страницы: 8 из середины
const pages = execFileSync("pdfinfo", [pdf]).toString().match(/Pages:\s+(\d+)/)?.[1] ?? "?";
console.log("страниц:", pages);
const mid = Math.max(1, Math.floor(Number(pages) / 2) - 4);
const dir = path.join(SB, "digitize-pages");
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
execFileSync("pdftoppm", ["-png", "-r", "150", "-f", String(mid), "-l", String(mid + 7), pdf, path.join(dir, "p")], { timeout: 120000 });
const pngs = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
console.log(`отрендерено: ${pngs.length} стр. (с ${mid}-й)`);

const KEY = process.env.QWEN_API_KEY;
const SCHEMA = { type: "object", additionalProperties: false, required: ["pageKind", "tasks"],
  properties: {
    pageKind: { type: "string", enum: ["tasks", "answers", "solutions", "theory", "toc", "other"] },
    tasks: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["number", "condition", "answer", "steps"],
      properties: {
        number: { type: "string" }, condition: { type: "string" },
        answer: { type: ["string", "null"] },
        steps: { type: ["array", "null"], items: { type: "string" } } } } } } };
async function extract(png) {
  const b64 = fs.readFileSync(png).toString("base64");
  const r = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(180000),
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({ model: "qwen3-vl-plus", max_tokens: 8000,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/png;base64," + b64 } },
        { type: "text", text: "Это страница задачника. Извлеки ВСЕ задачи с этой страницы структурой через инструмент page. Условия и решения переписывай ТОЧНО, формулы в LaTeX $...$. Если это страница ответов — pageKind=answers и заполни number+answer. Ничего не решай сам и не выдумывай." } ] }],
      tools: [{ type: "function", function: { name: "page", parameters: SCHEMA } }], tool_choice: "auto" }) });
  const j = await r.json();
  const tc = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) return { error: "нет tool_call: " + JSON.stringify(j).slice(0, 120) };
  try { return JSON.parse(tc.function.arguments); } catch { return { error: "arguments не JSON" }; }
}
const out = [];
for (const p of pngs) {
  const r = await extract(path.join(dir, p));
  out.push({ page: p, ...r });
  console.log(`${p}: ${r.error ? "❌ " + r.error : `${r.pageKind}, задач: ${r.tasks?.length ?? 0}`}`);
}
fs.writeFileSync(path.join(SB, "digitize-probe.json"), JSON.stringify(out, null, 1));
const tasks = out.flatMap((o) => o.tasks ?? []);
console.log(`\nИТОГО извлечено задач: ${tasks.length} с ${pngs.length} страниц`);
console.log(`с ответом: ${tasks.filter((t) => t.answer).length}; с шагами: ${tasks.filter((t) => t.steps?.length).length}`);
console.log(`Сохранено: ${path.join(SB, "digitize-probe.json")} — дальше SymPy-сверка эталонов`);
