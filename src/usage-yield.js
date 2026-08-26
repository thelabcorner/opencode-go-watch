import { canonicalModelKey } from "./parsers.js";
import {
  basePricingName,
  buildGoUsageYieldRanking as buildRawGoUsageYieldRanking,
  buildStandardWorkloadCorpus,
  buildZenUsageYieldRanking,
  peakFractionFromNotes,
  usageYieldFor,
} from "./usage-yield-v2.js";

export {
  basePricingName,
  buildStandardWorkloadCorpus,
  buildZenUsageYieldRanking,
  peakFractionFromNotes,
  usageYieldFor,
};

/**
 * Go pricing docs can contain rows for models that are not in the current request
 * allowance table. Do not turn a pricing-only historical/staged row into an
 * available-model value rank. The request table defines the paid ranking catalog;
 * a chart-only `∞` row is additionally retained because the live Go surface itself
 * establishes a quota-exempt model even when the docs are catching up.
 */
export function buildGoUsageYieldRanking(snapshot) {
  const docs = snapshot?.docs ?? {};
  const chart = snapshot?.go?.chart ?? {};
  const eligible = new Set(Object.keys(docs.requests ?? {}).map(canonicalModelKey));
  const requests = { ...(docs.requests ?? {}) };

  for (const [name, row] of Object.entries(chart)) {
    const key = canonicalModelKey(name);
    if (!row?.unlimited || eligible.has(key)) continue;
    eligible.add(key);
    // Synthetic catalog membership only. Keep unlimited=false here so the raw
    // engine preserves medium-confidence chart/docs disagreement rather than
    // pretending the docs independently established the same ∞ state.
    requests[name] = {
      requests5h: null,
      requestsWeek: null,
      requestsMonth: null,
      unlimited: false,
      source: "go-chart-only",
    };
  }

  const profiles = Object.fromEntries(
    Object.entries(docs.profiles ?? {}).filter(([name]) => eligible.has(canonicalModelKey(name))),
  );
  const pricing = Object.fromEntries(
    Object.entries(docs.pricing ?? {}).filter(([label]) => eligible.has(canonicalModelKey(basePricingName(label)))),
  );

  return buildRawGoUsageYieldRanking({
    ...snapshot,
    docs: { ...docs, requests, profiles, pricing },
  });
}
