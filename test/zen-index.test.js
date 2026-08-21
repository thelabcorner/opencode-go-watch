import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class FakeKV {
  map = new Map();
  async get(key, options) {
    const value = this.map.get(key);
    if (value == null) return null;
    if (options?.type === "json") return JSON.parse(value);
    return value;
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

test("public Zen dashboard is a separate responsive page", async () => {
  const response = await worker.fetch(new Request("https://worker.example/zen"), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const body = await response.text();
  assert.match(body, /Zen model tracker/);
  assert.match(body, /zen-dashboard\.js/);
  assert.match(body, /Waiting for baseline/);
  assert.match(body, /Currently free Zen models/);
  assert.match(body, /@media\(max-width:540px\)/);
  assert.doesNotMatch(body, /secret-admin|TOKEN/);
});

test("Zen dashboard javascript is served same-origin", async () => {
  const response = await worker.fetch(new Request("https://worker.example/zen-dashboard.js"), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  const body = await response.text();
  assert.match(body, /data-filter/);
  assert.match(body, /data-relative/);
});

test("public Zen health exposes only compact operational state", async () => {
  const response = await worker.fetch(new Request("https://worker.example/zen/health"), env());
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.ok, false);
  assert.equal(data.modelCount, 0);
  assert.equal(data.freeCount, 0);
  assert(!("snapshot" in data));
});

test("Zen admin routes require authentication", async () => {
  for (const path of ["/zen/status", "/zen/snapshot"]) {
    const response = await worker.fetch(new Request(`https://worker.example${path}`), env());
    assert.equal(response.status, 401);
  }
});

test("Zen baseline reset is protected and clears only Zen state", async () => {
  const e = env();
  await e.STATE.put("zen:snapshot:v1", JSON.stringify({ schema: 1 }));
  await e.STATE.put("snapshot:v1", JSON.stringify({ schema: 3 }));
  const denied = await worker.fetch(new Request("https://worker.example/zen/baseline/reset", { method: "POST" }), e);
  assert.equal(denied.status, 401);
  const response = await worker.fetch(new Request("https://worker.example/zen/baseline/reset", {
    method: "POST",
    headers: { authorization: "Bearer secret-admin" },
  }), e);
  assert.equal(response.status, 200);
  assert.equal(await e.STATE.get("zen:snapshot:v1"), null);
  assert.notEqual(await e.STATE.get("snapshot:v1"), null, "Go baseline must remain independent");
});
