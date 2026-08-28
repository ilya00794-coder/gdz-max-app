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
