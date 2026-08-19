import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readSnapshot, runWatch } from "../src/watcher.js";

const goHtml = await readFile(new URL("./fixtures/go.html", import.meta.url), "utf8");
const docsHtml = await readFile(new URL("./fixtures/docs.html", import.meta.url), "utf8");

class FakeKV {
  map = new Map();
  writes = [];
  deletes = [];
  async get(key, opts) {
    const value = this.map.get(key);
    if (value == null) return null;
    return opts?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.writes.push(key);
    this.map.set(key, value);
  }
  async delete(key) {
    this.deletes.push(key);
    this.map.delete(key);
  }
}

function makeFetch({ go = goHtml, docs = docsHtml, telegram = [], telegramStatus = 200 } = {}) {
  return async (url, init = {}) => {
    if (url === "https://opencode.ai/go") return new Response(go, { status: 200 });
    if (url === "https://opencode.ai/docs/go/") return new Response(docs, { status: 200 });
    if (String(url).startsWith("https://api.telegram.org/")) {
      if (init.body) telegram.push(JSON.parse(init.body));
      return new Response(telegramStatus === 200 ? '{"ok":true,"result":{}}' : '{"ok":false,"description":"simulated outage"}', { status: telegramStatus });
    }
    return new Response("not found", { status: 404 });
  };
}

function env() {
  return {
    STATE: new FakeKV(),
    OPENCODE_GO_URL: "https://opencode.ai/go",
    OPENCODE_DOCS_URL: "https://opencode.ai/docs/go/",
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
    NOTIFY_ON_BOOTSTRAP: "true",
    TIMEZONE: "America/Chicago",
  };
}

test("first run captures baseline and sends one armed message", async () => {
  const e = env();
  const telegram = [];
  const result = await runWatch(e, { fetchImpl: makeFetch({ telegram }), now: new Date("2026-08-19T18:00:00Z") });
  assert.equal(result.status, "bootstrapped");
  assert.equal(telegram.length, 1);
  assert.match(telegram[0].text, /WATCH · ARMED/);
  assert.equal((await readSnapshot(e)).docs.requests["GPT 5.6 Luna"].requests5h, 2050);
});

test("unchanged runs are silent and do not burn KV writes every five minutes", async () => {
  const e = env();
  await runWatch(e, { fetchImpl: makeFetch(), now: new Date("2026-08-19T18:00:00Z") });
  const writesAfterBootstrap = e.STATE.writes.length;
  const telegram = [];
  const result = await runWatch(e, { fetchImpl: makeFetch({ telegram }), now: new Date("2026-08-19T18:05:00Z") });
  assert.equal(result.status, "unchanged");
  assert.equal(telegram.length, 0);
  assert.equal(e.STATE.writes.length, writesAfterBootstrap);
});

test("changed docs data produces one grouped semantic Telegram card", async () => {
  const e = env();
  await runWatch(e, { fetchImpl: makeFetch(), now: new Date("2026-08-19T18:00:00Z") });
  const changed = docsHtml.replace("<td>2,050</td><td>5,100</td><td>10,250</td>", "<td>2,300</td><td>5,750</td><td>11,500</td>");
  const telegram = [];
  const result = await runWatch(e, { fetchImpl: makeFetch({ docs: changed, telegram }), now: new Date("2026-08-19T18:05:00Z") });
  assert.equal(result.status, "changed");
  assert.equal(result.changes.filter((change) => change.type === "request_limit_changed").length, 3);
  assert.equal(telegram.length, 1);
  assert.equal((telegram[0].text.match(/REQUEST LIMIT CHANGED/g) ?? []).length, 1);
  assert.match(telegram[0].text, /2,050 → 2,300/);
});

