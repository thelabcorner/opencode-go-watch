import test from "node:test";
import assert from "node:assert/strict";
import { goUsageValueSection, zenUsageValueSection } from "../src/usage-value-dashboard.js";

function price(inputPerM, outputPerM, cachedReadPerM, usageUsd = 60) {
  return { inputPerM, outputPerM, cachedReadPerM, cachedWritePerM: null, usageUsd };
}

function goSnapshot() {
  return {
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      notes: {},
      requests: {
        Budget: { requests5h: 1000, requestsWeek: 2500, requestsMonth: 5000, unlimited: false },
        Premium: { requests5h: 100, requestsWeek: 250, requestsMonth: 500, unlimited: false },
        Freebie: { requests5h: null, requestsWeek: null, requestsMonth: null, unlimited: true },
      },
      profiles: {
        Budget: { inputTokens: 800, cachedTokens: 50_000, outputTokens: 180 },
        Premium: { inputTokens: 1200, cachedTokens: 80_000, outputTokens: 280 },
        Freebie: { inputTokens: 600, cachedTokens: 40_000, outputTokens: 150 },
      },
      pricing: {
        Budget: price(0.1, 0.2, 0.01, 60),
        Premium: price(2, 10, 1, 15),
        Freebie: { inputPerM: null, outputPerM: null, cachedReadPerM: null, cachedWritePerM: null, usageUsd: null },
      },
    },
  };
}

function zenSnapshot() {
  return {
    docs: { notes: {} },
    models: {
      free: { id: "free", name: "Free Model", free: true, pricing: [{ label: "Free Model", inputPerM: 0, outputPerM: 0, cachedReadPerM: 0 }] },
      budget: { id: "budget", name: "Budget Zen", free: false, pricing: [{ label: "Budget Zen", ...price(0.1, 0.2, 0.01, null) }] },
      premium: { id: "premium", name: "Premium Zen", free: false, pricing: [{ label: "Premium Zen", ...price(2, 10, 1, null) }] },
    },
  };
}

test("Go Usage Yield dashboard renders subscription-capacity leaderboard and separates quota-exempt models", () => {
  const html = goUsageValueSection(goSnapshot());
  assert.match(html, /Usage Yield V2/);
  assert.match(html, /Most coding-agent usage for the Go subscription/);
  assert.match(html, /Budget/);
  assert.match(html, /#1/);
  assert.match(html, /standardized req/);
  assert.match(html, /req \/ \$/i);
  assert.match(html, /1 Go quota-exempt model tracked separately/);
  assert.match(html, /Free ≠ unlimited/);
});

test("Zen Usage Yield dashboard ranks paid models and keeps free capacity outside paid ordering", () => {
  const html = zenUsageValueSection(zenSnapshot(), goSnapshot());
  assert.match(html, /Paid Zen usage value/);
  assert.match(html, /Budget Zen/);
  assert.match(html, /#1/);
  assert.match(html, /equivalent agent requests \/ \$1/);
  assert.match(html, /1 free model kept outside paid ranking because public comparable capacity is unknown/);
  assert.doesNotMatch(html, /Free Model<\/strong>[\s\S]*#1/);
});

test("Zen Usage Yield dashboard refuses to synthesize a paid ranking without Go workload calibration", () => {
  const html = zenUsageValueSection(zenSnapshot(), null);
  assert.match(html, /Waiting for a valid OpenCode Go workload calibration/);
  assert.match(html, /No paid model currently has complete V2 evidence/);
  assert.doesNotMatch(html, /Budget Zen<\/strong>[\s\S]*#1/);
});
