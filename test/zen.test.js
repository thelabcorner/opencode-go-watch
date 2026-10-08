import test from "node:test";
import assert from "node:assert/strict";
import { buildZenSnapshot, canonicalZenModelsApiText, diffZenSnapshots, parseZenDocs, parseZenModelsApi, runZenWatch, validateZenSnapshot } from "../src/zen.js";
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

test("Zen policy notes preserve decimal punctuation instead of truncating it", () => {
  const fx = fixture(4);
  const html = fx.html.replace(
    '<h2 id="privacy">',
    '<p>Credit card fees are passed along at cost (4.4% + $0.30 per transaction); we do not charge anything beyond that.</p><p>If your balance goes below $5, Zen will automatically reload $20.</p><h2 id="privacy">',
  );
  const docs = parseZenDocs(html);
  assert.equal(docs.notes.cardFees, "Credit card fees are passed along at cost (4.4% + $0.30 per transaction); we do not charge anything beyond that.");
  assert.equal(docs.notes.autoReload, "If your balance goes below $5, Zen will automatically reload $20.");
});

test("Zen API parser treats model ids as authoritative availability", () => {
  const parsed = parseZenModelsApi(JSON.stringify({ object: "list", data: [{ id: "qwen3.7-plus", object: "model", created: 1, owned_by: "opencode" }, { id: "x-preview-f-free", object: "model", created: 1, owned_by: "opencode" }] }));
  assert.deepEqual(parsed.modelIds, ["qwen3.7-plus", "x-preview-f-free"]);
});

test("Zen free pricing recognizes unavailable cache operations without inferring unknown or paid cache prices as free", () => {
  const fx = fixture(4);
  const freeCacheOmitted = fx.html.replace(
    "<td>Big Pickle</td><td>Free</td><td>Free</td><td>Free</td><td>-</td>",
    "<td>Big Pickle</td><td>Free</td><td>Free</td><td>-</td><td>-</td>",
  ).replace(
    "<td>Qwen3.7 Plus</td><td>$1.01</td><td>$2.00</td><td>$0.10</td><td>-</td>",
    "<td>Qwen3.7 Plus</td><td>Free</td><td>Free</td><td>—</td><td>—</td>",
  );
  const docs = parseZenDocs(freeCacheOmitted);
  assert.equal(docs.pricing["Big Pickle"].free, true);
  assert.equal(docs.pricing["Qwen3.7 Plus"].free, true, "free-row handling must generalize to an unrelated model");
  assert.equal(buildZenSnapshot(docs, parseZenModelsApi(fx.api)).models["qwen3.7-plus"].free, true);
  const knownCharge = parseZenDocs(freeCacheOmitted.replace(
    "<td>Qwen3.7 Plus</td><td>Free</td><td>Free</td><td>—</td><td>—</td>",
    "<td>Qwen3.7 Plus</td><td>Free</td><td>Free</td><td>$0.10</td><td>—</td>",
  ));
  assert.equal(knownCharge.pricing["Qwen3.7 Plus"].free, false);
  const unknownCache = parseZenDocs(freeCacheOmitted.replace(
    "<td>Qwen3.7 Plus</td><td>Free</td><td>Free</td><td>—</td><td>—</td>",
    "<td>Qwen3.7 Plus</td><td>Free</td><td>Free</td><td>pricing pending</td><td>—</td>",
  ));
  assert.equal(unknownCache.pricing["Qwen3.7 Plus"].free, false);
  const missingCache = parseZenDocs(freeCacheOmitted.replace(
    "<td>Qwen3.7 Plus</td><td>Free</td><td>Free</td><td>—</td><td>—</td>",
    "<td>Qwen3.7 Plus</td><td>Free</td><td>Free</td><td></td><td>—</td>",
  ));
  assert.equal(missingCache.pricing["Qwen3.7 Plus"].free, false, "blank is missing evidence, unlike an explicit unavailable dash");
});

test("Zen API fingerprints ignore volatile per-model created stamps, ordering, and JSON key order", () => {
  const fx = fixture(4);
  const a = JSON.parse(fx.api);
  const b = { data: a.data.slice().reverse().map((item) => ({
    owned_by: item.owned_by, created: 1800000000, object: item.object, id: item.id,
  })), object: "list" };
  assert.equal(canonicalZenModelsApiText(JSON.stringify(a)), canonicalZenModelsApiText(JSON.stringify(b)));
  b.data[0].owned_by = "new-owner";
  assert.notEqual(canonicalZenModelsApiText(JSON.stringify(a)), canonicalZenModelsApiText(JSON.stringify(b)));
  b.data[0].owned_by = "opencode";
  b.data[0].unknown_capability = { tier: "new" };
  assert.notEqual(canonicalZenModelsApiText(JSON.stringify(a)), canonicalZenModelsApiText(JSON.stringify(b)));
});