test("historical grouped-profile model launch becomes one rich new-model alert", async () => {
  const e = env();
  const beforeDocs = docsHtml
    .replace('<tr><td>GLM-5.3</td><td>220</td><td>540</td><td>1,080</td></tr>\n', "")
    .replace("GLM-5.3/5.2/5.1", "GLM-5.2/5.1")
    .replace('<tr><td>GLM-5.3</td><td>$1.40</td><td>$4.40</td><td>$0.26</td><td>-</td><td>$15</td></tr>\n', "");
  await runWatch(e, { fetchImpl: makeFetch({ docs: beforeDocs }), now: new Date("2026-08-19T18:00:00Z") });
  const telegram = [];
  const result = await runWatch(e, { fetchImpl: makeFetch({ telegram }), now: new Date("2026-08-19T18:05:00Z") });
  assert.equal(result.status, "changed");
  assert(result.changes.some((change) => change.type === "model_added" && change.key === "GLM-5.3"));
  assert(result.changes.some((change) => change.type === "request_profile_added" && change.key === "GLM-5.3"));
  assert.match(telegram[0].text, /NEW MODEL/);
  assert.equal((telegram[0].text.match(/MODEL ADDED/g) ?? []).length, 1);
  assert.doesNotMatch(telegram[0].text, /REQUEST PROFILE ADDED/);
  assert.doesNotMatch(telegram[0].text, /PRICING ROW ADDED/);
});

test("promotion transition reports chart value and bonus semantically", async () => {
  const e = env();
  const beforeGo = goHtml
    .replace("Hy3 gets 8× usage limits for a limited time", "No special usage promotion")
    .replace('<span data-item data-kind="go" data-model="hy3"><span data-value>34,400</span><span data-name>Hy3</span><span data-bonus>8x usage</span></span>', '<span data-item data-kind="go" data-model="hy3"><span data-value>4,300</span><span data-name>Hy3</span></span>');
  await runWatch(e, { fetchImpl: makeFetch({ go: beforeGo }), now: new Date("2026-08-19T18:00:00Z") });
  const telegram = [];
  const result = await runWatch(e, { fetchImpl: makeFetch({ telegram }), now: new Date("2026-08-19T18:05:00Z") });
  assert.equal(result.status, "changed");
  assert(result.changes.some((change) => change.type === "chart_changed" && change.key === "Hy3" && change.field === "requests5h"));
  assert(result.changes.some((change) => change.type === "chart_changed" && change.key === "Hy3" && change.field === "bonus"));
  assert.match(telegram[0].text, /GO CHART CHANGED/);
  assert.match(telegram[0].text, /4,300 → 34,400/);
  assert.match(telegram[0].text, /none → 8x usage/);
});

test("Telegram failure preserves old baseline so the change will retry", async () => {
  const e = env();
  await runWatch(e, { fetchImpl: makeFetch(), now: new Date("2026-08-19T18:00:00Z") });
  const changed = docsHtml.replace("<td>2,050</td><td>5,100</td><td>10,250</td>", "<td>2,300</td><td>5,750</td><td>11,500</td>");
  await assert.rejects(
    runWatch(e, { fetchImpl: makeFetch({ docs: changed, telegramStatus: 502 }), now: new Date("2026-08-19T18:05:00Z") }),
    /Telegram sendMessage failed/,
  );
  assert.equal((await readSnapshot(e)).docs.requests["GPT 5.6 Luna"].requests5h, 2050);
});

test("catastrophic parser shrink is rejected instead of announcing mass removals", async () => {
  const e = env();
  await runWatch(e, { fetchImpl: makeFetch(), now: new Date("2026-08-19T18:00:00Z") });
  const brokenGo = '<figure><span data-value>1</span><span data-name>Only One</span></figure>';
  await assert.rejects(
    runWatch(e, { fetchImpl: makeFetch({ go: brokenGo }), now: new Date("2026-08-19T18:05:00Z") }),
    /chart parser found 1 models/,
  );
  assert.equal(Object.keys((await readSnapshot(e)).go.chart).length, 11);
});
