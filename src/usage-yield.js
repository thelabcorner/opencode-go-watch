import { canonicalModelKey, deriveConsistency } from "./parsers.js";

const EPSILON = 1e-12;
const CALIBRATION_SCHEMA = 2;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, q) {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function pct(part, whole) {
  return whole > 0 ? part / whole : null;
}

export function basePricingName(name) {
  return String(name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function workloadFromProfile(profile) {
  const inputTokens = finite(profile?.inputTokens);
  const cachedTokens = finite(profile?.cachedTokens);
  const outputTokens = finite(profile?.outputTokens);
  if (inputTokens == null || cachedTokens == null || outputTokens == null) return null;
  if (inputTokens < 0 || cachedTokens < 0 || outputTokens < 0) return null;
  if (inputTokens + cachedTokens + outputTokens <= 0) return null;
  return {
    inputTokens,
    cachedTokens,
    outputTokens,
    contextTokens: inputTokens + cachedTokens,
  };
}

/**
 * Derive one shared coding-agent workload corpus from OpenCode's own observed Go
 * request profiles. Exact duplicate shapes are deduplicated so grouped/sibling
 * profiles cannot silently overweight one workload.
 */
export function buildStandardWorkloadCorpus(profiles = {}) {
  const unique = new Map();
  for (const [model, profile] of Object.entries(profiles ?? {})) {
    const workload = workloadFromProfile(profile);
    if (!workload) continue;
    const shape = `${workload.inputTokens}:${workload.cachedTokens}:${workload.outputTokens}`;
    const prior = unique.get(shape);
    if (prior) {
      prior.models.push(model);
      continue;
    }
    unique.set(shape, { ...workload, models: [model] });
  }

  const workloads = [...unique.values()]
    .map((workload) => ({ ...workload, models: workload.models.slice().sort() }))
    .sort((a, b) => a.contextTokens - b.contextTokens
      || a.inputTokens - b.inputTokens
      || a.cachedTokens - b.cachedTokens
      || a.outputTokens - b.outputTokens);

  const contexts = workloads.map((workload) => workload.contextTokens);
  const inputs = workloads.map((workload) => workload.inputTokens);
  const cached = workloads.map((workload) => workload.cachedTokens);
  const outputs = workloads.map((workload) => workload.outputTokens);
  const p25Context = quantile(contexts, 0.25);
  const p75Context = quantile(contexts, 0.75);

  for (const workload of workloads) {
    workload.band = workload.contextTokens <= p25Context ? "light"
      : workload.contextTokens >= p75Context ? "heavy"
        : "typical";
  }

  return {
    schema: CALIBRATION_SCHEMA,
    basis: "go-observed-workload-corpus",
    workloads,
    stats: {
      uniqueWorkloads: workloads.length,
      sourceProfiles: Object.keys(profiles ?? {}).length,
      inputMedian: median(inputs),
      cachedMedian: median(cached),
      outputMedian: median(outputs),
      contextP25: p25Context,
      contextMedian: median(contexts),
      contextP75: p75Context,
      contextMin: contexts.length ? Math.min(...contexts) : null,
      contextMax: contexts.length ? Math.max(...contexts) : null,
    },
  };
}

function variantText(label) {
  const match = /\(([^()]*)\)\s*$/.exec(String(label ?? "").trim());
  return match ? match[1].trim() : "";
}

function parseThreshold(variant) {
  const match = /(≤|>=|≥|<=|>|<)\s*([\d,.]+)\s*([kKmM]?)\s*tokens?/i.exec(String(variant ?? ""));
  if (!match) return null;
  let tokens = Number(match[2].replaceAll(",", ""));
  if (!Number.isFinite(tokens)) return null;
  const unit = match[3].toLowerCase();
  if (unit === "k") tokens *= 1_000;
  if (unit === "m") tokens *= 1_000_000;
  const raw = match[1];
  const operator = raw === "≤" || raw === "<=" ? "<=" : raw === "≥" || raw === ">=" ? ">=" : raw;
  return { operator, tokens, source: match[0] };
}

function parseVariant(label) {
  const variant = variantText(label);
  const threshold = parseThreshold(variant);
  const time = /\boff[- ]?peak\b/i.test(variant) ? "off-peak"
    : /\bpeak\b/i.test(variant) ? "peak"
      : null;

  let remainder = variant;
  if (threshold?.source) remainder = remainder.replace(threshold.source, " ");
  remainder = remainder.replace(/\boff[- ]?peak\b|\bpeak\b|\bstandard\b/gi, " ");
  remainder = remainder.replace(/[,&/+;|_-]+/g, " ").replace(/\s+/g, " ").trim();

  return {
    variant: variant || "Standard",
    threshold: threshold ? { operator: threshold.operator, tokens: threshold.tokens } : null,
    time,
    knownVariant: remainder === "",
  };
}

function parsePricingRow(label, row) {
  const semantics = parseVariant(label);
  return {
    label,
    ...semantics,
    inputPerM: finite(row?.inputPerM),
    outputPerM: finite(row?.outputPerM),
    cachedReadPerM: finite(row?.cachedReadPerM),
    cachedWritePerM: finite(row?.cachedWritePerM),
    usageUsd: finite(row?.usageUsd),
  };
}

function thresholdMatches(threshold, contextTokens) {
  if (!threshold) return true;
  if (threshold.operator === "<=") return contextTokens <= threshold.tokens;
  if (threshold.operator === ">=") return contextTokens >= threshold.tokens;
  if (threshold.operator === "<") return contextTokens < threshold.tokens;
  if (threshold.operator === ">") return contextTokens > threshold.tokens;
  return false;
}

function priceWorkload(row, workload) {
  if (!row || !workload) return null;
  if (row.inputPerM == null || row.outputPerM == null) return null;
  if (workload.cachedTokens > 0 && row.cachedReadPerM == null) return null;
  const cost = (
    workload.inputTokens * row.inputPerM
    + workload.cachedTokens * (row.cachedReadPerM ?? 0)
    + workload.outputTokens * row.outputPerM
  ) / 1_000_000;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function durationHours(startHour, startMinute, endHour, endMinute) {
  const start = startHour + startMinute / 60;
  const end = endHour + endMinute / 60;
  return end >= start ? end - start : 24 - start + end;
}

/**
 * Parse notes such as:
 * "Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday".
 */
export function peakFractionFromNotes(notes = {}) {
  for (const note of Object.values(notes ?? {})) {
    const text = String(note ?? "");
    if (!/peak hours?/i.test(text)) continue;
    const intervals = [...text.matchAll(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/g)];
    if (!intervals.length) continue;
    let dailyHours = 0;
    for (const match of intervals) {
      dailyHours += durationHours(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]));
    }
    let days = 7;
    if (/monday\s+(?:through|to|-)\s+friday|weekdays?/i.test(text)) days = 5;
    else if (/weekends?/i.test(text) && !/weekday/i.test(text)) days = 2;
    const fraction = dailyHours * days / (24 * 7);
    if (fraction >= 0 && fraction <= 1) return fraction;
  }
  return null;
}

function selectContextRows(rows, workload) {
  const thresholded = rows.filter((row) => row.threshold);
  if (!thresholded.length) return rows;
  const matching = thresholded.filter((row) => thresholdMatches(row.threshold, workload.contextTokens));
  if (matching.length) return matching;
  return rows.filter((row) => !row.threshold);
}

function evaluateWorkload(rows, workload, peakFraction) {
  const applicable = selectContextRows(rows, workload);
  if (!applicable.length) return { ok: false, reason: "no-applicable-pricing-tier" };
  if (applicable.some((row) => !row.knownVariant)) return { ok: false, reason: "unknown-pricing-variant" };

  const priced = applicable
    .map((row) => ({ row, cost: priceWorkload(row, workload) }))
    .filter((entry) => entry.cost != null);
  if (priced.length !== applicable.length) return { ok: false, reason: "incomplete-token-pricing" };

  const offPeak = priced.filter((entry) => entry.row.time === "off-peak");
  const peak = priced.filter((entry) => entry.row.time === "peak");
  const standard = priced.filter((entry) => !entry.row.time);
  let expectedCost;
  let strategy = "single";

  if (offPeak.length || peak.length) {
    if (!offPeak.length || !peak.length) return { ok: false, reason: "incomplete-time-regime" };
    if (peakFraction == null) return { ok: false, reason: "unknown-time-regime-schedule" };
    const off = median(offPeak.map((entry) => entry.cost));
    const on = median(peak.map((entry) => entry.cost));
    expectedCost = off * (1 - peakFraction) + on * peakFraction;
    strategy = "time-weighted";
  } else if (standard.length === 1) {
    expectedCost = standard[0].cost;
  } else {
    // Multiple semantically identical rows are not expected. Median is safe only
    // after every variant has been classified as plain/standard.
    expectedCost = median(standard.map((entry) => entry.cost));
    strategy = "standard-row-median";
  }

  if (expectedCost == null) return { ok: false, reason: "unpriceable-workload" };
  const costs = priced.map((entry) => entry.cost);
  return {
    ok: true,
    expectedCost,
    bestCost: Math.min(...costs),
    worstCost: Math.max(...costs),
    strategy,
    priced,
  };
}

function bandSummary(workloads, results, band) {
  const costs = [];
  for (let i = 0; i < workloads.length; i++) {
    if (workloads[i].band === band && results[i]?.ok) costs.push(results[i].expectedCost);
  }
  const cost = median(costs);
  return cost == null ? null : { cost, requestsPerDollar: cost > 0 ? 1 / cost : null };
}

function timeRegimeSummary(workloads, rows) {
  const offRows = rows.filter((row) => row.time === "off-peak");
  const peakRows = rows.filter((row) => row.time === "peak");
  if (!offRows.length || !peakRows.length) return null;
  const offCosts = [];
  const peakCosts = [];
  for (const workload of workloads) {
    const offApplicable = selectContextRows(offRows, workload);
    const peakApplicable = selectContextRows(peakRows, workload);
    if (!offApplicable.length || !peakApplicable.length) continue;
    if (offApplicable.some((row) => !row.knownVariant) || peakApplicable.some((row) => !row.knownVariant)) continue;
    const off = median(offApplicable.map((row) => priceWorkload(row, workload)).filter((value) => value != null));
    const on = median(peakApplicable.map((row) => priceWorkload(row, workload)).filter((value) => value != null));
    if (off != null) offCosts.push(off);
    if (on != null) peakCosts.push(on);
  }
  const offPeakCost = median(offCosts);
  const peakCost = median(peakCosts);
  if (offPeakCost == null || peakCost == null) return null;
  return {
    offPeakCost,
    peakCost,
    offPeakRequestsPerDollar: offPeakCost > 0 ? 1 / offPeakCost : null,
    peakRequestsPerDollar: peakCost > 0 ? 1 / peakCost : null,
    peakUsagePenaltyPercent: offPeakCost > 0 && peakCost > 0 ? ((offPeakCost / peakCost) - 1) * 100 : null,
  };
}

function contextRegimeSummary(workloads, rows) {
  const thresholdRows = rows.filter((row) => row.threshold);
  if (!thresholdRows.length) return null;
  return thresholdRows.map((row) => {
    const costs = workloads
      .filter((workload) => thresholdMatches(row.threshold, workload.contextTokens))
      .map((workload) => priceWorkload(row, workload))
      .filter((value) => value != null);
    const cost = median(costs);
    return {
      label: row.variant,
      threshold: row.threshold,
      cost,
      requestsPerDollar: cost > 0 ? 1 / cost : null,
      matchingWorkloads: costs.length,
    };
  });
}

function usageUsdEvidence(rows) {
  const values = [...new Set(rows.map((row) => row.usageUsd).filter((value) => value != null))].sort((a, b) => a - b);
  return { values, value: values.length === 1 ? values[0] : null, consistent: values.length <= 1 };
}

function allPublishedTokenPricesZero(rows) {
  if (!rows.length) return false;
  return rows.every((row) => {
    const fields = [row.inputPerM, row.outputPerM, row.cachedReadPerM].filter((value) => value != null);
    return fields.length >= 2 && fields.every((value) => value === 0);
  });
}

function unrankedEntry(name, rows, warnings) {
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
    variantCount: rows.length,
    fractionOfBest: null,
    costMultipleVsBest: null,
    confidence: "low",
    warnings: [...new Set(warnings)],
  };
}

function evaluatePaidModel({ name, rows, corpus, notes = {}, ownProfile = null, request = null, goLimits = null, requireGoAllowance = false, promotionMultiplier = 1, chart = null }) {
  if (!corpus?.workloads?.length) return unrankedEntry(name, rows, ["No standardized OpenCode Go workload calibration is available."]);
  if (!rows.length) return unrankedEntry(name, rows, ["No published pricing row is available."]);

  const parsedRows = rows.map(([label, row]) => parsePricingRow(label, row));
  if (parsedRows.some((row) => !row.knownVariant)) {
    return unrankedEntry(name, rows, ["A pricing variant is not semantically classified; refusing to guess its applicability."]);
  }

  const peakFraction = peakFractionFromNotes(notes);
  const results = corpus.workloads.map((workload) => evaluateWorkload(parsedRows, workload, peakFraction));
  const failures = results.filter((result) => !result.ok).map((result) => result.reason);
  if (failures.length) {
    const reasonLabels = {
      "no-applicable-pricing-tier": "At least one standardized workload has no applicable pricing tier.",
      "unknown-pricing-variant": "A pricing variant is not semantically classified.",
      "incomplete-token-pricing": "Published input/output/cache pricing is incomplete for the standardized workload.",
      "incomplete-time-regime": "A time-based pricing regime is missing its Peak or Off-Peak companion row.",
      "unknown-time-regime-schedule": "Time-based prices exist but their schedule is not publicly parseable.",
      "unpriceable-workload": "A standardized workload could not be priced.",
    };
    return unrankedEntry(name, rows, failures.map((reason) => reasonLabels[reason] ?? reason));
  }

  const expectedCosts = results.map((result) => result.expectedCost);
  const cost = median(expectedCosts);
  if (!(cost > 0)) return unrankedEntry(name, rows, ["Standardized paid request cost is zero or invalid."]);

  const allowance = usageUsdEvidence(parsedRows);
  if (requireGoAllowance && !allowance.consistent) {
    return unrankedEntry(name, rows, ["Published Go included-usage values differ across pricing variants; no generic allowance rule is established."]);
  }
  if (requireGoAllowance && !(allowance.value > 0)) {
    return unrankedEntry(name, rows, ["Published Go included usage is missing, so subscription-capacity rank cannot be computed."]);
  }

  const practicalWorkload = workloadFromProfile(ownProfile);
  const practical = practicalWorkload ? evaluateWorkload(parsedRows, practicalWorkload, peakFraction) : null;
  const practicalCost = practical?.ok ? practical.expectedCost : null;
  const sourceMonthly = request?.unlimited ? null : finite(request?.requestsMonth);
  const impliedSourceCost = sourceMonthly && allowance.value != null ? allowance.value / sourceMonthly : null;
  const agreement = impliedSourceCost && practicalCost
    ? 1 - Math.min(1, Math.abs(impliedSourceCost - practicalCost) / impliedSourceCost)
    : null;

  const fiveHourRatio = finite(goLimits?.fiveHourUsd) != null && finite(goLimits?.monthlyUsd) > 0
    ? goLimits.fiveHourUsd / goLimits.monthlyUsd : null;
  const weeklyRatio = finite(goLimits?.weeklyUsd) != null && finite(goLimits?.monthlyUsd) > 0
    ? goLimits.weeklyUsd / goLimits.monthlyUsd : null;
  const monthlyEquivalentRequests = allowance.value != null ? allowance.value / cost : null;
  const baseFiveHourEquivalentRequests = monthlyEquivalentRequests != null && fiveHourRatio != null
    ? monthlyEquivalentRequests * fiveHourRatio : null;
  const weeklyEquivalentRequests = monthlyEquivalentRequests != null && weeklyRatio != null
    ? monthlyEquivalentRequests * weeklyRatio : null;
  const currentFiveHourEquivalentRequests = baseFiveHourEquivalentRequests != null
    ? baseFiveHourEquivalentRequests * promotionMultiplier : null;

  const warnings = [];
  if (practicalWorkload && practicalCost == null) warnings.push("The model's own published Go request profile could not be priced completely.");
  if (agreement != null && agreement < 0.7) warnings.push("Published request estimates and modeled own-profile cost differ materially.");
  if (promotionMultiplier > 1) warnings.push(`Current Go 5-hour chart promotion is ${promotionMultiplier}x; monthly promotion coverage is not inferred.`);

  return {
    name,
    class: "paid",
    free: false,
    rank: null,
    total: 0,
    tieCount: 1,
    basis: "usage-yield-v2",
    score: cost,
    costPerEquivalentRequest: cost,
    requestsPerDollar: 1 / cost,
    minCost: median(results.map((result) => result.bestCost)),
    maxCost: median(results.map((result) => result.worstCost)),
    variantCount: parsedRows.length,
    workloadCoverage: 1,
    workload: {
      corpusSize: corpus.workloads.length,
      light: bandSummary(corpus.workloads, results, "light"),
      typical: bandSummary(corpus.workloads, results, "typical"),
      heavy: bandSummary(corpus.workloads, results, "heavy"),
    },
    regimes: {
      peakFraction,
      time: timeRegimeSummary(corpus.workloads, parsedRows),
      context: contextRegimeSummary(corpus.workloads, parsedRows),
    },
    practical: {
      cost: practicalCost,
      requestsPerDollar: practicalCost > 0 ? 1 / practicalCost : null,
      impliedSourceCost,
      agreement,
    },
    goCapacity: allowance.value == null ? null : {
      includedUsageUsd: allowance.value,
      baseFiveHourEquivalentRequests,
      currentFiveHourEquivalentRequests,
      promotionMultiplier,
      weeklyEquivalentRequests,
      monthlyEquivalentRequests,
      publishedFiveHourRequests: request?.unlimited ? null : finite(request?.requests5h),
      publishedCurrentFiveHourRequests: chart?.unlimited ? null : finite(chart?.requests5h),
      publishedWeeklyRequests: request?.unlimited ? null : finite(request?.requestsWeek),
      publishedMonthlyRequests: sourceMonthly,
    },
    confidence: warnings.length ? "medium" : "high",
    warnings,
  };
}

function competitionRank(entries, valueOf, direction = "desc", fields = { rank: "rank", total: "total", tie: "tieCount" }) {
  const usable = entries.filter((entry) => Number.isFinite(valueOf(entry)));
  usable.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    const delta = direction === "desc" ? bv - av : av - bv;
    return Math.abs(delta) > EPSILON ? delta : a.name.localeCompare(b.name);
  });

  let previous = null;
  let rank = 0;
  for (let i = 0; i < usable.length; i++) {
    const value = valueOf(usable[i]);
    if (previous == null || Math.abs(value - previous) > EPSILON) rank = i + 1;
    usable[i][fields.rank] = rank;
    usable[i][fields.total] = usable.length;
    previous = value;
  }

  const counts = new Map();
  for (const entry of usable) counts.set(entry[fields.rank], (counts.get(entry[fields.rank]) ?? 0) + 1);
  for (const entry of usable) entry[fields.tie] = counts.get(entry[fields.rank]) ?? 1;
  return usable;
}

