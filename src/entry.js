import worker from "./index.js";

const TELEGRAM_CHAT_ID_KEY = "telegram:chat_id:v1";
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

function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const header = request.headers.get("x-admin-token");
  return bearer === env.ADMIN_TOKEN || header === env.ADMIN_TOKEN;
}

export async function telegramSetupLocked(env) {
  if (String(env?.TELEGRAM_CHAT_ID ?? "").trim()) return true;
  if (!env?.STATE) return false;
  return Boolean(String(await env.STATE.get(TELEGRAM_CHAT_ID_KEY) ?? "").trim());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram/setup") {
      // A configured environment variable can be rejected without touching KV.
      if (String(env?.TELEGRAM_CHAT_ID ?? "").trim()) return notFound();

      // Preserve the existing admin-auth boundary before consulting persisted
      // setup state, so unauthenticated scans cannot amplify KV reads.
      if (authorized(request, env) && await telegramSetupLocked(env)) return notFound();
    }
    return worker.fetch(request, env);
  },

  scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
