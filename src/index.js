import { getStatus, readSnapshot, recordFailure, resetBaseline, runWatch } from "./watcher.js";
import { buildErrorMessage, sendTelegram, setupTelegram } from "./telegram.js";
import { resilientSourceFetch } from "./resilient-fetch.js";
import { dashboard, dashboardScript } from "./dashboard.js";
import { zenDashboard, zenDashboardScript } from "./zen-dashboard.js";
import { getZenStatus, readZenSnapshot, recordZenFailure, resetZenBaseline, runZenWatch } from "./zen.js";
import { buildZenBootMessage, buildZenChangeMessages, buildZenErrorMessage, buildZenRecoveryMessage, sendZenTelegram } from "./zen-telegram.js";
import {
  appendAlertEvent,
  historyEventForFailure,
  historyEventForRecovery,
  historyEventForWatchResult,
  readAlertHistory,
} from "./history.js";

const ERROR_KEY = "error:v1";
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src https://models.dev; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

const UNKNOWN_PROVIDER_LOGO = '<span class="logo"><img loading="lazy" referrerpolicy="no-referrer" src="https://models.dev/logos/labs/openai.svg" alt="Unknown logo"></span>';
const ALIBABA_PROVIDER_LOGO = '<span class="logo"><img loading="lazy" referrerpolicy="no-referrer" src="https://models.dev/logos/labs/alibaba.svg" alt="Alibaba logo"></span>';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
  });
}

function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const header = request.headers.get("x-admin-token");
  return bearer === env.ADMIN_TOKEN || header === env.ADMIN_TOKEN;
}

function adminGuard(request, env) {
  if (authorized(request, env)) return null;
  return json({ error: env.ADMIN_TOKEN ? "unauthorized" : "ADMIN_TOKEN is not configured" }, env.ADMIN_TOKEN ? 401 : 503);
}

async function previousError(env) {
  return env.STATE ? env.STATE.get(ERROR_KEY, { type: "json" }) : null;
}

function decorateGoDashboard(html) {
  return html
    .replaceAll(`${UNKNOWN_PROVIDER_LOGO}<span>Qwen`, `${ALIBABA_PROVIDER_LOGO}<span>Qwen`)
    .replaceAll(`${UNKNOWN_PROVIDER_LOGO}<div><strong>Qwen`, `${ALIBABA_PROVIDER_LOGO}<div><strong>Qwen`)
    .replace('<a href="#models">Models</a>', '<a href="#models">Models</a><a href="/zen">Zen</a>');
}

async function safeArchive(env, event) {
  if (!event) return;
  try {
    await appendAlertEvent(env, event);
  } catch (error) {
    console.error("alert history archive failed", error);
  }
}

async function archiveSuccessfulRun(env, result, priorError, now, forceNotify = false) {
  const notifyBootstrap = String(env.NOTIFY_ON_BOOTSTRAP ?? "true").toLowerCase() !== "false";
  if (result.status !== "bootstrapped" || notifyBootstrap || forceNotify) await safeArchive(env, historyEventForWatchResult(result, now));
  if (priorError) await safeArchive(env, historyEventForRecovery(priorError, now));
}

function zenEventTitle(changes) {
  const types = new Set(changes.map((change) => change.type));
  if (types.has("zen_free_model_added")) return ["🆓 OPENCODE ZEN · NEW FREE MODEL", "zen-free", "success"];
  if (types.has("zen_free_model_removed")) return ["🚫 OPENCODE ZEN · FREE MODEL REMOVED", "zen-free", "warning"];
  if (types.has("zen_model_became_free")) return ["🆓 OPENCODE ZEN · MODEL IS NOW FREE", "zen-free", "success"];
  if (types.has("zen_model_no_longer_free")) return ["💳 OPENCODE ZEN · FREE ACCESS ENDED", "zen-free", "warning"];
  if (types.has("zen_offer_added")) return ["🏷️ OPENCODE ZEN · NEW OFFER / DISCOUNT", "zen-pricing", "success"];
  if (changes.some((change) => change.type === "zen_price_changed" && typeof change.before === "number" && typeof change.after === "number" && change.after < change.before)) return ["🏷️ OPENCODE ZEN · PRICE DROP", "zen-pricing", "success"];
  if (types.has("zen_model_added")) return ["🆕 OPENCODE ZEN · MODEL ADDED", "zen-model", "info"];
  if (types.has("zen_model_removed")) return ["🗑 OPENCODE ZEN · MODEL REMOVED", "zen-model", "warning"];
  if ([...types].some((type) => type.includes("price") || type.includes("pricing"))) return ["💰 OPENCODE ZEN · PRICING UPDATE", "zen-pricing", "info"];
  if ([...types].some((type) => type.includes("unclassified"))) return ["🟡 OPENCODE ZEN · UNCLASSIFIED CHANGE", "zen-unclassified", "warning"];
  return ["🟣 OPENCODE ZEN WATCH", "zen-change", "info"];
}

