import { getStatus, readSnapshot, recordFailure, resetBaseline, runWatch } from "./watcher.js";
import { sendTelegram, setupTelegram } from "./telegram.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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

function esc(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function dashboard(status) {
  const snapshot = status.snapshot;
  const meta = status.meta ?? {};
  const models = snapshot ? Object.keys(snapshot.docs.requests).length : 0;
  const chart = snapshot ? Object.keys(snapshot.go.chart).length : 0;
  const state = status.error ? "DEGRADED" : snapshot ? "ARMED" : "WAITING FOR BASELINE";
  const stateClass = status.error ? "bad" : snapshot ? "good" : "warn";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCode Go Watch</title><style>
  :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#11110f;color:#f4f4ef}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#22221a 0,#11110f 42%)}main{width:min(820px,100%)}.eyebrow{font:700 12px ui-monospace,monospace;letter-spacing:.14em;color:#a7a79b}.card{margin-top:12px;border:1px solid #32322d;background:#181816;border-radius:18px;padding:28px;box-shadow:0 24px 80px #0008}.row{display:flex;align-items:center;justify-content:space-between;gap:16px}.pill{font:700 12px ui-monospace,monospace;padding:7px 10px;border:1px solid;border-radius:999px}.good{color:#d5e95c;border-color:#6c752f;background:#222614}.bad{color:#ff8a8a;border-color:#7e3636;background:#281515}.warn{color:#e7c96a;border-color:#756631;background:#272311}h1{font-size:clamp(30px,5vw,54px);letter-spacing:-.04em;margin:26px 0 8px}.muted{color:#9c9c93}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:28px}.metric{border:1px solid #2d2d29;background:#131311;border-radius:12px;padding:18px}.metric b{display:block;font-size:28px}.metric span{color:#929288;font-size:13px}code{font-family:ui-monospace,monospace;color:#c9d75b}footer{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}a{color:#d5e95c;text-decoration:none;border-bottom:1px solid #5b632b}@media(max-width:650px){.grid{grid-template-columns:1fr}.card{padding:20px}}
  </style></head><body><main><div class="eyebrow">OPENCODE GO / SEMANTIC MONITOR</div><section class="card"><div class="row"><span class="pill ${stateClass}">${esc(state)}</span><span class="muted">Telegram ${status.configured ? "configured" : "not configured"}</span></div><h1>OpenCode Go Watch</h1><div class="muted">Semantic monitoring of the Go usage chart and usage-limit documentation every 5 minutes.</div><div class="grid"><div class="metric"><b>${models}</b><span>docs models</span></div><div class="metric"><b>${chart}</b><span>chart models</span></div><div class="metric"><b>${esc(meta.lastChangeCount ?? 0)}</b><span>fields in last change</span></div></div><p class="muted">Last successful heartbeat: <code>${esc(meta.lastSuccessAt ?? "not yet")}</code></p>${status.error ? `<p class="bad pill">${esc(status.error.message)}</p>` : ""}<footer><a href="/health">Health JSON</a><a href="https://opencode.ai/go">Open Go</a><a href="https://opencode.ai/docs/go/#usage-limits">Usage docs</a></footer></section></main></body></html>`;
}

async function manualCheck(request, env, forceNotify = false) {
  const guard = adminGuard(request, env);
  if (guard) return guard;
  try {
    const result = await runWatch(env, { forceNotify });
    return json({ status: result.status, changes: result.changes, optimization: result.optimization });
  } catch (error) {
    const failure = await recordFailure(env, error);
    return json(failure, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      const status = await getStatus(env);
      return new Response(dashboard(status), {
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
        return json(await setupTelegram(env));
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
      try {
        const result = await runWatch(env, { now: new Date(controller.scheduledTime) });
        console.log(JSON.stringify({ event: "watch.complete", status: result.status, changes: result.changes.length, optimization: result.optimization }));
      } catch (error) {
        console.error("watch failed", error);
        await recordFailure(env, error);
      }
    })());
  },
};