function finishPaidRanking(entries, mode) {
  const paid = entries.filter((entry) => entry.class === "paid");
  const ranked = competitionRank(
    paid,
    mode === "go-capacity" ? (entry) => entry.goCapacity?.monthlyEquivalentRequests : (entry) => entry.requestsPerDollar,
  );
  const best = ranked[0] ?? null;
  const bestYield = mode === "go-capacity" ? best?.goCapacity?.monthlyEquivalentRequests : best?.requestsPerDollar;
  for (const entry of ranked) {
    const yieldValue = mode === "go-capacity" ? entry.goCapacity?.monthlyEquivalentRequests : entry.requestsPerDollar;
    entry.rankBasis = mode;
    entry.fractionOfBest = bestYield > 0 ? yieldValue / bestYield : null;
    entry.costMultipleVsBest = entry.fractionOfBest > 0 ? 1 / entry.fractionOfBest : null;
    entry.valuePercentile = entry.total > 0 ? (entry.total - entry.rank + 1) / entry.total * 100 : null;
  }
  return ranked;
}

function annotateCurrentFiveHourRanking(entries) {
  return competitionRank(
    entries.filter((entry) => entry.class === "paid"),
    (entry) => entry.goCapacity?.currentFiveHourEquivalentRequests,
    "desc",
    { rank: "currentFiveHourRank", total: "currentFiveHourTotal", tie: "currentFiveHourTieCount" },
  );
}

