import test from "node:test";
import assert from "node:assert/strict";
import { buildGoUsageYieldRanking, buildZenUsageYieldRanking, usageYieldFor } from "../src/usage-yield.js";

const profile = (cachedTokens = 60_000) => ({ inputTokens: 800, cachedTokens, outputTokens: 200 });
const request = (requests5h = 1000) => ({ requests5h, requestsWeek: requests5h * 2, requestsMonth: requests5h * 5, unlimited: false });
const price = (inputPerM, outputPerM, cachedReadPerM, usageUsd = 60) => ({ inputPerM, outputPerM, cachedReadPerM, cachedWritePerM: null, usageUsd });

function baseGo() {
  return {
    go: { chart: {} },
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      notes: {},
      requests: {
        A: request(1000),
        B: request(500),
      },
      profiles: {
        A: profile(50_000),
        B: profile(80_000),
      },
      pricing: {
        A: price(0.1, 0.2, 0.01, 60),
        B: price(0.5, 1, 0.05, 60),
      },
    },
  };
}

test("unknown pricing variants fail closed instead of being medianed into a rank", () => {
  const go = baseGo();
  delete go.docs.pricing.A;
  go.docs.pricing["A (Mystery Accelerator)"] = price(0.01, 0.02, 0.001, 60);
  const entry = usageYieldFor(buildGoUsageYieldRanking(go), "A");
  assert.equal(entry.class, "unranked");
  assert.equal(entry.rank, null);
  assert.match(entry.warnings.join(" "), /not semantically classified/i);
});

test("Go included-usage disagreement across price variants fails closed", () => {
  const go = baseGo();
  go.docs.notes.deepSeekPeakHours = "Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday.";
  delete go.docs.pricing.A;
  go.docs.pricing["A (Off-Peak)"] = price(0.1, 0.2, 0.01, 30);
  go.docs.pricing["A (Peak)"] = price(0.2, 0.4, 0.02, 60);
  const entry = usageYieldFor(buildGoUsageYieldRanking(go), "A");
  assert.equal(entry.class, "unranked");
  assert.match(entry.warnings.join(" "), /included-usage values differ/i);
});

test("time and context semantics can coexist in the same pricing variant", () => {
  const go = baseGo();
  go.docs.notes.deepSeekPeakHours = "Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday.";
  delete go.docs.pricing.A;
  go.docs.pricing["A (Off-Peak, ≤ 256K tokens)"] = price(0.1, 0.2, 0.01, 60);
  go.docs.pricing["A (Peak, ≤ 256K tokens)"] = price(0.2, 0.4, 0.02, 60);
  go.docs.pricing["A (Off-Peak, > 256K tokens)"] = price(0.4, 0.8, 0.04, 60);
  go.docs.pricing["A (Peak, > 256K tokens)"] = price(0.8, 1.6, 0.08, 60);
  const entry = usageYieldFor(buildGoUsageYieldRanking(go), "A");
  assert.equal(entry.class, "paid");
  assert.equal(entry.regimes.peakFraction, 35 / 168);
  assert.equal(entry.regimes.context.filter((row) => row.matchingWorkloads > 0).length, 2);
  assert(entry.regimes.time.offPeakRequestsPerDollar > entry.regimes.time.peakRequestsPerDollar);
});

test("documented Go chart promotion affects current 5-hour capacity without being inferred into monthly capacity", () => {
  const go = baseGo();
  go.go.chart.A = { requests5h: 2000, unlimited: false, bonus: "2x usage" };
  const entry = usageYieldFor(buildGoUsageYieldRanking(go), "A");
  assert.equal(entry.class, "paid");
  assert.equal(entry.goCapacity.promotionMultiplier, 2);
  assert.equal(entry.goCapacity.currentFiveHourEquivalentRequests, entry.goCapacity.baseFiveHourEquivalentRequests * 2);
  assert.match(entry.warnings.join(" "), /monthly promotion coverage is not inferred/i);
});

test("finite Go model with explicit zero pricing is classified as free with known published capacity", () => {
  const go = baseGo();
  go.docs.pricing.A = price(0, 0, 0, null);
  const entry = usageYieldFor(buildGoUsageYieldRanking(go), "A");
  assert.equal(entry.class, "free-limited-known");
  assert.equal(entry.rank, null);
  assert.equal(entry.freeCapacity.requests5h, 1000);
});

test("Zen time-regime prices without a public schedule stay unranked", () => {
  const go = baseGo();
  const zen = {
    docs: { notes: {} },
    models: {
      timed: {
        id: "timed",
        name: "Timed",
        free: false,
        pricing: [
          { label: "Timed (Off-Peak)", ...price(0.1, 0.2, 0.01, null) },
          { label: "Timed (Peak)", ...price(0.2, 0.4, 0.02, null) },
        ],
      },
    },
  };
  const entry = usageYieldFor(buildZenUsageYieldRanking(zen, go), "Timed");
  assert.equal(entry.class, "unranked");
  assert.match(entry.warnings.join(" "), /schedule is not publicly parseable/i);
});