function zenChangeSummary(change) {
  const name = change.after?.name ?? change.before?.name ?? change.key ?? "Zen";
  if (change.type === "zen_free_model_added") return `Free model added: ${name}`;
  if (change.type === "zen_free_model_removed") return `Free model removed: ${name}`;
  if (change.type === "zen_model_added") return `Model added: ${name}`;
  if (change.type === "zen_model_removed") return `Model removed: ${name}`;
  if (change.type === "zen_model_became_free") return `${name} became free`;
  if (change.type === "zen_model_no_longer_free") return `${name} is no longer free`;
  if (change.type === "zen_price_changed") return `${change.key} ${change.field}: ${change.before} → ${change.after}`;
  if (change.type === "zen_offer_added") return `Offer/discount added: ${change.after}`;
  if (change.type === "zen_offer_removed") return `Offer/discount removed: ${change.before}`;
  if (change.type === "zen_model_owner_changed") return `${change.key} owner: ${change.before ?? "none"} → ${change.after ?? "none"}`;
  if (change.type.startsWith("zen_deprecation")) return `${change.key}: ${change.type.replaceAll("zen_", "").replaceAll("_", " ")}`;
  return `${name}: ${change.type.replaceAll("zen_", "").replaceAll("_", " ")}`;
}

function zenHistoryEventForResult(result, now) {
  if (result.status === "bootstrapped") {
    const models = Object.values(result.snapshot?.models ?? {});
    const free = models.filter((model) => model.free).length;
    return { at: now.toISOString(), kind: "zen-armed", severity: "success", title: "🟣 OPENCODE ZEN WATCH · ARMED", detail: `${models.length} available models · ${free} free`, count: 0, message: "Zen availability and pricing monitoring is live." };
  }
  if (result.status !== "changed" || !result.changes?.length) return null;
  const [title, kind, severity] = zenEventTitle(result.changes);
  const rows = result.changes.slice(0, 12).map(zenChangeSummary);
  return { at: now.toISOString(), kind, severity, title, detail: rows.slice(0, 3).join(" · "), count: result.changes.length, changes: rows, message: rows.join("\n") };
}

function zenHistoryFailure(error, now) {
  const message = String(error?.message ?? error);
  return { at: now.toISOString(), kind: "zen-error", severity: "error", title: "🔴 OPENCODE ZEN WATCH · ERROR", detail: message, message };
}

function zenHistoryRecovery(error, now) {
  const message = String(error?.message ?? "unknown error");
  return { at: now.toISOString(), kind: "zen-recovery", severity: "success", title: "✅ OPENCODE ZEN WATCH · RECOVERED", detail: `Recovered after: ${message}`, message };
}

function zenCallbacks(env) {
  const timeZone = env.TIMEZONE || "America/Chicago";
  return {
    notifyChanges: async (changes, snapshot) => {
      for (const message of buildZenChangeMessages(changes, snapshot, timeZone)) await sendZenTelegram(env, message);
    },
    notifyBootstrap: async (snapshot) => {
      const enabled = String(env.NOTIFY_ON_ZEN_BOOTSTRAP ?? "true").toLowerCase() !== "false";
      if (enabled) await sendZenTelegram(env, buildZenBootMessage(snapshot, timeZone));
    },
    notifyRecovery: async (error, now) => sendZenTelegram(env, buildZenRecoveryMessage(error, now.toISOString(), timeZone)),
  };
}

async function manualCheck(request, env, forceNotify = false) {
  const guard = adminGuard(request, env);
  if (guard) return guard;
  const now = new Date();
  const priorError = await previousError(env);
  try {
    const result = await runWatch(env, { forceNotify, fetchImpl: resilientSourceFetch, now });
    await archiveSuccessfulRun(env, result, priorError, now, forceNotify);
    return json({ status: result.status, changes: result.changes, optimization: result.optimization });
  } catch (error) {
    const failure = await recordFailure(env, error, { fetchImpl: resilientSourceFetch, now });
    if (failure.notified) await safeArchive(env, historyEventForFailure(error, now));
    return json(failure, 502);
  }
}

