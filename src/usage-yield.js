import { canonicalModelKey } from "./parsers.js";
import {
  basePricingName,
  buildGoUsageYieldRanking as buildGoUsageYieldRankingCore,
} from "./usage-yield-core.js";

export {
  basePricingName,
  buildStandardWorkloadCorpus,
  buildZenUsageYieldRanking,
  peakFractionFromNotes,
  usageYieldFor,
} from "./usage-yield-core.js";

const EPSILON = 1e-12;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function competitionRank(entries, valueOf, fields) {
  const usable = entries.filter((entry) => finite(valueOf(entry)) != null);
  usable.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    const delta = bv - av;
    return Math.abs(delta) > EPSILON ? delta : a.name.localeCompare(b.name);
  });

  let prior = null;
  let rank = 0;
  for (let index = 0; index < usable.length; index++) {
    const value = valueOf(usable[index]);
    if (prior == null || Math.abs(value - prior) > EPSILON) rank = index + 1;
    usable[index][fields.rank] = rank;
    usable[index][fields.total] = usable.length;
    prior = value;
  }

  const counts = new Map();
  for (const entry of usable) counts.set(entry[fields.rank], (counts.get(entry[fields.rank]) ?? 0) + 1);
  for (const entry of usable) entry[fields.tie] = counts.get(entry[fields.rank]) ?? 1;
  return usable;
}

function normalizeCostRange(entry) {
  if (entry?.class !== "paid") return;
  const candidates = [
    entry.costPerEquivalentRequest,
    entry.workload?.light?.cost,
    entry.workload?.typical?.cost,
    entry.workload?.heavy?.cost,
    entry.regimes?.time?.offPeakCost,
    entry.regimes?.time?.peakCost,
    ...(entry.regimes?.context ?? []).filter((item) => item.matchingWorkloads > 0).map((item) => item.cost),
  ].filter((value) => finite(value) != null && value >= 0);
  if (!candidates.length) return;
  entry.minCost = Math.min(...candidates);
  entry.maxCost = Math.max(...candidates);
}

function quotaExemptChartOnly(name) {
  return {
    name,
    class: "quota-exempt",
    free: true,
    rank: null,
    total: 0,
    tieCount: 1,
    basis: "go-quota-exempt",
    score: 0,
    costPerEquivalentRequest: 0,
    requestsPerDollar: null,
    minCost: 0,
    maxCost: 0,
    variantCount: 0,
    fractionOfBest: null,
    costMultipleVsBest: null,
    confidence: "medium",
    warnings: [
      "Go quota-exempt status does not prove the underlying free-model gateway has no separate rate limit.",
      "Go chart/docs currently disagree on quota-exempt state.",
    ],
    goCapacity: {
      includedUsageUsd: null,
      fiveHourEquivalentRequests: null,
      baseFiveHourEquivalentRequests: null,
      currentFiveHourEquivalentRequests: null,
      promotionMultiplier: 1,
      weeklyEquivalentRequests: null,
      monthlyEquivalentRequests: null,
    },
  };
}

function unrankedChartOnly(name) {
  return {
    name,
    class: "unranked",
    free: false,
    rank: null,
    total: 0,
    tieCount: 1,
    basis: "usage-yield-v2",
    score: null,
    costPerEquivalentRequest: null,
    requestsPerDollar: null,
    minCost: null,
    maxCost: null,
    variantCount: 0,
    fractionOfBest: null,
    costMultipleVsBest: null,
    confidence: "low",
    warnings: ["Go chart model is not yet present in the authoritative usage table; subscription-capacity value is not guessed."],
  };
}

/**
 * Public Go ranking adapter.
 *
 * The usage-limit table is the authoritative Go catalog for ranked subscription
 * economics. Chart-only models remain visible as provisional availability signals,
 * while profile/pricing-only rows are enrichment and cannot create phantom models.
 */
export function buildGoUsageYieldRanking(snapshot) {
  const core = buildGoUsageYieldRankingCore(snapshot);
  const docs = snapshot?.docs ?? {};
  const chart = snapshot?.go?.chart ?? {};
  const allowed = new Map();

  for (const name of Object.keys(docs.requests ?? {})) allowed.set(canonicalModelKey(name), name);
  for (const name of Object.keys(chart)) {
    const key = canonicalModelKey(name);
    if (!allowed.has(key)) allowed.set(key, name);
  }

  /** @type {any[]} */
  const entries = core.entries.filter((entry) => allowed.has(canonicalModelKey(entry.name)));
  const existing = new Set(entries.map((entry) => canonicalModelKey(entry.name)));

  for (const [key, name] of allowed) {
    if (existing.has(key)) continue;
    const chartRow = Object.entries(chart).find(([candidate]) => canonicalModelKey(candidate) === key)?.[1] ?? null;
    entries.push(chartRow?.unlimited ? quotaExemptChartOnly(name) : unrankedChartOnly(name));
  }

  for (const entry of entries) {
    if (entry.goCapacity && !("fiveHourEquivalentRequests" in entry.goCapacity)) {
      entry.goCapacity.fiveHourEquivalentRequests = entry.goCapacity.baseFiveHourEquivalentRequests ?? null;
    }
    normalizeCostRange(entry);
    if (entry.class === "paid") {
      entry.rank = null;
      entry.total = 0;
      entry.tieCount = 1;
      entry.fractionOfBest = null;
      entry.costMultipleVsBest = null;
      entry.valuePercentile = null;
      entry.currentFiveHourRank = null;
      entry.currentFiveHourTotal = 0;
      entry.currentFiveHourTieCount = 1;
    }
  }

  const paidEntries = competitionRank(
    entries.filter((entry) => entry.class === "paid"),
    (entry) => entry.goCapacity?.monthlyEquivalentRequests,
    { rank: "rank", total: "total", tie: "tieCount" },
  );
  const bestMonthly = paidEntries[0]?.goCapacity?.monthlyEquivalentRequests ?? null;
  for (const entry of paidEntries) {
    const value = entry.goCapacity?.monthlyEquivalentRequests;
    entry.rankBasis = "go-capacity";
    entry.fractionOfBest = bestMonthly > 0 ? value / bestMonthly : null;
    entry.costMultipleVsBest = entry.fractionOfBest > 0 ? 1 / entry.fractionOfBest : null;
    entry.valuePercentile = entry.total > 0 ? (entry.total - entry.rank + 1) / entry.total * 100 : null;
  }

  competitionRank(
    entries.filter((entry) => entry.class === "paid"),
    (entry) => entry.goCapacity?.currentFiveHourEquivalentRequests,
    { rank: "currentFiveHourRank", total: "currentFiveHourTotal", tie: "currentFiveHourTieCount" },
  );

  const paidTotal = paidEntries.length;
  for (const entry of entries) if (entry.class !== "paid") entry.total = paidTotal;

  const byKey = new Map(entries.map((entry) => [canonicalModelKey(basePricingName(entry.name)), entry]));
  return {
    ...core,
    entries,
    paidEntries,
    freeEntries: entries.filter((entry) => entry.free),
    quotaExemptEntries: entries.filter((entry) => entry.class === "quota-exempt"),
    unrankedEntries: entries.filter((entry) => entry.class === "unranked"),
    byKey,
    total: paidTotal,
  };
}
