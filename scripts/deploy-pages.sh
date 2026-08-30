#!/bin/sh
# Деплой фронта на GitHub Pages С АВТОМАТИЧЕСКИМ кэш-бастингом.
# Единственный правильный способ деплоя: голый subtree push оставляет
# телефонам закэшированный app.js неизвестной версии.
set -e
cd "$(dirname "$0")/.."

# Пушится КОММИТНУТОЕ дерево: незакоммиченный webapp уехал бы частично
# (так на Pages однажды попал новый HTML со старым app.js — версии «не было»).
if [ -n "$(git status --porcelain webapp)" ]; then
  echo "ОШИБКА: в webapp/ незакоммиченные изменения — сначала git commit, потом деплой." >&2
  git status --short webapp >&2
  exit 1
fi

V="$(git rev-parse --short HEAD)-$(date +%d.%m.%H%M)"

# 1) версия в version.js (видна в интерфейсе и консоли)
cat > webapp/version.js <<VEOF
// Версия фронта. Проставляется АВТОМАТИЧЕСКИ скриптом scripts/deploy-pages.sh
// при каждом деплое — руками не менять (забудется на третий раз).
window.APP_VERSION = "$V";
VEOF

# 2) кэш-бастинг ссылок в index.html (?v=... у style/version/config/app)
sed -i '' -E "s/\?v=[^\"]*/?v=$V/g" webapp/index.html

git add webapp/version.js webapp/index.html
git commit -m "deploy: фронт $V"
git subtree push --prefix webapp origin gh-pages
echo "Задеплоено: версия $V (проверка с телефона: строка «версия $V» внизу экрана настройки)"
