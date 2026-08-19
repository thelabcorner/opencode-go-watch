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

test("public root renders the compact status dashboard", async () => {
  const response = await worker.fetch(new Request("https://worker.example/"), env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const body = await response.text();
  assert.match(body, /OpenCode Go Watch/);
  assert.match(body, /WAITING FOR BASELINE/);
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
