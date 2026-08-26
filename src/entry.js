import worker from "./index.js";
import { readSnapshot } from "./watcher.js";
import { readZenSnapshot } from "./zen.js";
import { buildGoUsageYieldRanking, buildZenUsageYieldRanking } from "./usage-yield.js";
import { usageValueRankScript } from "./usage-value-rank.js";

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

function isDashboardPath(pathname) {
  return pathname === "/" || pathname === "/zen" || pathname === "/zen/";
}

async function injectUsageValueRankScript(response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return response;
  const html = await response.text();
  if (html.includes('src="/usage-value-rank.js"')) return new Response(html, response);
  const decorated = html.replace("</head>", '<script src="/usage-value-rank.js" defer></script></head>');
  return new Response(decorated, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function telegramSetupLocked(env) {
  if (String(env?.TELEGRAM_CHAT_ID ?? "").trim()) return true;
  if (!env?.STATE) return false;
  return Boolean(String(await env.STATE.get(TELEGRAM_CHAT_ID_KEY) ?? "").trim());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/usage-value-rank.js") {
      return new Response(usageValueRankScript, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          ...SECURITY_HEADERS,
        },
      });
    }

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

    // index.js owns dashboard rendering. The production entry only layers on the
    // rank-order enhancer after the complete V2 leaderboard is already present,
    // so the client reuses the exact derived rank instead of recalculating economics.
    const response = await worker.fetch(request, env);
    if (request.method === "GET" && isDashboardPath(url.pathname)) return injectUsageValueRankScript(response);
    return response;
  },

  scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};