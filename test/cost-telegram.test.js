import test from "node:test";
import assert from "node:assert/strict";
import { buildChangeMessages } from "../src/telegram.js";
import { buildZenChangeMessages } from "../src/zen-telegram.js";

function goSnapshot(overrides = {}) {
  const snapshot = {
    checkedAt: "2026-08-22T20:00:00.000Z",
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      notes: {},
      requests: {
        "Budget Model": { requests5h: 1000, requestsWeek: 2500, requestsMonth: 5000, unlimited: false },
        "Middle Model": { requests5h: 500, requestsWeek: 1250, requestsMonth: 2500, unlimited: false },
        "Premium Model": { requests5h: 100, requestsWeek: 250, requestsMonth: 500, unlimited: false },
      },
      profiles: {
        "Budget Model": { inputTokens: 1000, cachedTokens: 10000, outputTokens: 100 },
        "Middle Model": { inputTokens: 1200, cachedTokens: 12000, outputTokens: 120 },
        "Premium Model": { inputTokens: 1500, cachedTokens: 15000, outputTokens: 150 },
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

test("Go new-model Telegram card reports Usage Yield V2 using standardized work", () => {
  const snapshot = goSnapshot();
  const messages = buildChangeMessages([
    { type: "model_added", key: "Budget Model", after: snapshot.docs.requests["Budget Model"] },
  ], snapshot);
  assert.match(messages[0], /Usage value/);
  assert.match(messages[0], /#1 of 3 paid/);
  assert.match(messages[0], /standardized requests \/ Go monthly allowance/);
  assert.match(messages[0], /equivalent req\/\$/);
  assert.match(messages[0], /V2 normalizes every paid model against the same/);
  assert.doesNotMatch(messages[0], /cheapest published tier/i);
});

test("Go pricing-change card recomputes the affected model's current Usage Value rank", () => {
  const snapshot = goSnapshot();
  snapshot.docs.pricing["Premium Model"] = { inputPerM: 0.001, outputPerM: 0.001, cachedReadPerM: 0.0001, cachedWritePerM: null, usageUsd: 60 };
  const messages = buildChangeMessages([
    { type: "pricing_changed", key: "Premium Model", field: "inputPerM", before: 2, after: 0.001, percent: -99.95 },
  ], snapshot);
  assert.match(messages[0], /PRICING CHANGED/);
  assert.match(messages[0], /Premium Model/);
  assert.match(messages[0], /Usage value/);
  assert.match(messages[0], /#1 of 3 paid/);
  assert.match(messages[0], /100% of best/);
});

test("Go Peak/Off-Peak pricing is time weighted rather than permanently using cheapest row", () => {
  const snapshot = goSnapshot();
  snapshot.docs.notes.deepSeekPeakHours = "DeepSeek Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; all other hours are Off-Peak.";
  delete snapshot.docs.pricing["Middle Model"];
  snapshot.docs.pricing["Middle Model (Off-Peak)"] = { inputPerM: 0.2, outputPerM: 0.4, cachedReadPerM: 0.02, cachedWritePerM: null, usageUsd: 60 };
  snapshot.docs.pricing["Middle Model (Peak)"] = { inputPerM: 0.4, outputPerM: 0.8, cachedReadPerM: 0.04, cachedWritePerM: null, usageUsd: 60 };
  const messages = buildChangeMessages([
    { type: "pricing_changed", key: "Middle Model (Peak)", field: "outputPerM", before: 0.7, after: 0.8, percent: 14.2857 },
  ], snapshot);
  assert.match(messages[0], /Off-peak/);
  assert.match(messages[0], /Peak/);
  assert.match(messages[0], /peak usage/);
  assert.doesNotMatch(messages[0], /cheapest published tier/i);
});

test("Go request-profile change explains global V2 corpus recalibration", () => {
  const snapshot = goSnapshot();
  const messages = buildChangeMessages([
    { type: "request_profile_changed", key: "Budget Model", field: "cachedTokens", before: 9000, after: 10000, percent: 11.111 },
  ], snapshot);
  assert.match(messages[0], /REQUEST PROFILE CHANGED/);
  assert.match(messages[0], /shared V2 workload corpus was recalculated/i);
  assert.match(messages[0], /Usage Value ranks are recomputed/i);
});

function zenSnapshot() {
  return {
    checkedAt: "2026-08-22T20:00:00.000Z",
    docs: { notes: {} },
    models: {
      freeA: { id: "free-a", name: "Free A", free: true, pricing: [], endpoint: null },
      freeB: { id: "free-b", name: "Free B", free: true, pricing: [], endpoint: null },
      budget: { id: "budget", name: "Budget", free: false, pricing: [{ label: "Budget", inputPerM: 0.1, outputPerM: 0.2, cachedReadPerM: 0.01, cachedWritePerM: null }], endpoint: null },
      premium: { id: "premium", name: "Premium", free: false, pricing: [{ label: "Premium", inputPerM: 2, outputPerM: 10, cachedReadPerM: 1, cachedWritePerM: null }], endpoint: null },
    },
  };
}

test("Zen free-model addition reports free status without inventing unlimited capacity", () => {
  const snapshot = zenSnapshot();
  const messages = buildZenChangeMessages([
    { type: "zen_free_model_added", key: "free-b", after: snapshot.models.freeB },
  ], snapshot, "America/Chicago", goSnapshot());
  assert.match(messages[0], /NEW FREE MODEL/);
  assert.match(messages[0], /Usage value/);
  assert.match(messages[0], /FREE/);
  assert.match(messages[0], /do not establish a comparable request-capacity limit/);
  assert.doesNotMatch(messages[0], /#1 of/);
  assert.doesNotMatch(messages[0], /unlimited yield/i);
});

test("Zen price-drop card uses shared Go workload calibration and paid requests-per-dollar rank", () => {
  const snapshot = zenSnapshot();
  snapshot.models.premium.pricing[0] = { label: "Premium", inputPerM: 0.001, outputPerM: 0.001, cachedReadPerM: 0.0001, cachedWritePerM: null };
  const messages = buildZenChangeMessages([
    { type: "zen_price_changed", key: "Premium", field: "inputPerM", before: 2, after: 0.001, percent: -99.95 },
  ], snapshot, "America/Chicago", goSnapshot());
  assert.match(messages[0], /ZEN PRICE DROP/);
  assert.match(messages[0], /Usage value/);
  assert.match(messages[0], /#1 of 2 paid/);
  assert.match(messages[0], /equivalent agent requests \/ \$1/);
  assert.match(messages[0], /100% of best/);
  assert.doesNotMatch(messages[0], /Index = input \+ output/);
});

test("Zen paid-model alert is explicit when Go calibration is unavailable", () => {
  const snapshot = zenSnapshot();
  const messages = buildZenChangeMessages([
    { type: "zen_model_added", key: "budget", after: snapshot.models.budget },
  ], snapshot);
  assert.match(messages[0], /waiting for Go workload calibration/);
  assert.doesNotMatch(messages[0], /#\d+ of \d+ paid/);
});