test("Zen API model metadata changes remain visible even alongside model additions", () => {
  // Duplicate and malformed API rows are checked separately below.
  const fx = fixture(4);
  const before = buildZenSnapshot(parseZenDocs(fx.html), parseZenModelsApi(fx.api));
  const next = JSON.parse(fx.api);
  next.data[1].object = "new-model-kind";
  next.data[2].object = "new-model-kind";
  next.data[1].unknown_capability = "new";
  next.data.push({ id: "brand-new-model", object: "model", created: 2, owned_by: "opencode" });
  const after = buildZenSnapshot(parseZenDocs(fx.html), parseZenModelsApi(JSON.stringify(next)));
  const changes = diffZenSnapshots(before, after);
  for (const id of [next.data[1].id, next.data[2].id]) {
    assert(changes.some((change) => change.type === "zen_model_object_changed" && change.key === id
      && change.field === "object" && change.before === "model" && change.after === "new-model-kind"));
  }
  assert(changes.some((change) => change.type === "zen_model_added" && change.key === "brand-new-model"));
  assert(changes.some((change) => change.type === "zen_unclassified_api_change"), "unknown concurrent API delta must not be suppressed");
  assert.match(buildZenChangeMessages(changes, after).join("\n"), /ZEN API MODEL TYPE CHANGED/);
  assert(!diffZenSnapshots(before, before).some((change) => change.type === "zen_model_object_changed"));
});

