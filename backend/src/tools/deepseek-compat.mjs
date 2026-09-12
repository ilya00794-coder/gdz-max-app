// DeepSeek-адаптер для стенда (НЕ прод): продовый путь solve/vision шлёт
// output_config.format (structured outputs Claude-5) + thinking:adaptive + effort.
// DeepSeek этого не поддерживает, но принимает tools + tool_choice:auto (проверено
// пробой). Здесь мы транслируем parse-запрос в create-запрос с инструментом,
// собираем parsed_output из tool_use. Промпт/схема/сообщения — те же.
// Применяется ТОЛЬКО в tool-коде стенда, продовые vision.js/solver.js не трогаем.

function stripCacheControl(system) {
  if (!Array.isArray(system)) return system;
  return system.map(({ cache_control, ...rest }) => rest);
}

/**
 * Замена client.messages.parse(args) для DeepSeek.
 * @param {(a:object)=>Promise<any>} create - оригинальный client.messages.create
 * @param {object} args - те же args, что продовый код передал бы в parse
 * @returns {Promise<any>} resp с полем parsed_output (или null)
 */
export async function deepseekStructuredParse(create, args) {
  const fmt = args.output_config?.format;
  const schema = fmt?.schema ?? { type: "object" };
  const tool = {
    name: "result",
    description: "Верни результат СТРОГО по JSON-схеме, без пояснений вне инструмента.",
    input_schema: schema,
  };
  const createArgs = {
    model: args.model,
    max_tokens: args.max_tokens,
    system: stripCacheControl(args.system),
    messages: args.messages,
    tools: [tool],
    tool_choice: { type: "auto" }, // форсированный tool_choice DeepSeek под thinking не принимает
  };
  const resp = await create(createArgs);
  const tu = (resp.content || []).find((b) => b.type === "tool_use");
  let out = tu && tu.input && typeof tu.input === "object" ? tu.input : null;
  // Причуда DashScope (qwen, g5-08): аргументы приходят НЕраспарсенными —
  // input={"raw_arguments":"<json-строка>"}. Разворачиваем детерминированно.
  if (out && typeof out.raw_arguments === "string" && Object.keys(out).length === 1) {
    try { out = JSON.parse(out.raw_arguments); } catch { /* оставляем как есть — уйдёт в структ.сбой */ }
  }
  // DeepSeek иногда оборачивает ответ в один ключ по имени инструмента:
  // {"result": {...настоящая схема...}}. Разворачиваем ТОЛЬКО когда на верхнем
  // уровне нет ни одного поля схемы и это единственный объект-ключ.
  if (out) {
    const topKeys = Object.keys(out);
    const schemaProps = Object.keys(schema.properties || {});
    const hasSchemaProp = topKeys.some((k) => schemaProps.includes(k));
    if (!hasSchemaProp && topKeys.length === 1 && out[topKeys[0]] && typeof out[topKeys[0]] === "object") {
      out = out[topKeys[0]];
    }
  }
  // Мягкая коэрция вторичных МАССИВНЫХ полей схемы: не-Anthropic модели иногда
  // отдают array-поле объектом/строкой. Адаптер не валидирует zod'ом (в отличие
  // от продового parse), поэтому не-массив → [], чтобы код-потребитель не падал
  // на .map. Строковые поля (recognizedText/finalAnswer) НЕ трогаем.
  if (out && schema.properties) {
    for (const [k, spec] of Object.entries(schema.properties)) {
      if (JSON.stringify(spec ?? {}).includes('"array"') && out[k] !== undefined && out[k] !== null && !Array.isArray(out[k])) {
        out[k] = [];
      }
    }
  }
  resp.parsed_output = out;
  if (process.env.DEEPSEEK_DEBUG) {
    const keys = resp.parsed_output ? Object.keys(resp.parsed_output) : null;
    console.error(`[ds-debug] stop=${resp.stop_reason} blocks=${JSON.stringify((resp.content||[]).map(b=>b.type))} tool=${!!tu} inputKeys=${JSON.stringify(keys)} hasFinal=${!!resp.parsed_output?.finalAnswer}`);
  }
  if (!resp.parsed_output) {
    // диагностика: что пришло вместо валидного tool_use
    resp._deepseekNoTool = {
      stop_reason: resp.stop_reason,
      blocks: (resp.content || []).map((b) => b.type),
    };
  }
  return resp;
}