async function manualZenCheck(request, env) {
  const guard = adminGuard(request, env);
  if (guard) return guard;
  const now = new Date();
  const priorError = (await getZenStatus(env)).error;
  try {
    const result = await runZenWatch(env, { fetchImpl: resilientSourceFetch, now, ...zenCallbacks(env) });
    const notifyBootstrap = String(env.NOTIFY_ON_ZEN_BOOTSTRAP ?? "true").toLowerCase() !== "false";
    if (result.status !== "bootstrapped" || notifyBootstrap) await safeArchive(env, zenHistoryEventForResult(result, now));
    if (priorError) await safeArchive(env, zenHistoryRecovery(priorError, now));
    return json({ status: result.status, changes: result.changes, optimization: result.optimization });
  } catch (error) {
    const failure = await recordZenFailure(env, error, {
      now,
      notify: async (failureError, at) => sendZenTelegram(env, buildZenErrorMessage(failureError, at.toISOString(), env.TIMEZONE || "America/Chicago")),
    });
    if (failure.notified) await safeArchive(env, zenHistoryFailure(error, now));
    return json(failure, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/dashboard.js") {
      return new Response(dashboardScript, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", ...SECURITY_HEADERS } });
    }

    if (request.method === "GET" && url.pathname === "/zen-dashboard.js") {
      return new Response(zenDashboardScript, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", ...SECURITY_HEADERS } });
    }

    if (request.method === "GET" && url.pathname === "/") {
      const [status, history] = await Promise.all([getStatus(env), readAlertHistory(env, 24)]);
      return new Response(decorateGoDashboard(dashboard(status, history)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS } });
    }

    if (request.method === "GET" && (url.pathname === "/zen" || url.pathname === "/zen/")) {
      const [status, history] = await Promise.all([getZenStatus(env), readAlertHistory(env, 96)]);
      return new Response(zenDashboard(status, history), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS } });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const status = await getStatus(env);
      return json({ ok: status.ok, configured: status.configured, meta: status.meta, error: status.error }, status.ok ? 200 : 503);
    }

    if (request.method === "GET" && url.pathname === "/zen/health") {
      const status = await getZenStatus(env);
      return json({ ok: status.ok, meta: status.meta, error: status.error, modelCount: Object.keys(status.snapshot?.models ?? {}).length, freeCount: Object.values(status.snapshot?.models ?? {}).filter((model) => model.free).length }, status.ok ? 200 : 503);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      return json(await getStatus(env));
    }

    if (request.method === "GET" && url.pathname === "/zen/status") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      return json(await getZenStatus(env));
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      const snapshot = await readSnapshot(env);
      return snapshot ? json(snapshot) : json({ error: "no baseline yet" }, 404);
    }

    if (request.method === "GET" && url.pathname === "/zen/snapshot") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      const snapshot = await readZenSnapshot(env);
      return snapshot ? json(snapshot) : json({ error: "no Zen baseline yet" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/check") return manualCheck(request, env, false);
    if (request.method === "POST" && url.pathname === "/check/notify") return manualCheck(request, env, true);
    if (request.method === "POST" && url.pathname === "/zen/check") return manualZenCheck(request, env);

    if (request.method === "POST" && url.pathname === "/baseline/reset") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      await resetBaseline(env);
      return json({ ok: true, message: "Baseline cleared; next successful check will bootstrap a new baseline." });
    }

    if (request.method === "POST" && url.pathname === "/zen/baseline/reset") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      await resetZenBaseline(env);
      return json({ ok: true, message: "Zen baseline cleared; next successful Zen check will bootstrap a new baseline." });
    }

    if (request.method === "POST" && url.pathname === "/telegram/setup") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      try {
        const setup = await setupTelegram(env);
        const status = await getStatus(env);
        if (status.error) {
          const at = new Date(status.error.lastSeenAt || new Date().toISOString());
          await sendTelegram(env, buildErrorMessage(new Error(status.error.message), at.toISOString(), env.TIMEZONE || "America/Chicago"));
          await safeArchive(env, historyEventForFailure(new Error(status.error.message), at));
        }
        return json({ ...setup, degraded: Boolean(status.error) });
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/telegram/test") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      try {
        await sendTelegram(env, "🧪 <b>OPENCODE GO WATCH · TEST</b>\n━━━━━━━━━━━━━━━━━━━━\nTelegram delivery is working.\n\n✅ HTML cards\n✅ Inline navigation\n✅ Worker → Telegram");
        return json({ ok: true });
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);

    const goTask = (async () => {
      const priorError = await previousError(env);
      try {
        const result = await runWatch(env, { now, fetchImpl: resilientSourceFetch });
        await archiveSuccessfulRun(env, result, priorError, now);
        console.log(JSON.stringify({ event: "watch.complete", surface: "go", status: result.status, changes: result.changes.length, optimization: result.optimization }));
      } catch (error) {
        console.error("Go watch failed", error);
        const failure = await recordFailure(env, error, { fetchImpl: resilientSourceFetch, now });
        if (failure.notified) await safeArchive(env, historyEventForFailure(error, now));
      }
    })();

    const zenTask = (async () => {
      const priorError = (await getZenStatus(env)).error;
      try {
        const result = await runZenWatch(env, { now, fetchImpl: resilientSourceFetch, ...zenCallbacks(env) });
        const notifyBootstrap = String(env.NOTIFY_ON_ZEN_BOOTSTRAP ?? "true").toLowerCase() !== "false";
        if (result.status !== "bootstrapped" || notifyBootstrap) await safeArchive(env, zenHistoryEventForResult(result, now));
        if (priorError) await safeArchive(env, zenHistoryRecovery(priorError, now));
        console.log(JSON.stringify({ event: "watch.complete", surface: "zen", status: result.status, changes: result.changes.length, optimization: result.optimization }));
      } catch (error) {
        console.error("Zen watch failed", error);
        const failure = await recordZenFailure(env, error, {
          now,
          notify: async (failureError, at) => sendZenTelegram(env, buildZenErrorMessage(failureError, at.toISOString(), env.TIMEZONE || "America/Chicago")),
        });
        if (failure.notified) await safeArchive(env, zenHistoryFailure(error, now));
      }
    })();

    ctx.waitUntil(Promise.all([goTask, zenTask]));
  },
};
