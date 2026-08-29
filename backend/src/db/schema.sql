-- Кэш верифицированных решений.
--
-- Хранятся ТОЛЬКО наши собственные решения, сгенерированные solver.js: ни текстов чужих
-- решебников, ни страниц учебников, ни фотографий пользователей здесь нет и быть не должно.
-- Ключ — канонический идентификатор задачи (см. buildCacheKey в services/cache.js).

CREATE TABLE IF NOT EXISTS solutions_cache (
  -- "book:<учебник>:<класс>:<предмет>:<номер>" либо "text:<хэш условия>"
  cache_key           text        PRIMARY KEY,

  -- Весь объект решения целиком — то же, что раньше лежало в Map.
  solution            jsonb       NOT NULL,

  -- Дублируем метод верификации отдельной колонкой: для eval-дашборда нужно уметь
  -- выбрать "все решения, проверенные через sympy" без разбора jsonb.
  verification_method text,

  cached_at           timestamptz NOT NULL DEFAULT now()
);

-- Под выборки eval-дашборда по методу проверки.
CREATE INDEX IF NOT EXISTS solutions_cache_verification_method_idx
  ON solutions_cache (verification_method);

-- Под "что накэшировалось за последнее время".
CREATE INDEX IF NOT EXISTS solutions_cache_cached_at_idx
  ON solutions_cache (cached_at DESC);

-- Жалобы пользователей на решение или проверку.
--
-- Фотографии здесь НЕ хранятся — только текст и структура того, что было показано.
-- Так приватнее и соответствует правилу проекта: снимки пользователей нигде не сохраняем.

CREATE TABLE IF NOT EXISTS feedback (
  id                bigserial   PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- На что жалуются: solve — на решение задачи, check — на проверку домашней работы.
  type              text        NOT NULL CHECK (type IN ('solve', 'check')),

  grade             integer     CHECK (grade BETWEEN 1 AND 11),
  subject           text,

  -- Условие, по которому работали (распознанное или введённое руками).
  recognized_text   text,

  -- Что именно показали пользователю: решение целиком либо результат проверки.
  solution_snapshot jsonb,

  -- Свободный комментарий, необязательный.
  user_comment      text,

  -- Идентификатор пользователя MAX из подписанной строки запуска, если она была.
  max_user_id       text
);

-- Под разбор жалоб: свежие сверху, с фильтром по типу.
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_type_idx ON feedback (type);

-- Эталонные решения, выверенные человеком вручную.
--
-- НЕ смешивать с solutions_cache: там машинные решения (доверие = SymPy-проверка),
-- здесь ручные эталоны (доверие = автор). Машинные решения сюда не пишутся никогда.
--
-- Текстов условий из учебников здесь НЕТ по построению (правило проекта №1):
-- только ссылка на задачу (учебник+номер), собственный текст решения и ответ.
-- Финальный ответ авторским правом не защищён, авторские шаги — текст автора базы.
--
-- Издание — отдельная колонка, НЕ часть cache_key: на фото задачи издание не видно,
-- vision его не распознаёт, и ключ с зашитым годом никогда не совпал бы с ключом от
-- фото. Одна задача из разных изданий = разные строки с одинаковым cache_key;
-- политика сверки при неоднозначности — в solve-пути, не в схеме.

CREATE TABLE IF NOT EXISTS reference_solutions (
  id             bigserial   PRIMARY KEY,

  -- Компоненты канонического ключа. textbook — в той форме, в какой её отдаёт
  -- vision ("виленкин математика 5"), иначе ключи не сойдутся.
  textbook       text        NOT NULL,
  grade          integer     NOT NULL CHECK (grade BETWEEN 1 AND 11),
  subject        text        NOT NULL,
  task_number    text        NOT NULL,  -- "1241", "389а" — свободный формат

  -- Год/издание ("2023, Просвещение"). Нумерация задач меняется между изданиями
  -- (Виленкин!), эталон из чужого издания хуже отсутствия эталона.
  edition        text        NOT NULL,

  topic          text,

  -- Ключ в формате buildCacheKey (services/cache.js): "book:<...>". Заполняется
  -- импортёром через САМ buildCacheKey — логика нормализации живёт в одном месте.
  cache_key      text        NOT NULL,

  -- Хэш нормализованного условия — зарезервировано под поиск по фото без номера.
  -- В v1 не заполняется и не используется (решение от 29.08.2026).
  condition_hash text,

  -- Ответ в двух формах: человеческая ("x = 6", "12 км/ч") и пригодная для
  -- SymPy-сверки через parseCandidateAnswer ("6", "2; 3"). answer_sympy NULL =
  -- сверка невозможна, эталон лежит без использования (v1 — только точные науки).
  final_answer   text        NOT NULL,
  answer_sympy   text,

  -- Шаги в авторской формулировке, той же формы, что у solver: [{title, content}].
  -- NULL допустим: запись "только ответ" тоже ценна для сверки.
  steps          jsonb,

  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Одна задача одного издания — одна строка; upsert импортёра целится сюда.
CREATE UNIQUE INDEX IF NOT EXISTS reference_solutions_task_edition_idx
  ON reference_solutions (textbook, grade, subject, task_number, edition);

-- Поиск эталона в solve-пути. НЕ уникальный: издания делят один ключ.
CREATE INDEX IF NOT EXISTS reference_solutions_cache_key_idx
  ON reference_solutions (cache_key);

CREATE INDEX IF NOT EXISTS reference_solutions_condition_hash_idx
  ON reference_solutions (condition_hash) WHERE condition_hash IS NOT NULL;
