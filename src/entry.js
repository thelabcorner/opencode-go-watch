import worker from "./index.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src https://models.dev; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function notFound() {
  return new Response(JSON.stringify({ error: "not found" }, null, 2), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

function telegramSetupLocked(env) {
  return Boolean(String(env?.TELEGRAM_CHAT_ID ?? "").trim());
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      request.method === "POST"
      && url.pathname === "/telegram/setup"
      && telegramSetupLocked(env)
    ) {
      // TELEGRAM_CHAT_ID is the post-bootstrap signal. Once it exists, make the
      // setup endpoint indistinguishable from an unknown route and do not perform
      // auth checks, KV reads, Telegram API calls, or any setup side effects.
      return notFound();
    }
    return worker.fetch(request, env, ctx);
  },

  scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};

export { telegramSetupLocked };
