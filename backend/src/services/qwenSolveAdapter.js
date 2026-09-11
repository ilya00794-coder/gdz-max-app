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
  resp.parsed_output = out;
  return resp;
}
