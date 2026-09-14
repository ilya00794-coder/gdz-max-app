// api.dmshk.ru → прокси на бэкенд Домашки (14.09.2026).
// Живёт на краю Cloudflare: дети ходят на обычный домен, воркер из облака
// пробрасывает на ngrok (блокировки/DNS-фильтры операторов не мешают).
const ORIGIN = "https://whacking-ramble-womb.ngrok-free.dev";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = ORIGIN + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.set("ngrok-skip-browser-warning", "true"); // заглушка ngrok — мимо
    const resp = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
      // Кэш выключен: он подменял ответ на 200 и ломал Range-докачку
      // (нужна при DPI, который рвёт длинные загрузки — кейс 14.09).
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  },
};
