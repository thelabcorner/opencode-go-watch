import { parseGoModelsApi } from "../src/go-api.js";
import { parseDocsPage, parseGoPage } from "../src/parsers.js";
import { buildZenSnapshot, parseZenDocs, parseZenModelsApi, validateZenSnapshot } from "../src/zen.js";
import { buildGoUsageYieldRanking, buildZenUsageYieldRanking, usageYieldFor } from "../src/usage-yield.js";
import { validateSnapshot } from "../src/watcher.js";

const URLS = {
  go: process.env.OPENCODE_GO_URL || "https://opencode.ai/go",
  goDocs: process.env.OPENCODE_DOCS_URL || "https://opencode.ai/docs/go/",
  goModels: process.env.OPENCODE_GO_MODELS_URL || "https://opencode.ai/zen/go/v1/models",
  zenDocs: process.env.OPENCODE_ZEN_DOCS_URL || "https://opencode.ai/docs/zen/",
  zenModels: process.env.OPENCODE_ZEN_MODELS_URL || "https://opencode.ai/zen/v1/models",
};

async function get(url, accept) {
  const response = await fetch(url, {
    headers: {
      accept,
      "user-agent": "opencode-go-watch-live-smoke/3",
      "cache-control": "no-cache",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new Error(`${url} returned an empty body`);
  return text;
}

const [goHtml, goDocsHtml, goModelsJson, zenDocsHtml, zenModelsJson] = await Promise.all([
  get(URLS.go, "text/html"),
  get(URLS.goDocs, "text/html"),
  get(URLS.goModels, "application/json"),
  get(URLS.zenDocs, "text/html"),
  get(URLS.zenModels, "application/json"),
]);

const checkedAt = new Date().toISOString();
const goSnapshot = {
  schema: 5,
  checkedAt,
  sources: { go: URLS.go, docs: URLS.goDocs, api: URLS.goModels },
  sourceState: {},
  go: parseGoPage(goHtml),
  docs: parseDocsPage(goDocsHtml),
  api: parseGoModelsApi(goModelsJson),
};
validateSnapshot(goSnapshot);

const goRanking = buildGoUsageYieldRanking(goSnapshot);
if (goRanking.calibration.stats.uniqueWorkloads < 8) {
  throw new Error(`Usage Yield calibration unexpectedly small: ${goRanking.calibration.stats.uniqueWorkloads} workloads`);
}
if (goRanking.paidEntries.length < 8) {
  throw new Error(`Too few ranked Go paid models: ${goRanking.paidEntries.length}`);
}
if (!goRanking.paidEntries.every((entry) => entry.goCapacity?.monthlyEquivalentRequests > 0 && entry.requestsPerDollar > 0)) {
  throw new Error("A ranked Go model has invalid Usage Yield economics");
}

const quotaExempt = goRanking.entries.filter((entry) => entry.class === "quota-exempt");
for (const entry of quotaExempt) {
  if (entry.rank != null || entry.requestsPerDollar != null) throw new Error(`Quota-exempt model ${entry.name} leaked into paid division-by-dollar ranking`);
}

const zenDocs = parseZenDocs(zenDocsHtml);
const zenApi = parseZenModelsApi(zenModelsJson);
const zenSnapshot = buildZenSnapshot(zenDocs, zenApi, checkedAt);
validateZenSnapshot(zenSnapshot);
const zenRanking = buildZenUsageYieldRanking(zenSnapshot, goSnapshot);
if (zenRanking.paidEntries.length < 20) {
  throw new Error(`Too few ranked Zen paid models: ${zenRanking.paidEntries.length}`);
}
for (const entry of zenRanking.freeEntries) {
  if (entry.rank != null || entry.requestsPerDollar != null || entry.class !== "free-limited-unknown") {
    throw new Error(`Free Zen model ${entry.name} was assigned invented paid/infinite capacity`);
  }
}

const unrankedZen = zenRanking.unrankedEntries.map((entry) => ({
  name: entry.name,
  warnings: entry.warnings,
}));
if (unrankedZen.length > 5) {
  throw new Error(`Unexpectedly many Zen paid models are unranked: ${JSON.stringify(unrankedZen)}`);
}

const deepSeek = ["DeepSeek V4 Flash", "DeepSeek V4 Pro"]
  .map((name) => usageYieldFor(goRanking, name))
  .find(Boolean);
if (deepSeek?.regimes?.time && !(deepSeek.regimes.peakFraction > 0 && deepSeek.regimes.peakFraction < 1)) {
  throw new Error("DeepSeek Peak/Off-Peak rows were found but the published time schedule was not converted into a valid fraction");
}

const goBest = goRanking.paidEntries[0];
const zenBest = zenRanking.paidEntries[0];
console.log(JSON.stringify({
  event: "usage-yield.live-smoke",
  calibrationShapes: goRanking.calibration.stats.uniqueWorkloads,
  calibrationMedianContext: goRanking.calibration.stats.contextMedian,
  go: {
    parsedModels: Object.keys(goSnapshot.docs.requests).length,
    apiModels: goSnapshot.api.modelIds.length,
    rankedPaid: goRanking.paidEntries.length,
    quotaExempt: quotaExempt.length,
    unranked: goRanking.unrankedEntries.map((entry) => ({ name: entry.name, warnings: entry.warnings })),
    best: goBest ? { name: goBest.name, rank: goBest.rank, monthlyEquivalentRequests: goBest.goCapacity?.monthlyEquivalentRequests } : null,
  },
  zen: {
    apiModels: Object.keys(zenSnapshot.models).length,
    free: zenRanking.freeEntries.length,
    rankedPaid: zenRanking.paidEntries.length,
    unrankedPaid: unrankedZen,
    best: zenBest ? { name: zenBest.name, rank: zenBest.rank, requestsPerDollar: zenBest.requestsPerDollar } : null,
  },
}, null, 2));