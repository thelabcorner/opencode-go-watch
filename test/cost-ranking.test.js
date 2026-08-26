import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoUsageYieldRanking,
  buildStandardWorkloadCorpus,
  buildZenUsageYieldRanking,
  peakFractionFromNotes,
  usageYieldFor,
} from "../src/usage-yield.js";

function request(requestsMonth = 10_000) {
  return { requests5h: Math.round(requestsMonth / 5), requestsWeek: Math.round(requestsMonth / 2), requestsMonth, unlimited: false };
}

function price(inputPerM, outputPerM, cachedReadPerM, usageUsd = 60) {
  return { inputPerM, outputPerM, cachedReadPerM, cachedWritePerM: null, usageUsd };
}

function goSnapshot() {
  return {
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      requests: {
        "Budget Raw": request(10_000),
        "Go Value": request(20_000),
        "Same Price Heavy": request(8_000),
      },
      profiles: {
        "Budget Raw": { inputTokens: 500, cachedTokens: 40_000, outputTokens: 150 },
        "Go Value": { inputTokens: 800, cachedTokens: 60_000, outputTokens: 220 },
        "Same Price Heavy": { inputTokens: 1_200, cachedTokens: 85_000, outputTokens: 300 },
      },
      pricing: {
        "Budget Raw": price(0.10, 0.20, 0.01, 15),
        "Go Value": price(0.20, 0.40, 0.02, 60),
        "Same Price Heavy": price(0.20, 0.40, 0.02, 60),
      },
      notes: {},
    },
  };
}

test("V2 workload corpus deduplicates shared sibling profiles and derives deterministic bands", () => {
  const corpus = buildStandardWorkloadCorpus({
    A: { inputTokens: 500, cachedTokens: 30_000, outputTokens: 100 },
    B: { inputTokens: 500, cachedTokens: 30_000, outputTokens: 100 },
    C: { inputTokens: 800, cachedTokens: 60_000, outputTokens: 200 },
    D: { inputTokens: 1_100, cachedTokens: 90_000, outputTokens: 300 },
    E: { inputTokens: 1_500, cachedTokens: 300_000, outputTokens: 500 },
  });
  assert.equal(corpus.stats.sourceProfiles, 5);
  assert.equal(corpus.stats.uniqueWorkloads, 4);
  assert.deepEqual(corpus.workloads[0].models, ["A", "B"]);
  assert.equal(corpus.workloads[0].band, "light");
  assert.equal(corpus.workloads.at(-1).band, "heavy");
});

test("Go V2 normalizes away each model's own request-shape bias", () => {
  const snapshot = goSnapshot();
  const ranking = buildGoUsageYieldRanking(snapshot);
  const value = usageYieldFor(ranking, "Go Value");
  const heavy = usageYieldFor(ranking, "Same Price Heavy");
  assert.equal(value.rank, heavy.rank);
  assert.equal(value.costPerEquivalentRequest, heavy.costPerEquivalentRequest);
  assert.notEqual(value.practical.cost, heavy.practical.cost);
});

test("Go primary rank measures standardized subscription capacity, not raw token price alone", () => {
  const ranking = buildGoUsageYieldRanking(goSnapshot());
  const raw = usageYieldFor(ranking, "Budget Raw");
  const value = usageYieldFor(ranking, "Go Value");
  assert(raw.requestsPerDollar > value.requestsPerDollar, "Budget Raw has lower provider token rates");
  assert(value.goCapacity.monthlyEquivalentRequests > raw.goCapacity.monthlyEquivalentRequests, "4x included Go usage outweighs 2x raw cost");
  assert(value.rank < raw.rank);
  assert.equal(value.rankBasis, "go-capacity");
  assert.equal(value.goCapacity.fiveHourEquivalentRequests / value.goCapacity.monthlyEquivalentRequests, 12 / 60);
  assert.equal(value.goCapacity.weeklyEquivalentRequests / value.goCapacity.monthlyEquivalentRequests, 30 / 60);
});

test("Go V2 applies context threshold tiers to the workloads that actually cross them", () => {
  const snapshot = {
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      requests: { Tiered: request() },
      profiles: {
        Tiered: { inputTokens: 1_000, cachedTokens: 50_000, outputTokens: 200 },
        Calibrator: { inputTokens: 5_000, cachedTokens: 300_000, outputTokens: 500 },
      },
      pricing: {
        "Tiered (≤ 256K tokens)": price(0.2, 0.4, 0.02, 60),
        "Tiered (> 256K tokens)": price(0.8, 1.6, 0.08, 60),
      },
      notes: {},
    },
  };
  const entry = usageYieldFor(buildGoUsageYieldRanking(snapshot), "Tiered");
  assert(entry);
  assert.equal(entry.regimes.context.length, 2);
  assert.equal(entry.regimes.context[0].matchingWorkloads, 1);
  assert.equal(entry.regimes.context[1].matchingWorkloads, 1);
  assert(entry.maxCost > entry.minCost);
});

