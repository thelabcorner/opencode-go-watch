import test from "node:test";
import assert from "node:assert/strict";
import { buildZenSnapshot, diffZenSnapshots, parseZenDocs, parseZenModelsApi, runZenWatch, validateZenSnapshot } from "../src/zen.js";
import { buildZenChangeMessages, sendZenTelegram, zenKeyboard } from "../src/zen-telegram.js";
import { zenDashboard } from "../src/zen-dashboard.js";

function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function fixture(count = 24, opts = {}) {
  const endpointRows = [];
  const pricingRows = [];
  const api = [];
  for (let i = 0; i < count; i++) {
    const name = i === 0 ? "Big Pickle" : i === 1 ? "Qwen3.7 Plus" : `Example Model ${i}`;
    const id = i === 0 ? "big-pickle" : i === 1 ? "qwen3.7-plus" : `example-model-${i}`;
    endpointRows.push([name, id, "https://opencode.ai/zen/v1/chat/completions", "@ai-sdk/openai-compatible"]);
    pricingRows.push([name, i === 0 ? "Free" : `$${(1 + i / 100).toFixed(2)}`, i === 0 ? "Free" : "$2.00", i === 0 ? "Free" : "$0.10", "-"]);
    api.push({ id, object: "model", created: 1, owned_by: "opencode" });
  }
  if (opts.extraFree) {
    endpointRows.push([opts.extraFree.name, opts.extraFree.id, "https://opencode.ai/zen/v1/chat/completions", "@ai-sdk/openai-compatible"]);
    pricingRows.push([opts.extraFree.name, "Free", "Free", "Free", "-"]);
    api.push({ id: opts.extraFree.id, object: "model", created: 1, owned_by: "opencode" });
  }
  const pricing = table(["Model", "Input", "Output", "Cached Read", "Cached Write"], pricingRows);
  const deprecated = table(["Model", "Deprecation date"], [["Old Model", "August 5, 2026"]]);
  const endpoints = table(["Model", "Model ID", "Endpoint", "AI SDK Package"], endpointRows);
  const html = `<h2 id="endpoints">Endpoints</h2>${endpoints}<h2 id="pricing">Pricing</h2>${pricing}<p>DeepSeek V4 Flash / Pro: Peak hours are 01:00-04:00 and 06:00-10:00 UTC; all other hours are Off-Peak.</p><p>The free models:</p><ul><li>Big Pickle is a stealth model that's free on OpenCode for a limited time.</li>${opts.extraFree ? `<li>${opts.extraFree.name} is available on OpenCode for a limited time.</li>` : ""}</ul><h3 id="deprecated-models">Deprecated models</h3>${deprecated}<h2 id="privacy">Privacy</h2>`;
  return { html, api: JSON.stringify({ object: "list", data: api }) };
}

