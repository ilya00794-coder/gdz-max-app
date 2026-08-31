// Публикация постов в канал через личку бота (long polling).
//
// Устройство: админ (вайтлист MAX_ADMIN_USER_IDS) пишет боту текст → бот
// отвечает превью с кнопками «Опубликовать»/«Отмена» → по подтверждению
// пост уходит в канал с link-кнопкой на мини-апп (?startapp=post_YYYYMMDD —
// атрибуция поста, initDataUnsafe.start_param на стороне приложения).
//
// Почему long polling, а не webhook: ngrok меняет адрес, webhook требовал бы
// переподписки при каждом рестарте туннеля (решение Ильи, 31.08.2026).
// Доки помечают long polling «не для продакшена» по скорости/сроку хранения —
// для одного админа достаточно; проверенный факт: очередь переживает
// отсутствие приёмника часами (см. project-handoff).
//
// ВАЖНО: tools/catch-chat-id.js поллит тот же /updates — НЕ запускать его
// при работающем сервере, иначе гонка за события очереди.
//
// Ссылка на бота ПОДТВЕРЖДЕНА живым GET /me 31.08.2026: id772408566819_bot.

const HOST = process.env.MAX_API_HOST || "platform-api.max.ru";
const TOKEN = process.env.MAX_BOT_TOKEN || "";
const CHANNEL_ID = process.env.MAX_CHANNEL_CHAT_ID || "";