test("Zen models API fails closed on duplicate or malformed rows instead of creating false removals", () => {
  for (const data of [
    [{ id: "model-a" }, { id: "model-a" }],
    [{ id: "model-a" }, { owned_by: "opencode" }],
    [{ id: "model-a" }, { id: "  model-b" }],
    [{ id: "model-a" }, null],
  ]) {
    const raw = JSON.stringify({ object: "list", data });
    assert.throws(() => parseZenModelsApi(raw), /invalid model row|duplicate or non-canonical/);
    assert.throws(() => canonicalZenModelsApiText(raw), /invalid model row|duplicate or non-canonical/);
  }
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

test("oversized Zen source excerpts are chunked without invalid HTML, broken entities, or Unicode corruption", () => {
  const fx = fixture(24);
  const snapshot = buildZenSnapshot(parseZenDocs(fx.html), parseZenModelsApi(fx.api), "2026-10-08T20:30:00Z");
  const marker = "&<>\"🚀";
  const changes = [
    { type: "zen_unclassified_docs_change", before: `BEFORE-${marker.repeat(2600)}`, after: `AFTER-${marker.repeat(2400)}` },
  ];
  const messages = buildZenChangeMessages(changes, snapshot);
  assert.ok(messages.length > 3);
  for (const message of messages) {
    assert.ok(message.length <= 3850, `Telegram card exceeds the local size cap: ${message.length}`);
    assert.equal(Buffer.from(message, "utf8").toString("utf8"), message, "Unicode codepoint boundary must remain intact");
    const tags = [];
    for (const match of message.matchAll(/<\/?(?:b|i|code)\b[^>]*>/gi)) {
      const token = match[0];
      const name = /[a-z]+/i.exec(token)[0];
      if (token.startsWith("</")) assert.equal(tags.pop(), name);
      else tags.push(name);
    }
    assert.deepEqual(tags, [], "every independently delivered HTML fragment must have balanced tags");
  }
  const combined = messages.join("\n");
  assert.match(combined, /BEFORE-/);
  assert.match(combined, /AFTER-/);
  assert.equal((combined.match(/&amp;/g) ?? []).length, 5000, "no original escaped entity was lost");
});

test("many Zen price-change cards remain below the Telegram limit per message", () => {
  const fx = fixture(24);
  const snapshot = buildZenSnapshot(parseZenDocs(fx.html), parseZenModelsApi(fx.api), "2026-10-08T20:30:00Z");
  const changes = Array.from({ length: 130 }, (_, i) => ({
    type: "zen_price_changed", key: `Synthetic Price ${i}`, field: "inputPerM", before: 3, after: 2, percent: -33.3333,
  }));
  const messages = buildZenChangeMessages(changes, snapshot);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 3850));
  assert.match(messages.join("\n"), /Synthetic Price 129/);
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

test("Zen watcher skips semantic work when the API only regenerates created timestamps", async () => {
  const fx = fixture(24);
  const env = { STATE: new FakeKV(), OPENCODE_ZEN_DOCS_URL: "https://example/zen-docs", OPENCODE_ZEN_MODELS_URL: "https://example/models" };
  await runZenWatch(env, {
    fetchImpl: async (url) => new Response(url.includes("models") ? fx.api : fx.html, { status: 200, headers: { etag: '"first"' } }),
    now: new Date("2026-10-08T20:00:00Z"),
  });
  const updated = JSON.parse(fx.api);
  updated.data.reverse().forEach((item) => { item.created = 1900000000; });
  let notifications = 0;
  const result = await runZenWatch(env, {
    fetchImpl: async (url) => url.includes("models")
      ? new Response(JSON.stringify(updated), { status: 200, headers: { etag: '"second"' } })
      : new Response(null, { status: 304 }),
    now: new Date("2026-10-08T20:05:00Z"),
    notifyChanges: async () => { notifications++; },
  });
  assert.equal(result.status, "unchanged");
  assert.equal(result.optimization, "fingerprint");
  assert.equal(notifications, 0);
  assert.equal((await env.STATE.get("zen:hot:v1", { type: "json" })).sourceState.api.etag, '"second"');
});

test("legacy Zen hot-cache schema reparses and silently corrects cached free-pricing state", async () => {
  const fx = fixture(24);
  const updatedHtml = fx.html.replace(
    "<td>Big Pickle</td><td>Free</td><td>Free</td><td>Free</td><td>-</td>",
    "<td>Big Pickle</td><td>Free</td><td>Free</td><td>-</td><td>-</td>",
  );
  const env = { STATE: new FakeKV(), OPENCODE_ZEN_DOCS_URL: "https://example/zen-docs", OPENCODE_ZEN_MODELS_URL: "https://example/models" };
  const full = async (url) => new Response(url.includes("models") ? fx.api : updatedHtml, {
    status: 200, headers: { etag: url.includes("models") ? '"api1"' : '"docs1"' },
  });
  await runZenWatch(env, { fetchImpl: full, now: new Date("2026-10-08T20:00:00Z") });
  const old = await env.STATE.get("zen:snapshot:v1", { type: "json" });
  old.docs.pricing["Big Pickle"].free = false;
  old.models["big-pickle"].pricing[0].free = false;
  await env.STATE.put("zen:snapshot:v1", JSON.stringify(old));
  const hot = await env.STATE.get("zen:hot:v1", { type: "json" });
  hot.schema = 1;
  await env.STATE.put("zen:hot:v1", JSON.stringify(hot));

  let notifications = 0;
  const result = await runZenWatch(env, {
    fetchImpl: async (url, init) => {
      assert.equal(init.headers["if-none-match"], undefined, "migration needs a full source re-fetch");
      return full(url);
    },
    now: new Date("2026-10-08T20:05:00Z"),
    notifyChanges: async () => { notifications++; },
  });
  assert.equal(result.status, "unchanged");
  assert.equal(notifications, 0, "parser correction must not invent a public price change");
  const saved = await env.STATE.get("zen:snapshot:v1", { type: "json" });
  assert.equal(saved.docs.pricing["Big Pickle"].free, true);
  assert.equal(saved.models["big-pickle"].pricing[0].free, true);
  assert.equal((await env.STATE.get("zen:hot:v1", { type: "json" })).schema, 2);
  const next = await runZenWatch(env, {
    fetchImpl: async () => new Response(null, { status: 304 }),
    now: new Date("2026-10-08T20:10:00Z"),
  });
  assert.equal(next.optimization, "304", "migration must only occur once");
});

test("legacy Zen schema rejects accidental 304 responses without discarding the baseline", async () => {
  const fx = fixture(24);
  const env = { STATE: new FakeKV(), OPENCODE_ZEN_DOCS_URL: "https://example/zen-docs", OPENCODE_ZEN_MODELS_URL: "https://example/models" };
  await runZenWatch(env, {
    fetchImpl: async (url) => new Response(url.includes("models") ? fx.api : fx.html, { status: 200 }),
    now: new Date("2026-10-08T20:00:00Z"),
  });
  const hot = await env.STATE.get("zen:hot:v1", { type: "json" });
  hot.schema = 1;
  await env.STATE.put("zen:hot:v1", JSON.stringify(hot));
  const baselineBefore = await env.STATE.get("zen:snapshot:v1");
  await assert.rejects(runZenWatch(env, {
    fetchImpl: async (url) => url.includes("models")
      ? new Response(null, { status: 304 })
      : new Response(fx.html, { status: 200 }),
  }), /requires full docs and API bodies/);
  assert.equal(await env.STATE.get("zen:snapshot:v1"), baselineBefore);
  assert.equal((await env.STATE.get("zen:hot:v1", { type: "json" })).schema, 1);
});
