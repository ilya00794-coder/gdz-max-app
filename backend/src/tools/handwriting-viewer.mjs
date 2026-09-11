// Вьювер аудита рукописи: npm run handwriting-viewer → ~/gdz-handwriting-audit/audit.html.
// Пары «фото — qwen-текст» рядом, цифры в тексте подсвечены (класс ошибок «7→4»).
// Открывается file:// локально, НИКУДА не хостится (приватность детских работ).

import fs from "node:fs";
import path from "node:path";
import { AUDIT_DIR } from "../services/handwritingAudit.js";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mark = (s) => esc(s).replace(/\d+(?:[.,]\d+)?/g, (m) => `<mark>${m}</mark>`);

const files = fs.existsSync(AUDIT_DIR) ? fs.readdirSync(AUDIT_DIR) : [];
const pairs = files.filter((f) => f.endsWith(".txt")).sort().reverse().map((t) => {
  const base = t.slice(0, -4);
  const imgs = files.filter((f) => f.startsWith(base) && f.endsWith(".jpg")).sort();
  return { base, txt: fs.readFileSync(path.join(AUDIT_DIR, t), "utf8"), imgs };
});

const rows = pairs.map(({ base, txt, imgs }) => `
<section>
  <h3>${esc(base)}</h3>
  <div class="pair">
    <div class="imgs">${imgs.map((i) => `<img src="${esc(i)}" loading="lazy">`).join("")}</div>
    <pre>${mark(txt)}</pre>
  </div>
</section>`).join("\n");

const html = `<!doctype html><meta charset="utf-8"><title>Аудит рукописи (${pairs.length})</title>
<style>
body{font:14px/1.5 -apple-system,sans-serif;margin:16px;background:#f6f6f6}
section{background:#fff;border-radius:10px;padding:12px 16px;margin-bottom:18px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h3{margin:0 0 8px;color:#666;font-size:13px}
.pair{display:flex;gap:16px;align-items:flex-start}
.imgs{flex:1;min-width:0}.imgs img{max-width:100%;border:1px solid #ddd;border-radius:6px;margin-bottom:8px}
pre{flex:1;min-width:0;white-space:pre-wrap;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:10px;margin:0}
mark{background:#ffe08a;padding:0 2px;border-radius:3px}
h1{font-size:18px}
</style>
<h1>Аудит рукописи: ${pairs.length} пар (сверять ЦИФРЫ на фото с подсветкой)</h1>
${rows || "<p>Пар пока нет — накопятся с трафиком (qwen-vision, рукописные типы).</p>"}`;

fs.mkdirSync(AUDIT_DIR, { recursive: true });
fs.writeFileSync(path.join(AUDIT_DIR, "audit.html"), html);
console.log(`Готово: ${path.join(AUDIT_DIR, "audit.html")} (${pairs.length} пар). Открой в браузере: file://${path.join(AUDIT_DIR, "audit.html")}`);
