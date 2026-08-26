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
