import test from "node:test";
import assert from "node:assert/strict";
import { buildBootMessage, buildChangeMessages, escapeHtml, sendTelegram, setupTelegram, telegramKeyboard, watcherDashboardUrl } from "../src/telegram.js";

test("escapes Telegram HTML", () => {
  assert.equal(escapeHtml('A < B & "C"'), "A &lt; B &amp; &quot;C&quot;");
});

test("renders rich grouped change cards with deltas", () => {
  const messages = buildChangeMessages([
    { type: "request_limit_changed", key: "GPT 5.6 Luna", field: "requests5h", before: 2050, after: 2300, percent: (250 / 2050) * 100 },
    { type: "request_limit_changed", key: "GPT 5.6 Luna", field: "requestsWeek", before: 5100, after: 5750, percent: (650 / 5100) * 100 },
    { type: "pricing_changed", key: "Grok 4.5", field: "cachedReadPerM", before: 0.3, after: 0.35, percent: (0.05 / 0.3) * 100 },
  ], {
    checkedAt: "2026-08-19T18:30:00.000Z",
    docs: { pricing: {}, profiles: {} },
    go: { chart: {} },
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /OPENCODE GO/);
  assert.match(messages[0], /REQUEST LIMIT CHANGED/);
  assert.equal((messages[0].match(/GPT 5\.6 Luna/g) ?? []).length, 1);
  assert.match(messages[0], /2,050 → 2,300/);
  assert.match(messages[0], /5,100 → 5,750/);
  assert.ok(messages[0].length < 4096);
});

test("new model lifecycle is rendered as one rich model card", () => {
  const snapshot = {
    checkedAt: "2026-08-19T18:30:00.000Z",
    docs: {
      profiles: { "GLM-5.4": { inputTokens: 700, cachedTokens: 52000, outputTokens: 150 } },
      pricing: { "GLM-5.4": { inputPerM: 1, outputPerM: 3, cachedReadPerM: 0.2, cachedWritePerM: null, usageUsd: 15 } },
    },
    go: { chart: {} },
  };
  const messages = buildChangeMessages([
    { type: "model_added", key: "GLM-5.4", after: { requests5h: 300, requestsWeek: 750, requestsMonth: 1500 } },
    { type: "request_profile_added", key: "GLM-5.4", after: snapshot.docs.profiles["GLM-5.4"] },
    { type: "pricing_row_added", key: "GLM-5.4", after: snapshot.docs.pricing["GLM-5.4"] },
  ], snapshot);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /NEW MODEL/);
  assert.equal((messages[0].match(/MODEL ADDED/g) ?? []).length, 1);
  assert.doesNotMatch(messages[0], /REQUEST PROFILE ADDED/);
  assert.doesNotMatch(messages[0], /PRICING ROW ADDED/);
});

test("watcher dashboard URL is normalized and safely scoped", () => {
  const env = { WATCHER_DASHBOARD_URL: "https://watch.example/base?x=1#hash" };
  assert.equal(watcherDashboardUrl(env, "/"), "https://watch.example/");
  assert.equal(watcherDashboardUrl(env, "/zen"), "https://watch.example/zen");
  assert.equal(watcherDashboardUrl({ WATCHER_DASHBOARD_URL: "javascript:alert(1)" }), null);
});

test("Telegram sender posts HTML and watcher dashboard inline keyboard", async () => {
  let request;
  const fakeFetch = async (url, init) => {
    request = { url, init };
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  };
  const env = {
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
    WATCHER_DASHBOARD_URL: "https://opencode-go-watch.thedabcorner.workers.dev",
  };
  await sendTelegram(env, "<b>hello</b>", fakeFetch);
  assert.equal(request.url, "https://api.telegram.org/botTOKEN/sendMessage");
  const body = JSON.parse(request.init.body);
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.reply_markup.inline_keyboard.length, 2);
  assert.deepEqual(body.reply_markup.inline_keyboard[0], [{
    text: "🛰 Watcher Dashboard",
    url: "https://opencode-go-watch.thedabcorner.workers.dev/",
  }]);
  assert.equal(body.reply_markup.inline_keyboard[1].length, 2);
});

test("Telegram keyboard remains usable without dashboard configuration", () => {
  const keyboard = telegramKeyboard({});
  assert.equal(keyboard.inline_keyboard.length, 1);
  assert.equal(keyboard.inline_keyboard[0].length, 2);
});

test("Telegram setup verifies bot, discovers private chat, stores id, and sends test", async () => {
  const calls = [];
  const kv = new Map();
  const env = {
    TELEGRAM_BOT_TOKEN: "TOKEN",
    STATE: {
      async get(key) { return kv.get(key) ?? null; },
      async put(key, value) { kv.set(key, value); },
    },
  };
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/getMe")) return new Response('{"ok":true,"result":{"username":"GoWatchBot"}}');
    if (url.includes("/getUpdates?")) return new Response('{"ok":true,"result":[{"message":{"chat":{"id":123,"type":"private"}}}]}');
    if (url.endsWith("/sendMessage")) return new Response('{"ok":true,"result":{}}');
    return new Response('{"ok":false}', { status: 404 });
  };
  const result = await setupTelegram(env, fakeFetch);
  assert.equal(result.bot, "GoWatchBot");
  assert.equal(result.chatIdSuffix, "123");
  assert.equal(kv.get("telegram:chat_id:v1"), "123");
  assert.equal(calls.length, 3);
});

test("boot message is compact and reports promotion cross-check", () => {
  const msg = buildBootMessage({
    checkedAt: "2026-08-19T18:00:00.000Z",
    docs: { requests: { A: { requests5h: 100 } }, limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 } },
    go: { chart: { A: { requests5h: 200, bonus: "2x usage" } }, promoBanner: "A gets 2× usage limits for a limited time" },
  });
  assert.match(msg, /WATCH · ARMED/);
  assert.match(msg, /A 2x/);
  assert.ok(msg.length < 1200);
});
