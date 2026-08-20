import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { appendAlertEvent } from "../src/history.js";

class FakeKV {
  map = new Map();
  async get(key, options) {
    const value = this.map.get(key);
    if (value == null) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

function env() {
  return {
    STATE: new FakeKV(),
    ADMIN_TOKEN: "secret-admin",
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
  };
}

function dashboardSnapshot() {
  return {
    schema: 3,
    checkedAt: "2026-08-20T18:00:00.000Z",
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      requests: {
        "GPT 5.6 Luna": { requests5h: 2050, requestsWeek: 5100, requestsMonth: 10250 },
        "DeepSeek V4 Flash": { requests5h: 7600, requestsWeek: 18900, requestsMonth: 37800 },
        "Qwen3.7 Plus": { requests5h: 4300, requestsWeek: 10800, requestsMonth: 21600 },
        Hy3: { requests5h: 4300, requestsWeek: 10750, requestsMonth: 21500 },
        "GLM-5.3": { requests5h: 220, requestsWeek: 540, requestsMonth: 1080 },
      },
      pricing: {
        "GPT 5.6 Luna (≤ 272K tokens)": { inputPerM: 0.2, outputPerM: 1.2, cachedReadPerM: 0.02, cachedWritePerM: 0.25, usageUsd: 15 },
        "GPT 5.6 Luna (> 272K tokens)": { inputPerM: 0.4, outputPerM: 1.8, cachedReadPerM: 0.04, cachedWritePerM: 0.5, usageUsd: 15 },
        "DeepSeek V4 Flash (Off-Peak)": { inputPerM: 0.22, outputPerM: 0.66, cachedReadPerM: 0.007, cachedWritePerM: null, usageUsd: 30 },
        "DeepSeek V4 Flash (Peak)": { inputPerM: 0.44, outputPerM: 1.32, cachedReadPerM: 0.014, cachedWritePerM: null, usageUsd: 30 },
        "Qwen3.7 Plus (≤ 256K tokens)": { inputPerM: 0.4, outputPerM: 1.6, cachedReadPerM: 0.04, cachedWritePerM: 0.5, usageUsd: 60 },
        "Qwen3.7 Plus (> 256K tokens)": { inputPerM: 1.2, outputPerM: 4.8, cachedReadPerM: 0.12, cachedWritePerM: 1.5, usageUsd: 60 },
        Hy3: { inputPerM: 0.14, outputPerM: 0.58, cachedReadPerM: 0.035, cachedWritePerM: null, usageUsd: 60 },
        "GLM-5.3": { inputPerM: 1.4, outputPerM: 4.4, cachedReadPerM: 0.26, cachedWritePerM: null, usageUsd: 15 },
      },
      profiles: {
        "DeepSeek V4 Flash": { inputTokens: 410, cachedTokens: 71300, outputTokens: 310 },
      },
      notes: {
        deepSeekPeakHours: "DeepSeek V4 Flash / Pro: Peak hours are 01:00-04:00 and 06:00-10:00 UTC; all other hours are Off-Peak.",
      },
    },
    go: {
      chart: {
        "GPT 5.6 Luna": { requests5h: 2050, bonus: null },
        "DeepSeek V4 Flash": { requests5h: 7600, bonus: null },
        Hy3: { requests5h: 34400, bonus: "8x usage" },
      },
      promoBanner: "Hy3 gets 8× usage limits for a limited time",
    },
  };
}

test("public root renders the responsive status dashboard", async () => {
  const response = await worker.fetch(new Request("https://worker.example/"), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const body = await response.text();
  assert.match(body, /OpenCode Go Watch/);
  assert.match(body, /Waiting for baseline/);
  assert.match(body, /go\/watch/);
  assert.match(body, /dashboard\.js/);
  assert.match(body, /Last persisted heartbeat/);
  assert.match(body, /Checks run every 5m/);
  assert.match(body, /@media\(max-width:780px\)/);
  assert.match(body, /@media\(max-width:520px\)/);
  assert.doesNotMatch(body, /secret-admin|TOKEN/);
});

test("dashboard javascript is served as a same-origin static asset", async () => {
  const response = await worker.fetch(new Request("https://worker.example/dashboard.js"), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  const body = await response.text();
  assert.match(body, /data-filter/);
  assert.match(body, /data-relative/);
  assert.match(body, /data-alert-message/);
  assert.match(body, /scrollBy/);
});

test("live dashboard renders every docs model, maker logos, pricing tiers and DeepSeek peak economics", async () => {
  const e = env();
  await e.STATE.put("snapshot:v1", JSON.stringify(dashboardSnapshot()));
  const response = await worker.fetch(new Request("https://worker.example/"), e);
  const body = await response.text();

  assert.match(body, /All monitored models · requests per 5 hours/);
  assert.match(body, /all 5 visualized/);
  assert.equal((body.match(/class="bar-entry"/g) ?? []).length, 5, "every docs request-table model should get a bar");
  assert.match(body, /GLM-5\.3/);
  assert.match(body, /docs estimate/);

  assert.match(body, /models\.dev\/logos\/labs\/openai\.svg/);
  assert.match(body, /models\.dev\/logos\/labs\/deepseek\.svg/);
  assert.match(body, /models\.dev\/logos\/labs\/alibaba\.svg/);
  assert.match(body, /models\.dev\/logos\/labs\/tencent\.svg/);

  assert.match(body, /8x promo/);
  assert.match(body, /Off-Peak: in \$0\.22/);
  assert.match(body, /Peak: in \$0\.44/);
  assert.match(body, /included credit Δ 0%/);
  assert.match(body, /same-spend capacity -50%/);
  assert.match(body, /Peak input \+100% · capacity -50%/);
  assert.match(body, /Peak same-spend capacity/);

  assert.match(body, /≤ 272K tokens/);
  assert.match(body, /&gt; 272K tokens/);
  assert.match(body, /tier delta: input \+100% · output \+50% · cache \+100%/);
  assert.match(body, /≤ 256K tokens/);
  assert.match(body, /tier delta: input \+200% · output \+200% · cache \+200%/);
  assert.doesNotMatch(body, /secret-admin|TOKEN/);
});

test("root renders Brotli-backed historical Telegram alerts above the all-model chart", async () => {
  const e = env();
  await e.STATE.put("snapshot:v1", JSON.stringify(dashboardSnapshot()));
  const archived = await appendAlertEvent(e, {
    id: "evt-1",
    at: "2026-08-20T18:05:00.000Z",
    kind: "pricing",
    severity: "info",
    title: "💰 OPENCODE GO · PRICING UPDATE",
    detail: "DeepSeek V4 Flash: input price $0.22 → $0.20",
    count: 1,
    message: "DeepSeek V4 Flash input price changed.",
  });
  assert.equal(archived.archived, true);
  assert(archived.compressedBytes < archived.rawBytes, "history should be Brotli-compressed before KV storage");

  const response = await worker.fetch(new Request("https://worker.example/"), e);
  const body = await response.text();
  assert.match(body, /Historical Telegram alerts/);
  assert.match(body, /Actual actionable bot events only/);
  assert.match(body, /PRICING UPDATE/);
  assert.match(body, /96-event rolling cap/);
  assert(body.indexOf('id="alerts"') < body.indexOf('id="chart"'), "alert carousel should render above the bar chart");
});

test("admin status rejects unauthenticated access", async () => {
  const response = await worker.fetch(new Request("https://worker.example/status"), env());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("admin status accepts bearer auth and never echoes secrets", async () => {
  const e = env();
  const response = await worker.fetch(new Request("https://worker.example/status", {
    headers: { authorization: "Bearer secret-admin" },
  }), e);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /secret-admin|TOKEN/);
  const data = JSON.parse(body);
  assert.equal(data.configured, true);
});

test("health is public but limited to operational state", async () => {
  const response = await worker.fetch(new Request("https://worker.example/health"), env());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ["configured", "error", "meta", "ok"]);
});

test("baseline reset requires auth and clears stored baseline", async () => {
  const e = env();
  await e.STATE.put("snapshot:v1", JSON.stringify({ any: "baseline" }));
  const response = await worker.fetch(new Request("https://worker.example/baseline/reset", {
    method: "POST",
    headers: { "x-admin-token": "secret-admin" },
  }), e);
  assert.equal(response.status, 200);
  assert.equal(await e.STATE.get("snapshot:v1"), null);
});