function buildByKey(entries) {
  const byKey = new Map();
  for (const entry of entries) byKey.set(canonicalModelKey(entry.name), entry);
  return byKey;
}

function pricingGroups(pricing = {}) {
  const groups = new Map();
  for (const [label, row] of Object.entries(pricing ?? {})) {
    const name = basePricingName(label);
    const key = canonicalModelKey(name);
    if (!groups.has(key)) groups.set(key, { name, rows: [] });
    groups.get(key).rows.push([label, row]);
  }
  return groups;
}

function canonicalLookup(object, key) {
  return Object.entries(object ?? {}).find(([candidate]) => canonicalModelKey(candidate) === key)?.[1] ?? null;
}

function chartConsistencyFor(snapshot, key) {
  const consistency = deriveConsistency(snapshot?.go ?? {}, snapshot?.docs ?? {});
  const match = Object.entries(consistency).find(([name]) => canonicalModelKey(name) === key);
  return match?.[1] ?? null;
}

export function buildGoUsageYieldRanking(snapshot) {
  const docs = snapshot?.docs ?? {};
  const corpus = buildStandardWorkloadCorpus(docs.profiles ?? {});
  const groups = pricingGroups(docs.pricing ?? {});
  const names = new Map();
  for (const name of Object.keys(docs.requests ?? {})) names.set(canonicalModelKey(name), name);
  for (const name of Object.keys(docs.profiles ?? {})) names.set(canonicalModelKey(name), name);
  for (const { name } of groups.values()) if (!names.has(canonicalModelKey(name))) names.set(canonicalModelKey(name), name);

  const entries = [];
  for (const [key, name] of names) {
    const request = canonicalLookup(docs.requests, key);
    const ownProfile = canonicalLookup(docs.profiles, key);
    const chart = canonicalLookup(snapshot?.go?.chart, key);
    const rows = groups.get(key)?.rows ?? [];
    const consistency = chartConsistencyFor(snapshot, key);
    const promotionMultiplier = consistency?.status === "promotion" && finite(consistency.multiplier) > 1
      ? consistency.multiplier : 1;

    if (request?.unlimited === true || chart?.unlimited === true) {
      const disagreement = Boolean(request?.unlimited) !== Boolean(chart?.unlimited) && chart != null;
      entries.push({
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
        variantCount: rows.length,
        fractionOfBest: null,
        costMultipleVsBest: null,
        confidence: disagreement ? "medium" : "high",
        warnings: [
          "Go quota-exempt status does not prove the underlying free-model gateway has no separate rate limit.",
          ...(disagreement ? ["Go chart/docs currently disagree on quota-exempt state."] : []),
        ],
        goCapacity: {
          includedUsageUsd: null,
          baseFiveHourEquivalentRequests: null,
          currentFiveHourEquivalentRequests: null,
          promotionMultiplier: 1,
          weeklyEquivalentRequests: null,
          monthlyEquivalentRequests: null,
        },
      });
      continue;
    }

    const parsedRows = rows.map(([label, row]) => parsePricingRow(label, row));
    if (allPublishedTokenPricesZero(parsedRows)) {
      const knownCapacity = finite(request?.requests5h) > 0 && finite(request?.requestsMonth) > 0;
      entries.push({
        name,
        class: knownCapacity ? "free-limited-known" : "free-limited-unknown",
        free: true,
        rank: null,
        total: 0,
        tieCount: 1,
        basis: "go-free",
        score: 0,
        costPerEquivalentRequest: 0,
        requestsPerDollar: null,
        minCost: 0,
        maxCost: 0,
        variantCount: rows.length,
        confidence: knownCapacity ? "high" : "medium",
        warnings: knownCapacity ? [] : ["Free pricing is public but comparable request capacity is not established."],
        freeCapacity: knownCapacity ? {
          requests5h: request.requests5h,
          requestsWeek: request.requestsWeek,
          requestsMonth: request.requestsMonth,
        } : null,
      });
      continue;
    }

    entries.push(evaluatePaidModel({
      name,
      rows,
      corpus,
      notes: docs.notes ?? {},
      ownProfile,
      request,
      goLimits: docs.limits ?? null,
      requireGoAllowance: true,
      promotionMultiplier,
      chart,
    }));
  }

  const ranked = finishPaidRanking(entries, "go-capacity");
  annotateCurrentFiveHourRanking(entries);
  const paidTotal = ranked.length;
  for (const entry of entries) if (entry.class !== "paid") entry.total = paidTotal;

  return {
    schema: 2,
    basis: "usage-yield-v2",
    rankScope: "go-standardized-monthly-capacity",
    calibration: corpus,
    entries,
    paidEntries: ranked,
    freeEntries: entries.filter((entry) => entry.free),
    quotaExemptEntries: entries.filter((entry) => entry.class === "quota-exempt"),
    unrankedEntries: entries.filter((entry) => entry.class === "unranked"),
    byKey: buildByKey(entries),
    total: paidTotal,
  };
}

