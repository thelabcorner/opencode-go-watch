import { getStatus, readSnapshot, recordFailure, resetBaseline, runWatch } from "./watcher.js";
import { buildErrorMessage, sendTelegram, setupTelegram } from "./telegram.js";
import { resilientSourceFetch } from "./resilient-fetch.js";
import { dashboard, dashboardScript } from "./dashboard.js";
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

async function safeArchive(env, event) {
  if (!event) return;
  try {
    await appendAlertEvent(env, event);
  } catch (error) {
    // History is observability only: it must never block baseline advancement or
    // make a successfully delivered Telegram alert retry and duplicate.
    console.error("alert history archive failed", error);
  }
}

async function archiveSuccessfulRun(env, result, priorError, now, forceNotify = false) {
  const notifyBootstrap = String(env.NOTIFY_ON_BOOTSTRAP ?? "true").toLowerCase() !== "false";
  if (result.status !== "bootstrapped" || notifyBootstrap || forceNotify) {
    await safeArchive(env, historyEventForWatchResult(result, now));
  }
  if (priorError) await safeArchive(env, historyEventForRecovery(priorError, now));
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/dashboard.js") {
      return new Response(dashboardScript, {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", ...SECURITY_HEADERS },
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      const [status, history] = await Promise.all([getStatus(env), readAlertHistory(env, 24)]);
      return new Response(dashboard(status, history), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const status = await getStatus(env);
      return json({ ok: status.ok, configured: status.configured, meta: status.meta, error: status.error }, status.ok ? 200 : 503);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      return json(await getStatus(env));
    }

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      const snapshot = await readSnapshot(env);
      return snapshot ? json(snapshot) : json({ error: "no baseline yet" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/check") return manualCheck(request, env, false);
    if (request.method === "POST" && url.pathname === "/check/notify") return manualCheck(request, env, true);

    if (request.method === "POST" && url.pathname === "/baseline/reset") {
      const guard = adminGuard(request, env);
      if (guard) return guard;
      await resetBaseline(env);
      return json({ ok: true, message: "Baseline cleared; next successful check will bootstrap a new baseline." });
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
    ctx.waitUntil((async () => {
      const now = new Date(controller.scheduledTime);
      const priorError = await previousError(env);
      try {
        const result = await runWatch(env, { now, fetchImpl: resilientSourceFetch });
        await archiveSuccessfulRun(env, result, priorError, now);
        console.log(JSON.stringify({ event: "watch.complete", status: result.status, changes: result.changes.length, optimization: result.optimization }));
      } catch (error) {
        console.error("watch failed", error);
        const failure = await recordFailure(env, error, { fetchImpl: resilientSourceFetch, now });
        if (failure.notified) await safeArchive(env, historyEventForFailure(error, now));
      }
    })());
  },
};
