import test from "node:test";
import assert from "node:assert/strict";
import { buildChangeMessages } from "../src/telegram.js";
import { buildZenChangeMessages } from "../src/zen-telegram.js";

function goSnapshot(overrides = {}) {
  const snapshot = {
    checkedAt: "2026-08-22T20:00:00.000Z",
    docs: {
      requests: {
        "Budget Model": { requests5h: 1000, requestsWeek: 2500, requestsMonth: 5000 },
        "Middle Model": { requests5h: 500, requestsWeek: 1250, requestsMonth: 2500 },
        "Premium Model": { requests5h: 100, requestsWeek: 250, requestsMonth: 500 },
      },
      profiles: {
        "Budget Model": { inputTokens: 1000, cachedTokens: 10000, outputTokens: 100 },
        "Middle Model": { inputTokens: 1000, cachedTokens: 10000, outputTokens: 100 },
        "Premium Model": { inputTokens: 1000, cachedTokens: 10000, outputTokens: 100 },
      },
      pricing: {
        "Budget Model": { inputPerM: 0.1, outputPerM: 0.2, cachedReadPerM: 0.01, cachedWritePerM: null, usageUsd: 60 },
        "Middle Model": { inputPerM: 0.5, outputPerM: 1, cachedReadPerM: 0.05, cachedWritePerM: null, usageUsd: 60 },
        "Premium Model": { inputPerM: 2, outputPerM: 10, cachedReadPerM: 1, cachedWritePerM: null, usageUsd: 15 },
      },
    },
    go: { chart: {}, promoBanner: null },
  };
  return Object.assign(snapshot, overrides);
}

test("Go new-model Telegram card includes generalized cheapness rank", () => {
  const snapshot = goSnapshot();
  const messages = buildChangeMessages([
    { type: "model_added", key: "Budget Model", after: snapshot.docs.requests["Budget Model"] },
  ], snapshot);
  assert.match(messages[0], /Cheapness/);
  assert.match(messages[0], /#1 of 3 ranked/);
  assert.match(messages[0], /typical request/);
});

test("Go pricing-change card recomputes the affected model's current cheapness rank", () => {
  const snapshot = goSnapshot();
  snapshot.docs.pricing["Premium Model"] = { inputPerM: 0.01, outputPerM: 0.01, cachedReadPerM: 0.001, cachedWritePerM: null, usageUsd: 15 };
  const messages = buildChangeMessages([
    { type: "pricing_changed", key: "Premium Model", field: "inputPerM", before: 2, after: 0.01, percent: -99.5 },
  ], snapshot);
  assert.match(messages[0], /PRICING CHANGED/);
  assert.match(messages[0], /Premium Model/);
  assert.match(messages[0], /Cheapness/);
  assert.match(messages[0], /#1 of 3 ranked/);
});

test("Go tiered pricing reports a cost range while ranking by the cheapest published tier", () => {
  const snapshot = goSnapshot();
  delete snapshot.docs.pricing["Middle Model"];
  snapshot.docs.pricing["Middle Model (Off-Peak)"] = { inputPerM: 0.2, outputPerM: 0.4, cachedReadPerM: 0.02, cachedWritePerM: null, usageUsd: 60 };
  snapshot.docs.pricing["Middle Model (Peak)"] = { inputPerM: 0.4, outputPerM: 0.8, cachedReadPerM: 0.04, cachedWritePerM: null, usageUsd: 60 };
  const messages = buildChangeMessages([
    { type: "pricing_changed", key: "Middle Model (Peak)", field: "outputPerM", before: 0.7, after: 0.8, percent: 14.2857 },
  ], snapshot);
  assert.match(messages[0], /cheapest published tier/i);
  assert.match(messages[0], /2 pricing variants/);
  assert.match(messages[0], /typical request/);
});

function zenSnapshot() {
  return {
    checkedAt: "2026-08-22T20:00:00.000Z",
    models: {
      freeA: { id: "free-a", name: "Free A", free: true, pricing: [], endpoint: null },
      freeB: { id: "free-b", name: "Free B", free: true, pricing: [], endpoint: null },
      budget: { id: "budget", name: "Budget", free: false, pricing: [{ label: "Budget", inputPerM: 0.1, outputPerM: 0.2, cachedReadPerM: 0.01, cachedWritePerM: null }], endpoint: null },
      premium: { id: "premium", name: "Premium", free: false, pricing: [{ label: "Premium", inputPerM: 2, outputPerM: 10, cachedReadPerM: 1, cachedWritePerM: null }], endpoint: null },
    },
  };
}

test("Zen free-model addition shows a tied #1 cheapness rank", () => {
  const snapshot = zenSnapshot();
  const messages = buildZenChangeMessages([
    { type: "zen_free_model_added", key: "free-b", after: snapshot.models.freeB },
  ], snapshot);
  assert.match(messages[0], /NEW FREE MODEL/);
  assert.match(messages[0], /Cheapness/);
  assert.match(messages[0], /#1 of 4 ranked/);
  assert.match(messages[0], /2-way tie/);
  assert.match(messages[0], /Free/);
});

test("Zen price-drop card includes the recomputed current cheapness rank and transparent index basis", () => {
  const snapshot = zenSnapshot();
  snapshot.models.premium.pricing[0] = { label: "Premium", inputPerM: 0.01, outputPerM: 0.01, cachedReadPerM: 0.001, cachedWritePerM: null };
  const messages = buildZenChangeMessages([
    { type: "zen_price_changed", key: "Premium", field: "inputPerM", before: 2, after: 0.01, percent: -99.5 },
  ], snapshot);
  assert.match(messages[0], /ZEN PRICE DROP/);
  assert.match(messages[0], /Cheapness/);
  assert.match(messages[0], /#3 of 4 ranked/);
  assert.match(messages[0], /Index = input \+ output \+ cached-read rates/);
});
