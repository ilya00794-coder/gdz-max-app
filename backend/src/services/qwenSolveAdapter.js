// Адаптер structured-вызова для Qwen (DashScope, Anthropic-совместимый endpoint).
//
// Продовый solve шлёт output_config.format (structured outputs Claude-5) +
// thinking + effort — Qwen эти поля не знает. Адаптер транслирует parse-запрос
// в create-запрос с инструментом (tools + tool_choice:auto; форсированный
// tool_choice у Qwen/DeepSeek под thinking даёт 400) и собирает parsed_output
// из tool_use. Промпт, схема и messages — байт-в-байт те же, что у Claude-пути.
//
// Выверено стендовым замером 11.09 (110 задач, 97% single-shot / 100% с ретраем);
// оба транспортных бага DashScope, найденных замером, обезврежены здесь:
//   1) обёртка {result:{...}} вместо плоской схемы (стохастически);
//   2) raw_arguments — аргументы tool_use нераспарсенной JSON-строкой.

function stripCacheControl(system) {
  if (!Array.isArray(system)) return system;
  return system.map(({ cache_control, ...rest }) => rest);
}

/**
 * Механическая коэрция типов ПО СХЕМЕ (канарейка 11.09 поймала оба кейса):
 * qwen шлёт число там, где схема ждёт строку (values[].value: 100), и порой
 * массив JSON-строкой (steps). Коэрцируем только безущербные преобразования
 * (число→строка, валидная JSON-строка→массив) — всё остальное оставляем как
 * есть, и zod-валидация в solveTask честно роняет (fail-closed → ретрай/фолбэк).
 */
export function coerceBySchema(node, spec, root = spec, depth = 0) {
  if (node == null || !spec || typeof spec !== "object" || depth > 32) return node;
  // zodOutputFormat выносит вложенные схемы в $defs и ссылается $ref'ами — резолвим.
  let guard = 0;
  while (typeof spec.$ref === "string" && guard++ < 8) {
    const name = spec.$ref.replace("#/$defs/", "");
    const next = root?.$defs?.[name];
    if (!next) return node;
    spec = next;
  }
  if (Array.isArray(spec.anyOf)) {
    for (const sub of spec.anyOf) {
      const coerced = coerceBySchema(node, sub, root, depth + 1);
      if (coerced !== node) return coerced;
    }
    return node;
  }
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  if (types.includes("string") && typeof node === "number") return String(node);
  if (types.includes("array")) {
    let v = node;
    if (typeof v === "string") {
      try { const p = JSON.parse(v); if (Array.isArray(p)) v = p; } catch { /* не JSON — оставляем */ }
    }
    // Объект вместо массива (канарейка №3, steps): числовые ключи {"0":…,"1":…}
    // → значения по порядку; одиночный элемент → [элемент], но ТОЛЬКО если в нём
    // есть все обязательные поля элемента схемы (иначе честный zod-отказ).
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
        v = keys.sort((a, b) => a - b).map((k) => v[k]);
      } else {
        let itemSpec = spec.items, g = 0;
        while (itemSpec && typeof itemSpec.$ref === "string" && g++ < 8) itemSpec = root?.$defs?.[itemSpec.$ref.replace("#/$defs/", "")];
        const req = itemSpec?.required ?? [];
        if (req.length && req.every((k) => k in v)) v = [v];
      }
    }
    if (Array.isArray(v) && spec.items) return v.map((x) => coerceBySchema(x, spec.items, root, depth + 1));
    return v;
  }
  if ((types.includes("object") || spec.properties) && typeof node === "object" && !Array.isArray(node)) {
    const out = { ...node };
    for (const [k, s] of Object.entries(spec.properties || {})) {
      if (k in out) out[k] = coerceBySchema(out[k], s, root, depth + 1);
      // qwen ОПУСКАЕТ null-поля вместо явного null (вторая канарейка:
      // setExpression отсутствует). nullable ≠ optional для zod — дополняем
      // отсутствующий ключ null'ом ТОЛЬКО если схема null принимает.
      else if (acceptsNull(s, root)) out[k] = null;
    }
    return out;
  }
  return node;
}

/** Принимает ли спека null (с резолвом $ref и anyOf). */
function acceptsNull(spec, root, depth = 0) {
  if (!spec || typeof spec !== "object" || depth > 8) return false;
  let guard = 0;
  while (typeof spec.$ref === "string" && guard++ < 8) {
    spec = root?.$defs?.[spec.$ref.replace("#/$defs/", "")];
    if (!spec) return false;
  }
  if (Array.isArray(spec.anyOf)) return spec.anyOf.some((s) => acceptsNull(s, root, depth + 1));
  const types = Array.isArray(spec.type) ? spec.type : [spec.type];
  return types.includes("null");
}

/**
 * Аналог client.messages.parse(args) для Qwen.
 * @param {object} client - клиент из getQwenClient()
 * @param {object} args - те же args, что продовый код передаёт в parse
 * @returns {Promise<object>} resp с parsed_output (null = структурный сбой, решается ретраем выше)
 */
export async function qwenStructuredParse(client, args) {
  const fmt = args.output_config?.format;
  const schema = fmt?.schema ?? { type: "object" };
  const tool = {
    name: "result",
    description: "Верни результат СТРОГО по JSON-схеме, без пояснений вне инструмента.",
    input_schema: schema,
  };
  const resp = await client.messages.create({
    model: args.model,
    max_tokens: args.max_tokens,
    // cache_control убираем: у DashScope кэш implicit, поле не принимается.
    system: stripCacheControl(args.system),
    messages: args.messages,
    tools: [tool],
    tool_choice: { type: "auto" },
  });
  const tu = (resp.content || []).find((b) => b.type === "tool_use");
  let out = tu && tu.input && typeof tu.input === "object" ? tu.input : null;
  // Баг 2: аргументы нераспарсенной строкой — {"raw_arguments":"<json>"}.
  if (out && typeof out.raw_arguments === "string" && Object.keys(out).length === 1) {
    try { out = JSON.parse(out.raw_arguments); } catch { /* останется как есть → структурный сбой */ }
  }
  // Баг 1: весь ответ обёрнут единственным ключом (обычно по имени инструмента).
  // Разворачиваем ТОЛЬКО когда на верхнем уровне нет ни одного поля схемы.
  if (out) {
    const topKeys = Object.keys(out);
    const schemaProps = Object.keys(schema.properties || {});
    if (!topKeys.some((k) => schemaProps.includes(k)) && topKeys.length === 1
        && out[topKeys[0]] && typeof out[topKeys[0]] === "object") {
      out = out[topKeys[0]];
    }
  }
  resp.parsed_output = out ? coerceBySchema(out, schema) : out;
  return resp;
}