test("DeepSeek-style documented peak windows are time-weighted instead of using permanent best-case pricing", () => {
  const notes = { deepSeekPeakHours: "DeepSeek V4: Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; all other hours are Off-Peak." };
  assert.equal(peakFractionFromNotes(notes), 35 / 168);
  const snapshot = {
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      requests: { Model: request() },
      profiles: { Model: { inputTokens: 700, cachedTokens: 60_000, outputTokens: 200 } },
      pricing: {
        "Model (Off-Peak)": price(0.2, 0.6, 0.01, 30),
        "Model (Peak)": price(0.4, 1.2, 0.02, 30),
      },
      notes,
    },
  };
  const entry = usageYieldFor(buildGoUsageYieldRanking(snapshot), "Model");
  assert.equal(entry.regimes.peakFraction, 35 / 168);
  assert(entry.costPerEquivalentRequest > entry.regimes.time.offPeakCost);
  assert(entry.costPerEquivalentRequest < entry.regimes.time.peakCost);
  assert(entry.regimes.time.offPeakRequestsPerDollar > entry.regimes.time.peakRequestsPerDollar);
});

test("missing cached-read pricing does not get silently treated as free cache", () => {
  const snapshot = goSnapshot();
  snapshot.docs.pricing["Go Value"] = price(0.1, 0.2, null, 60);
  const entry = usageYieldFor(buildGoUsageYieldRanking(snapshot), "Go Value");
  assert.equal(entry.class, "unranked");
  assert.equal(entry.rank, null);
});

test("Go quota-exempt state stays semantically separate from paid Usage Yield", () => {
  const snapshot = goSnapshot();
  snapshot.docs.requests.Freebie = { requests5h: null, requestsWeek: null, requestsMonth: null, unlimited: true };
  snapshot.docs.profiles.Freebie = { inputTokens: 500, cachedTokens: 40_000, outputTokens: 150 };
  snapshot.docs.pricing.Freebie = { inputPerM: null, outputPerM: null, cachedReadPerM: null, cachedWritePerM: null, usageUsd: null };
  const entry = usageYieldFor(buildGoUsageYieldRanking(snapshot), "Freebie");
  assert.equal(entry.class, "quota-exempt");
  assert.equal(entry.rank, null);
  assert.equal(entry.costPerEquivalentRequest, 0);
  assert.match(entry.warnings[0], /separate rate limit/i);
});

test("Zen paid models use the same Go-calibrated workload corpus", () => {
  const go = goSnapshot();
  const zen = {
    docs: { notes: {} },
    models: {
      cacheEfficient: { id: "cache-efficient", name: "Cache Efficient", free: false, pricing: [{ label: "Cache Efficient", ...price(0.5, 1, 0.005, null) }] },
      headlineCheap: { id: "headline-cheap", name: "Headline Cheap", free: false, pricing: [{ label: "Headline Cheap", ...price(0.1, 0.2, 0.2, null) }] },
    },
  };
  const ranking = buildZenUsageYieldRanking(zen, go);
  const cache = usageYieldFor(ranking, "Cache Efficient");
  const headline = usageYieldFor(ranking, "Headline Cheap");
  assert(cache.requestsPerDollar > headline.requestsPerDollar);
  assert(cache.rank < headline.rank);
  assert.equal(cache.rankBasis, "paid-yield");
  assert.equal(ranking.calibration.stats.uniqueWorkloads, 3);
});

test("Zen free pricing is classified as free capacity unknown, not fake infinite yield", () => {
  const zen = {
    docs: { notes: {} },
    models: {
      free: { id: "free", name: "Free", free: true, pricing: [{ label: "Free", inputPerM: 0, outputPerM: 0, cachedReadPerM: 0 }] },
      paid: { id: "paid", name: "Paid", free: false, pricing: [{ label: "Paid", ...price(0.1, 0.2, 0.01, null) }] },
    },
  };
  const ranking = buildZenUsageYieldRanking(zen, goSnapshot());
  const free = usageYieldFor(ranking, "Free");
  const paid = usageYieldFor(ranking, "Paid");
  assert.equal(free.class, "free-limited-unknown");
  assert.equal(free.rank, null);
  assert.equal(free.requestsPerDollar, null);
  assert.equal(paid.rank, 1);
  assert.equal(ranking.total, 1);
});

test("exact paid Usage Yield ties use competition ranking", () => {
  const go = goSnapshot();
  const zen = {
    docs: { notes: {} },
    models: {
      a: { id: "a", name: "A", free: false, pricing: [{ label: "A", ...price(0.1, 0.2, 0.01, null) }] },
      b: { id: "b", name: "B", free: false, pricing: [{ label: "B", ...price(0.1, 0.2, 0.01, null) }] },
      c: { id: "c", name: "C", free: false, pricing: [{ label: "C", ...price(1, 2, 0.1, null) }] },
    },
  };
  const ranking = buildZenUsageYieldRanking(zen, go);
  assert.equal(usageYieldFor(ranking, "A").rank, 1);
  assert.equal(usageYieldFor(ranking, "B").rank, 1);
  assert.equal(usageYieldFor(ranking, "A").tieCount, 2);
  assert.equal(usageYieldFor(ranking, "C").rank, 3);
});