/** Вайтлист публикаторов. Пустой = бот никому не отвечает, только логирует id. */
const ADMIN_IDS = new Set(
  String(process.env.MAX_ADMIN_USER_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
);

const POLL_TIMEOUT_S = 30;
const RETRY_PAUSE_MS = 5000;
/** Сообщения старее этого из накопленной очереди не обрабатываем — только лог. */
const STALE_MS = 10 * 60 * 1000;

/** userId → { text, images, ts }: черновик, ждущий подтверждения. Память процесса. */
const pending = new Map();

/**
 * Буфер сборки поста: MAX может присылать альбом отдельными событиями —
 * копим текст и фото и ждём тишины (окно сбрасывается каждым новым
 * сообщением), потом одно превью. Требование Ильи: альбом = один черновик.
 */
const collecting = new Map(); // userId → { text, images[], timer }
const FLUSH_MS = Number(process.env.BOT_ALBUM_FLUSH_MS || 2500);
// Превью не живёт вечно: нажатие «Опубликовать» на недельной давности
// черновике отправило бы неактуальный пост (требование Ильи 31.08).
const DRAFT_TTL_MS = 15 * 60 * 1000;

/** Кому уже отправили приветствие (bot_started). Память процесса: после
 * рестарта возможен повтор приветствия — осознанно, хранилище не заводим. */
const greeted = new Set();
/** userId → timestamp последнего автоответа: не чаще раза в сутки. */
const autoReplied = new Map();
const AUTOREPLY_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Название — как видит пользователь на первом экране мини-аппа (логотип
// «Домашка в MAX») и в имени бота/канала.
const GREETING_TEXT =
  "Привет! Я — Домашка в МАХ 📚\n" +
  "Сфотографируй задачу — решу по шагам и объясню. Могу проверить и готовую " +
  "домашку по фото тетради. Жми кнопку 👇";
const AUTOREPLY_TEXT =
  "Я не читаю сообщения — но приложение работает! Сфотографируй задачу или " +
  "страницу тетради — решу и проверю 👇";

let botUsername = null; // из GET /me на старте; нужен для deep-link кнопки

async function api(method, path, { query = {}, body = null } = {}) {
  const url = new URL(`https://${HOST}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/** Кнопка постов: открывает мини-апп сразу, payload — атрибуция поста. */
function appButton() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return {
    type: "link",
    text: "Открыть Домашку",
    url: `https://max.ru/${botUsername}?startapp=post_${stamp}`,
  };
}

async function sendToUser(userId, text, buttons = null, images = []) {
  const attachments = [
    ...images.map((a) => ({ type: "image", payload: a.payload })),
    ...(buttons ? [{ type: "inline_keyboard", payload: { buttons } }] : []),
  ];
  return api("POST", "/messages", {
    query: { user_id: userId },
    body: { text, ...(attachments.length ? { attachments } : {}) },
  });
}

/** Пост в канал. Экспорт — им же пользуется канарейка права постинга. */
export async function postToChannel(text, { withAppButton = true } = {}) {
  return api("POST", "/messages", {
    query: { chat_id: CHANNEL_ID },
    body: {
      text,
      ...(withAppButton ? { attachments: [{ type: "inline_keyboard", payload: { buttons: [[appButton()]] } }] } : {}),
    },
  });
}

export async function deleteMessage(messageId) {
  // Формат подтверждён живым вызовом 31.08: message_id в query, не в пути
  // (путь /messages/{id} отвечает 404 method.not.found).
  return api("DELETE", "/messages", { query: { message_id: messageId } });
}

/** Только для канарейки права постинга: подставляет username без запуска поллера. */
export async function resolveBotUsername() {
  const me = await api("GET", "/me");
  botUsername = me.username;
  return botUsername;
}

/** Превью собранного черновика: тем же составом (текст + те же вложения). */
async function flushDraft(userId, buf, io) {
  const images = buf.images.slice(0, 12); // лимит API — 12 вложений
  pending.set(userId, { text: buf.text, images, ts: Date.now() });
  const head = images.length
    ? `Превью поста, фото: ${images.length} (кнопка «Открыть Домашку» добавится автоматически):`
    : "Превью поста (кнопка «Открыть Домашку» добавится автоматически):";
  try {
    await io.sendToUser(userId, `${head}\n\n${buf.text}`, [[
      { type: "callback", text: "✅ Опубликовать", payload: "publish" },
      { type: "callback", text: "❌ Отмена", payload: "cancel" },
    ]], images);
  } catch (err) {
    // Вложения в превью не встали (например, токен не принят) — показываем
    // текстовое превью с предупреждением, публикация всё равно попробует ступени.
    console.warn("[bot] превью с фото не отправилось, шлю без фото:", err.message);
    await io.sendToUser(userId, `${head}\n(фото в превью показать не удалось: ${err.message.slice(0, 120)})\n\n${buf.text}`, [[
      { type: "callback", text: "✅ Опубликовать", payload: "publish" },
      { type: "callback", text: "❌ Отмена", payload: "cancel" },
    ]]);
  }
}

/**
 * Публикация с фото — три ступени, отказ каждой фиксируется:
 * 1) те же токены входящих вложений; 2) их url; 3) перезалив через /uploads.
 * Возвращает { posted } либо кидает ошибку с перечнем ступеней — по требованию
 * Ильи бот сообщает, ГДЕ именно сломалось, а не просто «не переехало».
 */
async function publishWithImages(text, images, io) {
  if (!images.length) return { posted: await io.postToChannel(text), step: "текст" };
  const postRaw = io.postRaw ?? postToChannelRaw;   // инжекция для канареек
  const reupload = io.reupload ?? reuploadImage;
  const failures = [];

  const byToken = images.map((a) => a?.payload?.token).filter(Boolean);
  if (byToken.length === images.length) {
    try {
      return { posted: await postRaw(text, byToken.map((token) => ({ type: "image", payload: { token } }))), step: "токены" };
    } catch (err) { failures.push(`ступень 1 (токены): ${err.message.slice(0, 150)}`); }
  } else failures.push(`ступень 1 (токены): токен есть не у всех вложений (${byToken.length}/${images.length})`);

  const byUrl = images.map((a) => a?.payload?.url).filter(Boolean);
  if (byUrl.length === images.length) {
    try {
      return { posted: await postRaw(text, byUrl.map((url) => ({ type: "image", payload: { url } }))), step: "url" };
    } catch (err) { failures.push(`ступень 2 (url): ${err.message.slice(0, 150)}`); }
  } else failures.push(`ступень 2 (url): url есть не у всех вложений (${byUrl.length}/${images.length})`);

  try {
    const tokens = [];
    for (const a of images) {
      const src = a?.payload?.url;
      if (!src) throw new Error("нет url для перезалива");
      tokens.push(await reupload(src));
    }
    return { posted: await postRaw(text, tokens.map((token) => ({ type: "image", payload: { token } }))), step: "перезалив" };
  } catch (err) { failures.push(`ступень 3 (перезалив): ${err.message.slice(0, 150)}`); }

  throw new Error(failures.join("\n"));
}

/** Пост в канал с произвольными вложениями + link-кнопка приложения. */
async function postToChannelRaw(text, attachments) {
  return api("POST", "/messages", {
    query: { chat_id: CHANNEL_ID },
    body: { text, attachments: [...attachments, { type: "inline_keyboard", payload: { buttons: [[appButton()]] } }] },
  });
}

/** Ступень 3: скачать по url и залить через POST /uploads. */
async function reuploadImage(srcUrl) {
  const img = await fetch(srcUrl, { signal: AbortSignal.timeout(15000) });
  if (!img.ok) throw new Error(`скачивание ${img.status}`);
  const blob = await img.blob();
  const up = await api("POST", "/uploads", { query: { type: "image" } });
  if (!up.url) throw new Error("uploads не дал url");
  const form = new FormData();
  form.append("data", blob, "photo.jpg");
  const res = await fetch(up.url, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`загрузка ${res.status}`);
  // Ответ аплоада: токен либо в photos.*.token, либо прямым полем.
  const token = json.token ?? Object.values(json.photos ?? {})[0]?.token ?? up.token ?? null;
  if (!token) throw new Error("после загрузки нет токена");
  return token;
}

/**
 * Обработка одного update. Экспортирована для юнит-канареек: send/post
 * инжектируются, снаружи подставляются боевые.
 */
export async function handleUpdate(update, io = { sendToUser, postToChannel, answerCallback }) {
  const type = update.update_type;

  if (type === "message_created") {
    const msg = update.message;
    const userId = String(msg?.sender?.user_id ?? "");
    // Структура вложений: формат payload (token/url) в доках описан неполно —
    // фиксируем фактический по живым сообщениям. Помимо общего лога — append
    // в отдельный файл, переживающий рестарты (дважды теряли данные
    // перезаписью лога: shadow-гейтинг и первая проба фото).
    if (msg?.body?.attachments?.length) {
      const line = JSON.stringify({ ts: new Date().toISOString(), attachments: msg.body.attachments });
      console.log("[bot] attachments:", line.slice(0, 900));
      try {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(new URL("../../attachment-structures.jsonl", import.meta.url), line + "\n");
      } catch (err) {
        console.warn("[bot] не записал структуру вложения в файл:", err.message);
      }
    }
    const text = msg?.body?.text?.trim();
    // Диалог с ботом, не канал/чат: посты канала сюда тоже прилетают — им не отвечаем.
    const isDialog = msg?.recipient?.chat_type === "dialog";
    if (!userId || !isDialog) return;

    if (!ADMIN_IDS.has(userId)) {
      // Ссылка на бота публична, люди пишут в надежде на ответ (в очереди
      // был пользователь с 8 попытками). Молчание выглядит как сломанный
      // сервис — отвечаем ссылкой на приложение, не чаще раза в сутки.
      const ageMs = msg?.timestamp ? Date.now() - msg.timestamp : 0;
      const last = autoReplied.get(userId) ?? 0;
      if (ageMs > STALE_MS) {
        console.log("[bot] старое сообщение не из вайтлиста, только лог", { userId });
      } else if (Date.now() - last < AUTOREPLY_MIN_INTERVAL_MS) {
        console.log("[bot] не из вайтлиста, автоответ уже был сегодня", { userId });
      } else {
        autoReplied.set(userId, Date.now());
        console.log("[bot] не из вайтлиста, шлю автоответ", { userId });
        await io.sendToUser(userId, AUTOREPLY_TEXT, [[appButton()]]);
      }
      return;
    }
    const ageMs = msg?.timestamp ? Date.now() - msg.timestamp : 0;
    if (ageMs > STALE_MS) {
      console.log("[bot] старое сообщение из очереди, только лог", { userId, ageMin: Math.round(ageMs / 60000) });
      return;
    }

    const images = (msg?.body?.attachments ?? []).filter((a) => a?.type === "image");
    if (!text && !images.length) {
      await io.sendToUser(userId, "Пришли текст поста (можно с фото) — я покажу превью с кнопкой публикации.");
      return;
    }

    // Копим до тишины: альбом и подпись могут приехать отдельными событиями.
    const buf = collecting.get(userId) ?? { text: "", images: [] };
    if (text) buf.text = buf.text ? `${buf.text}\n${text}` : text;
    buf.images.push(...images);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      collecting.delete(userId);
      flushDraft(userId, buf, io).catch((err) => console.error("[bot] ошибка превью:", err.message));
    }, FLUSH_MS);
    collecting.set(userId, buf);
    return;
  }

  // Первый контакт: пользователь открыл диалог по диплинку (по докам —
  // «переход по диплинку»; приходит ли при обычном открытии диалога,
  // выясняется живой проверкой). Приветствие — один раз на процесс.
  if (type === "bot_started") {
    const userId = String(update.user?.user_id ?? "");
    if (!userId) return;
    // Атрибуция диплинка: только лог, в телеметрию не пишем (решение Ильи).
    console.log("[bot] bot_started", { userId, payload: update.payload ?? null });
    if (greeted.has(userId)) return;
    greeted.add(userId);
    await io.sendToUser(userId, GREETING_TEXT, [[appButton()]]);
    return;
  }

  if (type === "message_callback") {
    const cb = update.callback;
    const userId = String(cb?.user?.user_id ?? "");
    if (!ADMIN_IDS.has(userId)) return;

    const draft = pending.get(userId);
    if (cb?.payload === "publish") {
      if (!draft) {
        // Рестарт стёр черновик или callback из старой очереди — честный отказ,
        // повторной публикации из дубля события не бывает по построению.
        await io.answerCallback(cb.callback_id, "Черновик не найден (перезапуск?) — пришли текст заново.");
        return;
      }
      if (Date.now() - draft.ts > DRAFT_TTL_MS) {
        pending.delete(userId);
        await io.answerCallback(cb.callback_id, "Черновик устарел (прошло больше 15 минут) — пришли текст заново.");
        return;
      }
      pending.delete(userId);
      try {
        const { posted, step } = await publishWithImages(draft.text, draft.images ?? [], io);
        console.log("[bot] пост опубликован", { userId, step, messageId: posted?.message?.body?.mid ?? null });
        await io.answerCallback(cb.callback_id, "Опубликовано ✅");
      } catch (err) {
        console.error("[bot] публикация не удалась:", err.message);
        await io.answerCallback(cb.callback_id, "Не опубликовано ❌");
        await io.sendToUser(userId, `Пост НЕ опубликован. Что сломалось:\n${err.message}`);
      }
      return;
    }
    if (cb?.payload === "cancel") {
      pending.delete(userId);
      await io.answerCallback(cb.callback_id, "Отменено");
    }
  }
}

async function answerCallback(callbackId, notification) {
  return api("POST", "/answers", { query: { callback_id: callbackId }, body: { notification } });
}

/** Бесконечный цикл long polling. Ошибки не роняют процесс — пауза и дальше. */
export async function startBotPoller() {
  if (!TOKEN) { console.warn("[bot] MAX_BOT_TOKEN не задан — поллер не запущен"); return; }
  try {
    await resolveBotUsername();
    console.log(`[bot] поллер запускается: @${botUsername}, вайтлист: ${ADMIN_IDS.size || "ПУСТ (только лог id)"}`);
  } catch (err) {
    console.error("[bot] GET /me не удался, поллер не запущен:", err.message);
    return;
  }

  let marker = null;
  for (;;) {
    try {
      const query = { timeout: POLL_TIMEOUT_S, types: "message_created,message_callback,bot_started" };
      if (marker !== null) query.marker = marker;
      const res = await api("GET", "/updates", { query });
      marker = res.marker ?? marker;
      for (const u of res.updates ?? []) {
        try {
          await handleUpdate(u);
        } catch (err) {
          console.error("[bot] ошибка обработки update:", err.message);
        }
      }
    } catch (err) {
      console.error("[bot] сбой long polling, пауза:", err.message);
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    }
  }
}
