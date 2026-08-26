# Архитектура (скелет v0.1)

```
Ученик фотографирует задачу
        │
        ▼
  webapp (MAX Bridge)
        │  POST /api/solve { imagesBase64 | text, grade, subject }
        ▼
  backend/routes/solve.js
        │
        ├─► vision.js — распознаём фото (условие + учебник/номер, если виден)
        │
        ├─► cache.js — есть ли уже проверенное решение по этому ключу?
        │       │
        │       ├── да → отдаём мгновенно, без AI-вызова
        │       │
        │       └── нет ↓
        │
        ├─► solver.js — решаем "с нуля" (Claude API), с учётом класса
        │
        ├─► verify.js — сверяем финальный ответ (Wolfram/SymPy или эталон)
        │
        └─► если verified === true → кладём в cache.js
        │
        ▼
  ответ по шагам + финальный ответ → webapp → swipe-UI
```

## Почему так, а не "обучаемся на чужих ГДЗ"
Текст готовых решебников — объект авторского права их составителей, а тексты учебников —
издательств. Их массовое копирование или использование как обучающих данных для модели,
которая затем воспроизводит похожий текст, — нарушение прав. Финальный ответ (число/факт)
авторским правом не защищён, поэтому его можно использовать как эталон при сверке через
Wolfram/SymPy или через отдельно купленные экземпляры ГДЗ (сверяем только итог, не копируем
текст объяснения). См. `docs/backlog.md`, раздел "Точность решений".

## Следующие шаги реализации (в порядке приоритета)
1. ~~`services/vision.js` → реальный вызов Claude API (vision) для распознавания фото.~~ **Сделано.**
   Детали: `claude-opus-5`, structured outputs (zod-схема), adaptive thinking, два режима —
   `task` (условие из учебника) и `studentWork` (тетрадь ученика, транскрибируем «как написано»,
   не исправляя ошибки). Модель и effort переопределяются через `VISION_MODEL` / `VISION_EFFORT`.
   Фото с `confidence < 0.4` не идут в решатель — роут возвращает `422` «переснимите».
2. ~~`services/solver.js` → реальный вызов Claude API для решения с учётом класса/предмета.~~ **Сделано.**
   `claude-opus-5`, structured outputs, adaptive thinking, effort=high (`SOLVER_MODEL` / `SOLVER_EFFORT`).
   Ключевое: решение ограничено программой класса — белый список методов из `services/curriculum.js`
   (данные ФРП, см. `backend/src/data/curriculum/SOURCES.md`) уходит в системный промпт
   отдельным блоком с `cache_control`, поэтому префикс кэшируется по паре (класс, предмет, четверть).
   Роуты принимают необязательный `quarter` (1–4, по умолчанию 4 — за весь год).
   Ответ содержит `usedMethods` и `programWarning` — для eval-цикла и для случая,
   когда задачу нельзя решить пройденными методами.
3. ~~`services/verify.js` → интеграция Wolfram Alpha API (математика/физика/химия).~~ **Сделано, но на SymPy, а не Wolfram** —
   бесплатно и детерминированно. `verify.js` запускает `verify_sympy.py` отдельным процессом
   (белый список символов в Node + белый список узлов AST в Python, без builtins, таймаут 5 с),
   решает `formalExpression` и сравнивает множество ДЕЙСТВИТЕЛЬНЫХ корней с ответом решателя.
   В кэш идут только решения с `verified: true`. Wolfram Alpha остаётся вариантом на будущее —
   для задач, которые SymPy не берёт.
4. ~~`services/cache.js` → перенести с in-memory на Postgres/Redis.~~ **Сделано (Postgres).**
   Таблица `solutions_cache` (`cache_key` PK, `solution` jsonb, `verification_method`, `cached_at`),
   драйвер `pg` без ORM, подключение через `DATABASE_URL`. Схема — `src/db/schema.sql`,
   миграция вручную: `npm run migrate` (идемпотентна, при старте сервера не выполняется).
   `getCached`/`setCached` стали async; `buildCacheKey` остался чистой функцией.
   При недоступной базе сервер падает на старте с инструкцией — молчаливого отката
   на in-memory нет, иначе поломка кэша осталась бы незамеченной.
5. Подключить реальный MAX Bridge SDK в `webapp/` и зарегистрировать бота на business.max.ru.
6. ~~Пошаговое сравнение в `check-homework` (сейчас — заглушка).~~ **Сделано.**
   `services/compare.js` — отдельный вызов Claude API (`COMPARE_MODEL` / `COMPARE_EFFORT`,
   structured outputs) сравнивает работу ученика с эталоном по шагам и возвращает
   `mistakes[{stepDescription, whatStudentDid, whatShouldBeDone}]`, `firstMistakeStep`,
   `studentSteps`, `unreadableFragments`, `incomplete`.
   Финальный ответ ученика дополнительно проверяется SymPy через `verify.js`.
   `crossCheckVerdicts` сверяет два вердикта: при расхождении — лог и поле `verdictConflict`,
   без попытки выбрать «правильный» вердикт.
