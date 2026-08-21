import test from "node:test";
import assert from "node:assert/strict";
import worker, { telegramSetupLocked } from "../src/entry.js";

function configuredEnv() {
  return {
    ADMIN_TOKEN: "secret-admin",
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
  };
}

test("Telegram setup lock is driven only by a non-empty TELEGRAM_CHAT_ID", () => {
  assert.equal(telegramSetupLocked({ TELEGRAM_CHAT_ID: "42" }), true);
  assert.equal(telegramSetupLocked({ TELEGRAM_CHAT_ID: "   " }), false);
  assert.equal(telegramSetupLocked({}), false);
});

test("configured Telegram setup route is indistinguishable from an unknown route", async () => {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => {
    outboundCalls += 1;
    throw new Error("setup route must not perform outbound work once configured");
  };

  try {
    const response = await worker.fetch(new Request("https://worker.example/telegram/setup", {
      method: "POST",
      headers: { "x-admin-token": "secret-admin" },
    }), configuredEnv());

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.equal(outboundCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram setup remains admin-protected before TELEGRAM_CHAT_ID exists", async () => {
  const response = await worker.fetch(new Request("https://worker.example/telegram/setup", {
    method: "POST",
  }), {
    ADMIN_TOKEN: "secret-admin",
    TELEGRAM_BOT_TOKEN: "TOKEN",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});
