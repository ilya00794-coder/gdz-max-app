#!/usr/bin/env bash
# Установщик «в одну строку» для сервера (14.09.2026). Запускается ИЗ КОНСОЛИ
# сервера и не требует ни GitHub (заблокирован из РФ), ни SSH (входящий 22
# фильтруется провайдером):
#
#   curl -fsSL "https://api.dmshk.ru/deploy/install.sh?token=ТОКЕН" | bash
#
# Что делает: качает архив кода КУСКАМИ по 64 КБ с повторами (DPI рвёт длинные
# потоки), собирает, проверяет целостность и запускает server-bootstrap.sh.
set -euo pipefail

BASE=${BASE:-https://api.dmshk.ru/deploy}
TOKEN=${DEPLOY_TOKEN:-__TOKEN__}
APP_DIR=${APP_DIR:-/opt/gdz-max-app}
WORK=$(mktemp -d)

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

say "Узнаю размер архива"
HEADERS=$(curl -sS -D - -o /dev/null "$BASE/code.tar.gz?token=$TOKEN&part=0" --max-time 60)
PARTS=$(printf '%s' "$HEADERS" | tr -d '\r' | awk 'tolower($1)=="x-total-parts:"{print $2}')
SIZE=$(printf '%s' "$HEADERS" | tr -d '\r' | awk 'tolower($1)=="x-total-size:"{print $2}')
[ -n "${PARTS:-}" ] || { echo "не удалось получить x-total-parts — проверь токен и доступность $BASE"; exit 1; }
echo "частей: $PARTS, всего байт: ${SIZE:-?}"

say "Качаю части (до 8 попыток на каждую)"
i=0
while [ "$i" -lt "$PARTS" ]; do
  ok=0
  for try in 1 2 3 4 5 6 7 8; do
    if curl -sS "$BASE/code.tar.gz?token=$TOKEN&part=$i" -o "$WORK/p.$i" --max-time 120 && [ -s "$WORK/p.$i" ]; then
      ok=1; break
    fi
    sleep 2
  done
  [ "$ok" = 1 ] || { echo "часть $i не скачалась"; exit 1; }
  printf '.'
  i=$((i + 1))
done
echo

say "Собираю архив и проверяю целостность"
: > "$WORK/code.tar.gz"
i=0
while [ "$i" -lt "$PARTS" ]; do cat "$WORK/p.$i" >> "$WORK/code.tar.gz"; i=$((i + 1)); done
ls -l "$WORK/code.tar.gz" | awk '{print "собрано байт:", $5}'
tar -tzf "$WORK/code.tar.gz" >/dev/null || { echo "архив битый — перезапусти установщик"; exit 1; }

say "Распаковываю в $APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf "$WORK/code.tar.gz" -C "$APP_DIR"
rm -rf "$WORK"

say "Запускаю развёртывание"
export CODE_TARBALL="$BASE/code.tar.gz?token=$TOKEN"
export DEPLOY_TOKEN="$TOKEN"
exec bash "$APP_DIR/infra/server-bootstrap.sh"
