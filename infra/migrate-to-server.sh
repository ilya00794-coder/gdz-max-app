#!/usr/bin/env bash
# Перевоз данных с мака на сервер (14.09.2026). Запускать НА МАКЕ:
#   bash infra/migrate-to-server.sh root@<IP-сервера>
#
# Везёт: .env (секреты), дамп Postgres, медиа генераций, аудит рукописи.
# Ничего не удаляет на маке — мак остаётся запасным хостом на переходную неделю.
set -euo pipefail
TARGET="${1:?укажи цель: root@IP}"
APP_DIR=/opt/gdz-max-app

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

say "Дамп базы gdz_max"
TMP=$(mktemp -d)
pg_dump --no-owner --no-acl gdz_max > "$TMP/gdz_max.sql"
du -h "$TMP/gdz_max.sql" | cut -f1

say "Копирую .env, дамп и медиа на сервер"
scp -q "$TMP/gdz_max.sql" "$TARGET:/tmp/gdz_max.sql"
scp -q backend/.env "$TARGET:/tmp/gdz.env"
[ -d "$HOME/gdz-media" ] && rsync -aq --delete "$HOME/gdz-media/" "$TARGET:/var/lib/gdz/media/" || true
[ -d "$HOME/gdz-handwriting-audit" ] && rsync -aq "$HOME/gdz-handwriting-audit/" "$TARGET:/var/lib/gdz/handwriting-audit/" || true

say "Разворачиваю на сервере"
ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
APP_DIR=/opt/gdz-max-app
install -o gdz -g gdz -m 600 /tmp/gdz.env "$APP_DIR/backend/.env"
rm -f /tmp/gdz.env
# База: схема+данные из дампа (пустую базу создал bootstrap)
sudo -u gdz psql -q -d gdz_max -f /tmp/gdz_max.sql >/dev/null 2>&1 || \
  sudo -u gdz psql -d gdz_max -f /tmp/gdz_max.sql
rm -f /tmp/gdz_max.sql
# Пути данных на сервере отличаются от домашних на маке — дописываем в .env
grep -q '^MEDIA_DIR=' "$APP_DIR/backend/.env" || echo 'MEDIA_DIR=/var/lib/gdz/media' >> "$APP_DIR/backend/.env"
grep -q '^DATABASE_URL=' "$APP_DIR/backend/.env" || echo 'DATABASE_URL=postgresql:///gdz_max' >> "$APP_DIR/backend/.env"
chown gdz:gdz "$APP_DIR/backend/.env"
sudo -u gdz bash -lc "cd $APP_DIR/backend && npm run migrate" >/dev/null
systemctl restart gdz-backend
sleep 3
systemctl is-active gdz-backend
curl -s -o /dev/null -w "локальный health: %{http_code}\n" http://127.0.0.1:3000/health
REMOTE

rm -rf "$TMP"
say "ГОТОВО. Проверь снаружи: curl https://api.dmshk.ru/health"
echo "ВАЖНО: бот-поллер теперь на сервере — останови мак-агент, чтобы не было двух ботов:"
echo "  launchctl bootout gui/501/com.gdz.backend"
