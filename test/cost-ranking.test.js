import test from "node:test";
import assert from "node:assert/strict";
import { buildGoCheapnessRanking, buildZenCheapnessRanking, cheapnessFor } from "../src/cost-ranking.js";

function goSnapshot() {
  return {
    docs: {
      requests: {
        Freebie: { unlimited: true, requests5h: null, requestsWeek: null, requestsMonth: null },
        Cheap: { requests5h: 1000, requestsWeek: 2000, requestsMonth: 4000 },
        Pricey: { requests5h: 100, requestsWeek: 200, requestsMonth: 400 },
        Tiered: { requests5h: 500, requestsWeek: 1000, requestsMonth: 2000 },
      },
      profiles: {
        Cheap: { inputTokens: 1000, cachedTokens: 10000, outputTokens: 100 },
        Pricey: { inputTokens: 1000, cachedTokens: 10000, outputTokens: 100 },
        Tiered: { inputTokens: 1000, cachedTokens: 10000, outputTokens: 100 },
      },
      pricing: {
        Freebie: { inputPerM: null, outputPerM: null, cachedReadPerM: null },
        Cheap: { inputPerM: 0.1, outputPerM: 0.2, cachedReadPerM: 0.01 },
        Pricey: { inputPerM: 2, outputPerM: 10, cachedReadPerM: 1 },
        "Tiered (Off-Peak)": { inputPerM: 0.2, outputPerM: 0.4, cachedReadPerM: 0.02 },
        "Tiered (Peak)": { inputPerM: 0.4, outputPerM: 0.8, cachedReadPerM: 0.04 },
      },
    },
  };
}

test("Go cheapness uses typical request economics, preserves tier ranges, and ranks quota-exempt free first", () => {
  const ranking = buildGoCheapnessRanking(goSnapshot());
  assert.equal(cheapnessFor(ranking, "Freebie").rank, 1);
  assert.equal(cheapnessFor(ranking, "Freebie").free, true);
  assert(cheapnessFor(ranking, "Cheap").rank < cheapnessFor(ranking, "Pricey").rank);
  const tiered = cheapnessFor(ranking, "Tiered (Peak)");
  assert.equal(tiered.variantCount, 2);
  assert(tiered.maxCost > tiered.minCost);
  assert.equal(tiered.basis, "go-typical-request");
});

test("Go ranking responds directly to price changes even if request-count estimates lag", () => {
  const before = goSnapshot();
  const beforeRank = cheapnessFor(buildGoCheapnessRanking(before), "Pricey").rank;
  const after = structuredClone(before);
  after.docs.pricing.Pricey = { inputPerM: 0.01, outputPerM: 0.01, cachedReadPerM: 0.001 };
  const afterRank = cheapnessFor(buildGoCheapnessRanking(after), "Pricey").rank;
  assert(afterRank < beforeRank);
});

test("Zen cheapness ranks all free models together and paid models by a neutral published-price basket", () => {
  const ranking = buildZenCheapnessRanking({
    models: {
      a: { id: "a", name: "Free A", free: true, pricing: [] },
      b: { id: "b", name: "Free B", free: true, pricing: [] },
      c: { id: "c", name: "Budget", free: false, pricing: [{ inputPerM: 0.1, outputPerM: 0.2, cachedReadPerM: 0.01 }] },
      d: { id: "d", name: "Premium", free: false, pricing: [{ inputPerM: 2, outputPerM: 10, cachedReadPerM: 1 }] },
    },
  });
  const freeA = cheapnessFor(ranking, "Free A");
  assert.equal(freeA.rank, 1);
  assert.equal(freeA.tieCount, 2);
  assert(cheapnessFor(ranking, "Budget").rank < cheapnessFor(ranking, "Premium").rank);
  assert.equal(cheapnessFor(ranking, "Budget").basis, "token-price-index");
});
