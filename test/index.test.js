import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

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

test("public root renders the responsive status dashboard", async () => {
  const response = await worker.fetch(new Request("https://worker.example/"), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const body = await response.text();
  assert.match(body, /OpenCode Go Watch/);
  assert.match(body, /Waiting for baseline/);
  assert.match(body, /go\/watch/);
  assert.match(body, /dashboard\.js/);
  assert.doesNotMatch(body, /secret-admin|TOKEN/);
});

test("dashboard javascript is served as a same-origin static asset", async () => {
  const response = await worker.fetch(new Request("https://worker.example/dashboard.js"), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  const body = await response.text();
  assert.match(body, /data-filter/);
  assert.match(body, /data-relative/);
});

test("live dashboard renders provider logos and chart data from the stored snapshot", async () => {
  const e = env();
  await e.STATE.put("snapshot:v1", JSON.stringify({
    schema: 3,
    checkedAt: "2026-08-20T18:00:00.000Z",
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      requests: {
        "GPT 5.6 Luna": { requests5h: 2050, requestsWeek: 5100, requestsMonth: 10250 },
        Hy3: { requests5h: 4300, requestsWeek: 10750, requestsMonth: 21500 },
      },
      pricing: {
        "GPT 5.6 Luna (≤ 272K tokens)": { inputPerM: 0.2, outputPerM: 1.2, cachedReadPerM: 0.02, cachedWritePerM: 0.25, usageUsd: 15 },
        Hy3: { inputPerM: 0.14, outputPerM: 0.58, cachedReadPerM: 0.035, cachedWritePerM: null, usageUsd: 60 },
      },
      profiles: {},
      notes: {},
    },
    go: {
      chart: {
        "GPT 5.6 Luna": { requests5h: 2050, bonus: null },
        Hy3: { requests5h: 34400, bonus: "8x usage" },
      },
      promoBanner: "Hy3 gets 8× usage limits for a limited time",
    },
  }));
  const response = await worker.fetch(new Request("https://worker.example/"), e);
  const body = await response.text();
  assert.match(body, /Requests per 5 hours/);
  assert.match(body, /models\.dev\/logos\/openai\.svg/);
  assert.match(body, /models\.dev\/logos\/tencent-tokenhub\.svg/);
  assert.match(body, /8x/);
  assert.doesNotMatch(body, /secret-admin|TOKEN/);
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
