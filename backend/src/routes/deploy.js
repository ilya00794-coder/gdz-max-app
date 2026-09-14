// ВРЕМЕННЫЙ роут развёртывания (14.09.2026): раздаёт код и bootstrap серверу,
// которому GitHub недоступен (РФ-сеть RuVDS: SSL timeout к github/raw).
// Живёт ТОЛЬКО пока задан DEPLOY_TOKEN — после переезда убрать переменную
// (роут сам станет 404) и удалить файл.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";

const router = Router();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function authorized(req) {
  const token = process.env.DEPLOY_TOKEN;
  return Boolean(token) && req.query?.token === token;
}

// Архив рабочего дерева: git archive HEAD (без .git и секретов). Отдаём ФАЙЛОМ
// через sendFile — тогда работают Range-запросы и докачка: DPI режет длинные
// TLS-стримы на ~20 КБ (кейс 14.09), а по кускам архив доезжает целиком.
const ARCHIVE = "/tmp/gdz-deploy-code.tar.gz";
const PART = 64 * 1024; // куски по 64 КБ: DPI рвёт длинные потоки (~20 КБ+),
// а Range через Cloudflare схлопывается в 200 — поэтому нарезаем сами.
router.get("/code.tar.gz", (req, res) => {
  if (!authorized(req)) return res.status(404).end();
  const fresh = fs.existsSync(ARCHIVE) && Date.now() - fs.statSync(ARCHIVE).mtimeMs < 60_000;
  const send = () => {
    const total = fs.statSync(ARCHIVE).size;
    const parts = Math.ceil(total / PART);
    res.setHeader("x-total-parts", String(parts));
    res.setHeader("x-total-size", String(total));
    const part = req.query?.part;
    if (part === undefined) return res.sendFile(ARCHIVE, { headers: { "content-type": "application/gzip" } });
    const i = Number(part);
    if (!Number.isInteger(i) || i < 0 || i >= parts) return res.status(416).end();
    res.setHeader("content-type", "application/octet-stream");
    fs.createReadStream(ARCHIVE, { start: i * PART, end: Math.min((i + 1) * PART, total) - 1 }).pipe(res);
  };
  if (fresh) return send();
  const out = fs.createWriteStream(ARCHIVE);
  const git = spawn("git", ["archive", "--format=tar.gz", "HEAD"], { cwd: REPO_ROOT });
  git.stdout.pipe(out);
  git.stderr.on("data", (d) => console.warn("[deploy] git archive:", String(d).slice(0, 120)));
  git.on("error", (err) => { console.error("[deploy] git:", err.message); res.status(500).end(); });
  out.on("close", send);
});

// Скрипты развёртывания текстом — чтобы можно было `curl ... | bash`.
for (const name of ["server-bootstrap.sh", "migrate-to-server.sh"]) {
  router.get("/" + name, (req, res) => {
    if (!authorized(req)) return res.status(404).end();
    res.setHeader("content-type", "text/plain; charset=utf-8");
    fs.createReadStream(path.join(REPO_ROOT, "infra", name)).pipe(res);
  });
}

// install.sh — с подставленным токеном: серверу достаточно ОДНОЙ короткой
// команды, токен внутрь скрипта попадает сам (в консоли меньше опечаток).
router.get("/install.sh", (req, res) => {
  if (!authorized(req)) return res.status(404).end();
  const text = fs.readFileSync(path.join(REPO_ROOT, "infra", "server-install.sh"), "utf8")
    .replaceAll("__TOKEN__", process.env.DEPLOY_TOKEN);
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.send(text);
});

export default router;
