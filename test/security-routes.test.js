import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/entry.js";

function env(overrides = {}) {
  return {
    ADMIN_TOKEN: "secret-admin",
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
    ...overrides,
  };
}

test("Telegram setup is hidden after configuration even with valid admin auth", async () => {
  const response = await worker.fetch(new Request("https://worker.example/telegram/setup", {
    method: "POST",
    headers: { authorization: "Bearer secret-admin" },
  }), env());
  assert.equal(response.status, 404);
});

test("Telegram test is never callable without admin auth", async () => {
  const response = await worker.fetch(new Request("https://worker.example/telegram/test", {
    method: "POST",
  }), env());
  assert.equal(response.status, 401);
});
