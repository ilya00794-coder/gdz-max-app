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

// Архив рабочего дерева репозитория: git archive HEAD (без .git, без секретов).
router.get("/code.tar.gz", (req, res) => {
  if (!authorized(req)) return res.status(404).end();
  res.setHeader("content-type", "application/gzip");
  const git = spawn("git", ["archive", "--format=tar.gz", "HEAD"], { cwd: REPO_ROOT });
  git.stdout.pipe(res);
  git.stderr.on("data", (d) => console.warn("[deploy] git archive:", String(d).slice(0, 120)));
  git.on("error", (err) => { console.error("[deploy] git:", err.message); res.destroy(); });
});

// Скрипты развёртывания текстом — чтобы можно было `curl ... | bash`.
for (const name of ["server-bootstrap.sh", "migrate-to-server.sh"]) {
  router.get("/" + name, (req, res) => {
    if (!authorized(req)) return res.status(404).end();
    res.setHeader("content-type", "text/plain; charset=utf-8");
    fs.createReadStream(path.join(REPO_ROOT, "infra", name)).pipe(res);
  });
}

export default router;