class FakeKV {
  map = new Map();
  async get(key, options) { const value = this.map.get(key); if (value == null) return null; return options?.type === "json" ? JSON.parse(value) : value; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

test("reverse-engineered Zen docs parser extracts endpoints, pricing, free offers and deprecations", () => {
  const docs = parseZenDocs(fixture(4).html);
  assert.equal(docs.endpoints["qwen3.7-plus"].name, "Qwen3.7 Plus");
  assert.equal(docs.pricing["Big Pickle"].free, true);
  assert.equal(docs.pricing["Qwen3.7 Plus"].inputPerM, 1.01);
  assert(docs.freeIds.includes("big-pickle"));
  assert.match(docs.freeNotes["big-pickle"], /stealth model/);
  assert.equal(docs.deprecated["Old Model"], "August 5, 2026");
  assert.match(docs.notes.deepSeekPeakHours, /Peak hours/);
  assert(docs.offers.some((offer) => /limited time/i.test(offer)));
});

test("Zen API parser treats model ids as authoritative availability", () => {
  const parsed = parseZenModelsApi(JSON.stringify({ object: "list", data: [{ id: "qwen3.7-plus", object: "model", created: 1, owned_by: "opencode" }, { id: "x-preview-f-free", object: "model", created: 1, owned_by: "opencode" }] }));
  assert.deepEqual(parsed.modelIds, ["qwen3.7-plus", "x-preview-f-free"]);
});

test("new and removed free model availability gets dedicated semantic events", () => {
  const base = fixture(4);
  const nextFixture = fixture(4, { extraFree: { id: "new-free", name: "New Free" } });
  const before = buildZenSnapshot(parseZenDocs(base.html), parseZenModelsApi(base.api), "2026-08-20T00:00:00Z");
  const after = buildZenSnapshot(parseZenDocs(nextFixture.html), parseZenModelsApi(nextFixture.api), "2026-08-20T00:05:00Z");
  assert(diffZenSnapshots(before, after).some((change) => change.type === "zen_free_model_added" && change.key === "new-free"));
  assert(diffZenSnapshots(after, before).some((change) => change.type === "zen_free_model_removed" && change.key === "new-free"));
});

test("Zen pricing decreases are explicit price-change events and render as a price drop", () => {
  const base = fixture(4);
  const docsA = parseZenDocs(base.html);
  const docsB = structuredClone(docsA);
  docsB.pricing["Qwen3.7 Plus"].inputPerM = 0.5;
  const api = parseZenModelsApi(base.api);
  const before = buildZenSnapshot(docsA, api, "2026-08-20T00:00:00Z");
  const after = buildZenSnapshot(docsB, api, "2026-08-20T00:05:00Z");
  const changes = diffZenSnapshots(before, after);
  const price = changes.find((change) => change.type === "zen_price_changed" && change.field === "inputPerM");
  assert(price);
  assert(price.percent < 0);
  assert.match(buildZenChangeMessages(changes, after)[0], /PRICE DROP/);
});

test("Zen offer wording and API ownership changes are semantic", () => {
  const base = fixture(4);
  const docsA = parseZenDocs(base.html);
  const docsB = structuredClone(docsA);
  docsB.offers = [...(docsB.offers ?? []), "Qwen3.7 Plus is 50% off for a limited time."].sort();
  const apiA = parseZenModelsApi(base.api);
  const apiRaw = JSON.parse(base.api);
  apiRaw.data.find((model) => model.id === "qwen3.7-plus").owned_by = "alibaba";
  const apiB = parseZenModelsApi(JSON.stringify(apiRaw));
  const after = buildZenSnapshot(docsB, apiB);
  const changes = diffZenSnapshots(buildZenSnapshot(docsA, apiA), after);
  assert(changes.some((change) => change.type === "zen_offer_added"));
  assert(changes.some((change) => change.type === "zen_model_owner_changed" && change.key === "qwen3.7-plus"));
  assert.match(buildZenChangeMessages(changes, after)[0], /NEW OFFER \/ DISCOUNT/);
});

test("unknown Zen docs structure changes still surface through the residual fallback", () => {
  const base = fixture(4);
  const docsA = parseZenDocs(base.html);
  const docsB = structuredClone(docsA);
  docsB.monitorStructure += ' <aside data-new-concept="true">special route</aside>';
  const api = parseZenModelsApi(base.api);
  const changes = diffZenSnapshots(buildZenSnapshot(docsA, api), buildZenSnapshot(docsB, api));
  assert(changes.some((change) => change.type === "zen_unclassified_docs_change"));
});

test("Zen validation fails closed on catastrophically small parser output", () => {
  const tiny = fixture(4);
  const snapshot = buildZenSnapshot(parseZenDocs(tiny.html), parseZenModelsApi(tiny.api));
  assert.throws(() => validateZenSnapshot(snapshot), /Zen models API found 4 models/);
});

test("Zen dashboard prioritizes free models and renders real maker logo URLs", () => {
  const fx = fixture(4, { extraFree: { id: "hy3-free", name: "Hy3 Free" } });
  const snapshot = buildZenSnapshot(parseZenDocs(fx.html), parseZenModelsApi(fx.api));
  const body = zenDashboard({ snapshot, meta: {}, error: null }, []);
  assert.match(body, /Currently free Zen models/);
  assert.match(body, /opencode\/hy3-free/);
  assert.match(body, /models\.dev\/logos\/tencent\.svg/);
  assert.match(body, /zen-dashboard\.js/);
  assert.match(body, /@media\(max-width:540px\)/);
});

test("Zen Telegram cards include the configured Zen watcher dashboard button", async () => {
  let request;
  const fakeFetch = async (url, init) => {
    request = { url, init };
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  };
  const env = {
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
    WATCHER_DASHBOARD_URL: "https://opencode-go-watch.thedabcorner.workers.dev/",
  };
  await sendZenTelegram(env, "<b>hello</b>", fakeFetch);
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body.reply_markup.inline_keyboard[0], [{
    text: "🛰 Zen Watcher Dashboard",
    url: "https://opencode-go-watch.thedabcorner.workers.dev/zen",
  }]);
  assert.equal(body.reply_markup.inline_keyboard[1].length, 2);
  assert.equal(zenKeyboard({}).inline_keyboard.length, 1);
});

test("Zen watcher bootstraps from docs + API and then uses conditional 304 fast path", async () => {
  const fx = fixture(24, { extraFree: { id: "hy3-free", name: "Hy3 Free" } });
  const env = { STATE: new FakeKV(), OPENCODE_ZEN_DOCS_URL: "https://example/zen-docs", OPENCODE_ZEN_MODELS_URL: "https://example/models" };
  let bootstrap = 0;
  const first = async (url) => new Response(url.includes("models") ? fx.api : fx.html, { status: 200, headers: { etag: url.includes("models") ? '"api1"' : '"docs1"' } });
  const result = await runZenWatch(env, { fetchImpl: first, now: new Date("2026-08-20T00:00:00Z"), notifyBootstrap: async () => { bootstrap++; } });
  assert.equal(result.status, "bootstrapped");
  assert.equal(bootstrap, 1);
  assert.equal(result.snapshot.api.modelIds.length, 25);
  const unchanged = await runZenWatch(env, { fetchImpl: async () => new Response(null, { status: 304 }), now: new Date("2026-08-20T00:05:00Z") });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.optimization, "304");
});
