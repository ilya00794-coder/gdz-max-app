#!/bin/sh
# Установка/обновление launchd-агентов прода (бэкенд + туннель).
# Идемпотентен: существующие агенты снимаются и ставятся заново из репо.
# Источник правды — infra/launchd/*.plist; здесь только копирование и bootstrap.
set -e
cd "$(dirname "$0")/.."
UID_N=$(id -u)
for name in com.gdz.backend com.gdz.tunnel com.gdz.samples-gc com.gdz.handwriting-gc; do
  launchctl bootout "gui/$UID_N/$name" 2>/dev/null || true
  cp "infra/launchd/$name.plist" "$HOME/Library/LaunchAgents/$name.plist"
  # bootstrap может падать кодом 5 сразу после bootout (гонка launchd) —
  # повтор через паузу; без этого set -e бросал скрипт ПОСРЕДИ списка и
  # оставлял снятые агенты (инцидент 11.09: туннель снят, прод без ngrok ~1 мин).
  launchctl bootstrap "gui/$UID_N" "$HOME/Library/LaunchAgents/$name.plist" \
    || { sleep 2; launchctl bootstrap "gui/$UID_N" "$HOME/Library/LaunchAgents/$name.plist"; }
  echo "установлен: $name"
done
launchctl print "gui/$UID_N/com.gdz.backend" | grep -E 'state|pid' | head -2
launchctl print "gui/$UID_N/com.gdz.tunnel" | grep -E 'state|pid' | head -2
