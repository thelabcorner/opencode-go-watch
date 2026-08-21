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

function stateWithChatId(chatId = "42") {
  return {
    async get(key) {
      return key === "telegram:chat_id:v1" ? chatId : null;
    },
  };
}

test("Telegram setup lock recognizes env and persisted chat configuration", async () => {
  assert.equal(await telegramSetupLocked({ TELEGRAM_CHAT_ID: "42" }), true);
  assert.equal(await telegramSetupLocked({ TELEGRAM_CHAT_ID: "   " }), false);
  assert.equal(await telegramSetupLocked({ STATE: stateWithChatId("42") }), true);
  assert.equal(await telegramSetupLocked({ STATE: stateWithChatId("   ") }), false);
  assert.equal(await telegramSetupLocked({}), false);
});

test("env-configured Telegram setup route is indistinguishable from an unknown route", async () => {
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

test("KV-configured Telegram setup route is also disabled without variable migration", async () => {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => {
    outboundCalls += 1;
    throw new Error("locked setup route must not call Telegram");
  };

  try {
    const response = await worker.fetch(new Request("https://worker.example/telegram/setup", {
      method: "POST",
      headers: { "x-admin-token": "secret-admin" },
    }), {
      ADMIN_TOKEN: "secret-admin",
      TELEGRAM_BOT_TOKEN: "TOKEN",
      STATE: stateWithChatId("42"),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.equal(outboundCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram setup remains admin-protected before chat configuration exists", async () => {
  const response = await worker.fetch(new Request("https://worker.example/telegram/setup", {
    method: "POST",
  }), {
    ADMIN_TOKEN: "secret-admin",
    TELEGRAM_BOT_TOKEN: "TOKEN",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("Telegram test route rejects requests without the admin API key", async () => {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => {
    outboundCalls += 1;
    throw new Error("unauthorized test route must not call Telegram");
  };

  try {
    const response = await worker.fetch(new Request("https://worker.example/telegram/test", {
      method: "POST",
    }), configuredEnv());

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(outboundCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram test route accepts the admin API key and sends exactly one test message", async () => {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (url, init = {}) => {
    outbound.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return new Response('{"ok":true,"result":{}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await worker.fetch(new Request("https://worker.example/telegram/test", {
      method: "POST",
      headers: { "x-admin-token": "secret-admin" },
    }), configuredEnv());

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].url, /api\.telegram\.org\/botTOKEN\/sendMessage/);
    assert.equal(outbound[0].body.chat_id, "42");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
