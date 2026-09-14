#!/usr/bin/env bash
# Развёртывание бэкенда «Домашка в MAX» на чистой Ubuntu 24.04 (14.09.2026).
# Идемпотентен: повторный запуск ничего не ломает.
#
# Запуск на сервере от root:
#   bash server-bootstrap.sh
#
# Что ставит: Node 22, Postgres 16, python3+sympy (verify), ffmpeg, Caddy
# (авто-TLS для api.dmshk.ru), systemd-юнит бэкенда. Секреты (.env) НЕ трогает —
# их привозит migrate-to-server.sh отдельно.
set -euo pipefail

APP_USER=gdz
APP_DIR=/opt/gdz-max-app
REPO=https://github.com/ilya00794-coder/gdz-max-app.git
# Из РФ-сети сервера GitHub недоступен (SSL timeout, кейс 14.09) — код берём
# архивом через свой домен (Cloudflare-воркер probe.dmshk.ru проксирует GitHub).
CODE_TARBALL=${CODE_TARBALL:-https://api.dmshk.ru/deploy/code.tar.gz?token=$DEPLOY_TOKEN}
DOMAIN=api.dmshk.ru

log() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

log "SSH: второй порт 2222 (у провайдера входящий 22 фильтруется — кейс 14.09)"
if ! grep -qE '^Port 2222' /etc/ssh/sshd_config; then
  printf '\nPort 22\nPort 2222\n' >> /etc/ssh/sshd_config
fi
systemctl restart ssh || systemctl restart sshd || true

log "Пакеты системы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg ffmpeg python3 python3-sympy \
  postgresql postgresql-contrib ufw

log "Node 22 (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node -v

log "Пользователь приложения и код"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
# timeout: при блокировке GitHub ls-remote висит минутами на SSL
if timeout 12 git ls-remote --exit-code "$REPO" >/dev/null 2>&1; then
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --quiet origin main && git -C "$APP_DIR" reset --hard origin/main --quiet
  else
    git clone --quiet "$REPO" "$APP_DIR"
  fi
else
  echo "GitHub недоступен — код архивом через $CODE_TARBALL"
  mkdir -p "$APP_DIR"
  curl -fsSL "$CODE_TARBALL" -o /tmp/gdz-code.tar.gz
  tar -xzf /tmp/gdz-code.tar.gz --strip-components=1 -C "$APP_DIR"
  rm -f /tmp/gdz-code.tar.gz
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" bash -lc "cd $APP_DIR/backend && npm ci --omit=dev --silent"

log "Postgres: база и роль"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_USER'" | grep -q 1 \
  || sudo -u postgres createuser "$APP_USER"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='gdz_max'" | grep -q 1 \
  || sudo -u postgres createdb -O "$APP_USER" gdz_max

log "Каталоги данных (медиа, аудит) — вне репозитория"
for d in /var/lib/gdz/media /var/lib/gdz/samples /var/lib/gdz/handwriting-audit; do
  mkdir -p "$d"; chown -R "$APP_USER:$APP_USER" /var/lib/gdz
done

log "systemd-юнит бэкенда"
cat > /etc/systemd/system/gdz-backend.service <<UNIT
[Unit]
Description=GDZ MAX backend (Домашка в MAX)
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/backend
ExecStart=/usr/bin/node --env-file-if-exists=.env server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOME=/home/$APP_USER
StandardOutput=append:/var/log/gdz-backend.log
StandardError=append:/var/log/gdz-backend.log

[Install]
WantedBy=multi-user.target
UNIT
touch /var/log/gdz-backend.log && chown "$APP_USER:$APP_USER" /var/log/gdz-backend.log
systemctl daemon-reload
systemctl enable gdz-backend >/dev/null

log "Caddy (HTTPS для $DOMAIN)"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl reload caddy || systemctl restart caddy

log "Файрвол: только SSH и веб"
for p in 22 2222 80 443; do ufw allow "$p"/tcp >/dev/null; done
ufw --force enable >/dev/null

log "Диагностика портов (что слушает снаружи)"
ss -ltnp | grep -E ':(22|2222|80|443|3000)' || true

log "ГОТОВО. Дальше: привезти .env и дамп базы (infra/migrate-to-server.sh),"
echo "     затем: sudo -u $APP_USER bash -lc 'cd $APP_DIR/backend && npm run migrate' && systemctl start gdz-backend"
