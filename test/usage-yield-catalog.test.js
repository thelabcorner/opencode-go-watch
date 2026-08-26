import test from "node:test";
import assert from "node:assert/strict";
import { buildGoUsageYieldRanking, usageYieldFor } from "../src/usage-yield.js";

const profile = { inputTokens: 800, cachedTokens: 60_000, outputTokens: 200 };
const paid = { inputPerM: 0.2, outputPerM: 0.5, cachedReadPerM: 0.02, cachedWritePerM: null, usageUsd: 60 };

test("Go pricing-only rows do not become phantom available-model Usage Yield ranks", () => {
  const snapshot = {
    go: { chart: {} },
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      notes: {},
      requests: {
        Active: { requests5h: 1000, requestsWeek: 2500, requestsMonth: 5000, unlimited: false },
      },
      profiles: { Active: profile, Staged: profile },
      pricing: { Active: paid, Staged: { ...paid, inputPerM: 0.001 } },
    },
  };
  const ranking = buildGoUsageYieldRanking(snapshot);
  assert(usageYieldFor(ranking, "Active"));
  assert.equal(usageYieldFor(ranking, "Staged"), null);
  assert.equal(ranking.entries.length, 1);
});

test("chart-only infinite model remains visible as quota-exempt with docs-lag confidence", () => {
  const snapshot = {
    go: { chart: { "Future Free": { requests5h: null, unlimited: true, bonus: null } } },
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      notes: {},
      requests: {
        Active: { requests5h: 1000, requestsWeek: 2500, requestsMonth: 5000, unlimited: false },
      },
      profiles: { Active: profile },
      pricing: { Active: paid },
    },
  };
  const entry = usageYieldFor(buildGoUsageYieldRanking(snapshot), "Future Free");
  assert(entry);
  assert.equal(entry.class, "quota-exempt");
  assert.equal(entry.rank, null);
  assert.equal(entry.confidence, "medium");
  assert.match(entry.warnings.join(" "), /chart\/docs currently disagree/i);
});
