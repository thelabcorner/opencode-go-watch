import worker from "./index.js";
import { readSnapshot } from "./watcher.js";
import { readZenSnapshot } from "./zen.js";
import { buildGoUsageYieldRanking, buildZenUsageYieldRanking } from "./usage-yield.js";
import { goUsageValueSection, zenUsageValueSection } from "./usage-value-dashboard.js";

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

function injectSection(html, section) {
  if (!section) return html;
  const marker = '<section class="section wrap" id="models">';
  if (html.includes(marker)) return html.replace(marker, `${section}${marker}`);
  if (html.includes("</main>")) return html.replace("</main>", `${section}</main>`);
  return html;
}

function addValueNavigation(html) {
  if (html.includes('href="#usage-value"')) return html;
  return html.replace('<a href="#models">Models</a>', '<a href="#usage-value">Value</a><a href="#models">Models</a>');
}

async function decorateDashboardResponse(response, env, pathname) {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;
  const html = await response.text();
  if (pathname === "/") {
    const snapshot = await readSnapshot(env);
    const body = addValueNavigation(injectSection(html, goUsageValueSection(snapshot)));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  if (pathname === "/zen" || pathname === "/zen/") {
    const [zenSnapshot, goSnapshot] = await Promise.all([readZenSnapshot(env), readSnapshot(env)]);
    const body = addValueNavigation(injectSection(html, zenUsageValueSection(zenSnapshot, goSnapshot)));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
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
      const ranking = buildZenUsageYieldRanking(zenSnapshot, goSnapshot);
      return json(serializableRanking(ranking));
    }

    if (request.method === "POST" && url.pathname === "/telegram/setup") {
      // A configured environment variable can be rejected without touching KV.
      if (String(env?.TELEGRAM_CHAT_ID ?? "").trim()) return notFound();

      // Preserve the existing admin-auth boundary before consulting persisted
      // setup state, so unauthenticated scans cannot amplify KV reads.
      if (authorized(request, env) && await telegramSetupLocked(env)) return notFound();
    }

    const response = await worker.fetch(request, env);
    if (request.method === "GET" && ["/", "/zen", "/zen/"].includes(url.pathname)) {
      return decorateDashboardResponse(response, env, url.pathname);
    }
    return response;
  },

  scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
