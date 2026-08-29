// Разовый инструмент: поймать chat_id канала из событий MAX.
//
// Зачем: chat_id канала нельзя получить по публичной ссылке, а метод GET /chats
// с июня 2026 объявлен устаревшим. Официальный путь — вынуть chat_id из события
// (bot_added, message_created и т. п.), которое MAX присылает боту-администратору.
//
// Почему long polling, а не webhook: для разового получения id не нужно ни публичного
// URL, ни подписки, ни нового роута на сервере. Webhook пришлось бы монтировать в
// server.js, и он попал бы под мидлвару /api — при включённом STRICT_INIT_DATA MAX
// получал бы 401 и через 8 часов отписался бы сам. Long polling ничего этого не трогает.
// Важно: при активной webhook-подписке long polling не работает (проверено: подписок нет).
//
// Запуск: npm run catch-chat-id
// Найденный id НЕ пишется в код — положите его в MAX_CHANNEL_CHAT_ID в .env.

const TOKEN = process.env.MAX_BOT_TOKEN;

// Документация рекомендует platform-api2.max.ru, но его сертификат выпущен
// «Russian Trusted Sub CA» (Минцифры) и не проходит проверку в системном хранилище.
// platform-api.max.ru отвечает тем же API и подписан Let's Encrypt.
const HOST = process.env.MAX_API_HOST || "platform-api.max.ru";

const POLL_TIMEOUT_SEC = 30;
const RUN_LIMIT_MS = Number(process.env.CATCH_RUN_MS || 5 * 60 * 1000);

if (!TOKEN) {
  console.error("Не задан MAX_BOT_TOKEN. Добавьте его в backend/.env");
  process.exit(1);
}

/** Достаёт из события всё, что похоже на чат: id, тип, название. */
function chatsFrom(update) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.chat_id === "number") {
      found.push({ chat_id: node.chat_id, type: node.chat_type ?? node.type ?? null, title: node.title ?? null });
    }
    Object.values(node).forEach(visit);
  };
  visit(update);
  return found;
}

async function poll(marker) {
  const url = new URL(`https://${HOST}/updates`);
  url.searchParams.set("timeout", String(POLL_TIMEOUT_SEC));
  url.searchParams.set("limit", "100");
  if (marker !== undefined && marker !== null) url.searchParams.set("marker", String(marker));

  const res = await fetch(url, {
    headers: { Authorization: TOKEN },
    signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 15) * 1000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const seen = new Set();

async function main() {
  console.log(`Слушаю события бота через ${HOST}. Остановить — Ctrl+C.`);
  console.log(`Чтобы событие пришло: напишите любое сообщение в канал, либо удалите и заново`);
  console.log(`добавьте бота администратором. Жду до ${Math.round(RUN_LIMIT_MS / 60000)} минут.\n`);

  const startedAt = Date.now();
  let marker;

  while (Date.now() - startedAt < RUN_LIMIT_MS) {
    let data;
    try {
      data = await poll(marker);
    } catch (err) {
      console.error("  сбой опроса:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of data.updates ?? []) {
      console.log(`\nсобытие: ${update.update_type ?? "(без типа)"}  время: ${update.timestamp ?? "—"}`);
      for (const chat of chatsFrom(update)) {
        const key = `${chat.chat_id}`;
        console.log(`   chat_id: ${chat.chat_id}   тип: ${chat.type ?? "—"}   название: ${chat.title ?? "—"}`);
        if (!seen.has(key)) seen.add(key);
      }
      // Полное событие — на случай, если chat_id лежит в неожиданном месте.
      console.log("   сырое событие:", JSON.stringify(update).slice(0, 600));
    }

    if (data.marker !== undefined && data.marker !== null) marker = data.marker;
  }

  console.log("\n──────────────────────────────────────────────");
  if (seen.size) {
    console.log("Найденные chat_id:");
    for (const id of seen) console.log(`   ${id}`);
    console.log("\nПоложите нужный в backend/.env:  MAX_CHANNEL_CHAT_ID=<id>");
  } else {
    console.log("Событий с chat_id не поймано. Нужно вызвать событие в канале — см. подсказку выше.");
  }
}

main().catch((err) => {
  console.error("Инструмент упал:", err.message);
  process.exit(1);
});