function calibrationFrom(value) {
  if (value?.workloads && Array.isArray(value.workloads)) return value;
  if (value?.docs?.profiles) return buildStandardWorkloadCorpus(value.docs.profiles);
  if (value?.usageCalibration?.workloads) return value.usageCalibration;
  return null;
}

export function buildZenUsageYieldRanking(snapshot, calibrationSource = null) {
  const corpus = calibrationFrom(calibrationSource) ?? calibrationFrom(snapshot);
  const entries = [];
  for (const model of Object.values(snapshot?.models ?? {})) {
    const name = model?.name ?? model?.id;
    if (!name) continue;
    const rows = (Array.isArray(model.pricing) ? model.pricing : []).map((row) => [row.label ?? name, row]);

    if (model?.free) {
      entries.push({
        name,
        class: "free-limited-unknown",
        free: true,
        rank: null,
        total: 0,
        tieCount: 1,
        basis: "zen-free",
        score: 0,
        costPerEquivalentRequest: 0,
        requestsPerDollar: null,
        minCost: 0,
        maxCost: 0,
        variantCount: rows.length,
        fractionOfBest: null,
        costMultipleVsBest: null,
        confidence: "medium",
        warnings: ["Public Zen sources establish free pricing but not a comparable request-capacity limit."],
      });
      continue;
    }

    const evaluated = evaluatePaidModel({
      name,
      rows,
      corpus,
      notes: snapshot?.docs?.notes ?? {},
    });
    if (evaluated.class === "paid") evaluated.goCapacity = null;
    entries.push(evaluated);
  }

  const ranked = finishPaidRanking(entries, "paid-yield");
  const paidTotal = ranked.length;
  for (const entry of entries) if (entry.class !== "paid") entry.total = paidTotal;

  return {
    schema: 2,
    basis: "usage-yield-v2",
    rankScope: "paid-standardized-requests-per-dollar",
    calibration: corpus,
    entries,
    paidEntries: ranked,
    freeEntries: entries.filter((entry) => entry.free),
    unrankedEntries: entries.filter((entry) => entry.class === "unranked"),
    byKey: buildByKey(entries),
    total: paidTotal,
  };
}

export function usageYieldFor(ranking, modelName) {
  return ranking?.byKey?.get(canonicalModelKey(basePricingName(modelName))) ?? null;
}
