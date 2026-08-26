import worker from "./index.js";
import { readSnapshot } from "./watcher.js";
import { readZenSnapshot } from "./zen.js";
import { buildGoUsageYieldRanking, buildZenUsageYieldRanking } from "./usage-yield.js";

const TELEGRAM_CHAT_ID_KEY = "telegram:chat_id:v1";
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src https://models.dev; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

function notFound() {
  return json({ error: "not found" }, 404);
}

function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const header = request.headers.get("x-admin-token");
  return bearer === env.ADMIN_TOKEN || header === env.ADMIN_TOKEN;
}

function serializableRanking(ranking) {
  if (!ranking) return null;
  const { byKey: _byKey, ...publicRanking } = ranking;
  return publicRanking;
}

export async function telegramSetupLocked(env) {
  if (String(env?.TELEGRAM_CHAT_ID ?? "").trim()) return true;
  if (!env?.STATE) return false;
  return Boolean(String(await env.STATE.get(TELEGRAM_CHAT_ID_KEY) ?? "").trim());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/usage-yield") {
      const snapshot = await readSnapshot(env);
      if (!snapshot) return json({ error: "no Go baseline yet" }, 404);
      return json(serializableRanking(buildGoUsageYieldRanking(snapshot)));
    }

    if (request.method === "GET" && url.pathname === "/zen/usage-yield") {
      const [zenSnapshot, goSnapshot] = await Promise.all([readZenSnapshot(env), readSnapshot(env)]);
      if (!zenSnapshot) return json({ error: "no Zen baseline yet" }, 404);
      return json(serializableRanking(buildZenUsageYieldRanking(zenSnapshot, goSnapshot)));
    }

    if (request.method === "POST" && url.pathname === "/telegram/setup") {
      // A configured environment variable can be rejected without touching KV.
      if (String(env?.TELEGRAM_CHAT_ID ?? "").trim()) return notFound();

      // Preserve the existing admin-auth boundary before consulting persisted
      // setup state, so unauthenticated scans cannot amplify KV reads.
      if (authorized(request, env) && await telegramSetupLocked(env)) return notFound();
    }

    // index.js owns dashboard rendering. Keeping that responsibility in one layer
    // prevents duplicate Usage Value sections and duplicate KV reads in production.
    return worker.fetch(request, env);
  },

  scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
