import { canonicalModelKey } from "./parsers.js";

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
 * Build the workload calibration used by Cheapness/Usage Yield V2.
 *
 * Duplicate token-shape tuples are deliberately deduplicated. OpenCode sometimes
 * publishes one shared profile for several sibling models; counting each alias as a
 * new observation would silently overweight that workload shape.
 */
export function buildStandardWorkloadCorpus(profiles = {}) {
  const unique = new Map();
  for (const [model, profile] of Object.entries(profiles ?? {})) {
    const workload = workloadFromProfile(profile);
    if (!workload) continue;
    const shape = `${workload.inputTokens}:${workload.cachedTokens}:${workload.outputTokens}`;
    const existing = unique.get(shape);
    if (existing) {
      existing.models.push(model);
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
  const source = String(label ?? "").trim();
  const match = /\(([^()]*)\)\s*$/.exec(source);
  return match ? match[1].trim() : "";
}

function parseThreshold(variant) {
  const match = /^(≤|>=|≥|<=|>|<)\s*([\d,.]+)\s*([kKmM]?)\s*tokens?$/i.exec(String(variant ?? "").trim());
  if (!match) return null;
  let value = Number(match[2].replaceAll(",", ""));
  if (!Number.isFinite(value)) return null;
  const unit = match[3].toLowerCase();
  if (unit === "k") value *= 1_000;
  if (unit === "m") value *= 1_000_000;
  const raw = match[1];
  const operator = raw === "≤" || raw === "<=" ? "<=" : raw === "≥" || raw === ">=" ? ">=" : raw;
  return { operator, tokens: value };
}

function parsePricingRow(label, row) {
  const variant = variantText(label);
  const threshold = parseThreshold(variant);
  const time = /^off[- ]peak$/i.test(variant) ? "off-peak" : /^peak$/i.test(variant) ? "peak" : null;
  const knownVariant = !variant || Boolean(threshold) || Boolean(time);
  return {
    label,
    variant: variant || "Standard",
    threshold,
    time,
    knownVariant,
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
    + workload.outputTokens * row.outputPerM
    + workload.cachedTokens * (row.cachedReadPerM ?? 0)
  ) / 1_000_000;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function durationHours(startHour, startMinute, endHour, endMinute) {
  const start = startHour + startMinute / 60;
  const end = endHour + endMinute / 60;
  return end >= start ? end - start : 24 - start + end;
}

/** Parse notes such as "Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday". */
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
  const generic = rows.filter((row) => !row.threshold);
  return generic;
}

function evaluateWorkload(rows, workload, peakFraction) {
  const applicable = selectContextRows(rows, workload);
  const priced = applicable
    .map((row) => ({ row, cost: priceWorkload(row, workload) }))
    .filter((entry) => entry.cost != null);
  if (!priced.length) return null;

  const offPeak = priced.filter((entry) => entry.row.time === "off-peak");
  const peak = priced.filter((entry) => entry.row.time === "peak");
  const standard = priced.filter((entry) => !entry.row.time);
  let expectedCost;
  let scheduleKnown = true;
  let strategy = "single";

  if (offPeak.length && peak.length) {
    const off = median(offPeak.map((entry) => entry.cost));
    const on = median(peak.map((entry) => entry.cost));
    if (peakFraction != null) {
      expectedCost = off * (1 - peakFraction) + on * peakFraction;
      strategy = "time-weighted";
    } else {
      expectedCost = (off + on) / 2;
      scheduleKnown = false;
      strategy = "time-midpoint";
    }
  } else if (standard.length === 1 && priced.length === 1) {
    expectedCost = standard[0].cost;
  } else {
    expectedCost = median(priced.map((entry) => entry.cost));
    scheduleKnown = priced.every((entry) => entry.row.knownVariant);
    strategy = priced.length > 1 ? "variant-median" : "single";
  }

  const costs = priced.map((entry) => entry.cost);
  return {
    expectedCost,
    bestCost: Math.min(...costs),
    worstCost: Math.max(...costs),
    scheduleKnown,
    strategy,
    priced,
  };
}

function medianCost(results, field = "expectedCost") {
  return median(results.filter(Boolean).map((result) => result[field]));
}

function bandSummary(workloads, results, band) {
  const selected = [];
  for (let i = 0; i < workloads.length; i++) {
    if (workloads[i].band === band && results[i]) selected.push(results[i].expectedCost);
  }
  const cost = median(selected);
  return cost == null ? null : { cost, requestsPerDollar: cost > 0 ? 1 / cost : null };
}

function timeRegimeSummary(workloads, rows) {
  const offRows = rows.filter((row) => row.time === "off-peak");
  const peakRows = rows.filter((row) => row.time === "peak");
  if (!offRows.length || !peakRows.length) return null;
  const offCosts = [];
  const peakCosts = [];
  for (const workload of workloads) {
    const off = evaluateWorkload(offRows, workload, null);
    const peak = evaluateWorkload(peakRows, workload, null);
    if (off) offCosts.push(off.expectedCost);
    if (peak) peakCosts.push(peak.expectedCost);
  }
  const offPeakCost = median(offCosts);
  const peakCost = median(peakCosts);
  if (offPeakCost == null || peakCost == null) return null;
  return {
    offPeakCost,
    peakCost,
    offPeakRequestsPerDollar: offPeakCost > 0 ? 1 / offPeakCost : null,
    peakRequestsPerDollar: peakCost > 0 ? 1 / peakCost : null,
    peakUsagePenaltyPercent: offPeakCost > 0 ? ((offPeakCost / peakCost) - 1) * 100 : null,
  };
}

function contextRegimeSummary(workloads, rows) {
  const thresholds = rows.filter((row) => row.threshold);
  if (!thresholds.length) return null;
  return thresholds.map((row) => {
    const matchingCosts = workloads
      .filter((workload) => thresholdMatches(row.threshold, workload.contextTokens))
      .map((workload) => priceWorkload(row, workload))
      .filter((cost) => cost != null);
    const cost = median(matchingCosts);
    return {
      label: row.variant,
      threshold: row.threshold,
      cost,
      requestsPerDollar: cost > 0 ? 1 / cost : null,
      matchingWorkloads: matchingCosts.length,
    };
  });
}

function usageUsdForRows(rows) {
  const values = [...new Set(rows.map((row) => row.usageUsd).filter((value) => value != null))];
  if (!values.length) return null;
  return median(values);
}

function evaluatePaidModel({ name, rows, corpus, notes = {}, ownProfile = null, request = null, goLimits = null }) {
  if (!corpus?.workloads?.length || !rows.length) return null;
  const parsedRows = rows.map(([label, row]) => parsePricingRow(label, row));
  const peakFraction = peakFractionFromNotes(notes);
  const results = corpus.workloads.map((workload) => evaluateWorkload(parsedRows, workload, peakFraction));
  const validResults = results.filter(Boolean);
  if (!validResults.length) return null;
  const coverage = validResults.length / corpus.workloads.length;
  const cost = medianCost(validResults);
  if (cost == null || cost <= 0) return null;

  const practicalWorkload = workloadFromProfile(ownProfile);
  const practicalResult = practicalWorkload ? evaluateWorkload(parsedRows, practicalWorkload, peakFraction) : null;
  const usageUsd = usageUsdForRows(parsedRows);
  const monthlyEquivalentRequests = usageUsd != null ? usageUsd / cost : null;
  const fiveHourRatio = finite(goLimits?.fiveHourUsd) != null && finite(goLimits?.monthlyUsd) > 0
    ? goLimits.fiveHourUsd / goLimits.monthlyUsd : null;
  const weeklyRatio = finite(goLimits?.weeklyUsd) != null && finite(goLimits?.monthlyUsd) > 0
    ? goLimits.weeklyUsd / goLimits.monthlyUsd : null;

  const sourceMonthly = request?.unlimited ? null : finite(request?.requestsMonth);
  const impliedSourceCost = sourceMonthly && usageUsd != null ? usageUsd / sourceMonthly : null;
  const practicalCost = practicalResult?.expectedCost ?? null;
  const agreement = impliedSourceCost && practicalCost
    ? 1 - Math.min(1, Math.abs(impliedSourceCost - practicalCost) / impliedSourceCost)
    : null;

  const warnings = [];
  if (coverage < 1) warnings.push(`Pricing covered ${Math.round(coverage * 100)}% of standardized workloads.`);
  if (validResults.some((result) => !result.scheduleKnown)) warnings.push("A pricing regime has no parseable schedule; midpoint/median pricing was used.");
  if (parsedRows.some((row) => !row.knownVariant)) warnings.push("One or more pricing variants are not semantically classified.");
  if (practicalCost == null && ownProfile) warnings.push("The model's own Go request profile could not be priced completely.");

  const confidence = coverage === 1 && !warnings.length ? "high" : coverage >= 0.75 ? "medium" : "low";
  return {
    name,
    class: "paid",
    free: false,
    score: cost,
    basis: "usage-yield-v2",
    costPerEquivalentRequest: cost,
    requestsPerDollar: 1 / cost,
    minCost: medianCost(validResults, "bestCost"),
    maxCost: medianCost(validResults, "worstCost"),
    variantCount: parsedRows.length,
    workloadCoverage: coverage,
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
    goCapacity: usageUsd == null ? null : {
      includedUsageUsd: usageUsd,
      fiveHourEquivalentRequests: fiveHourRatio == null ? null : usageUsd * fiveHourRatio / cost,
      weeklyEquivalentRequests: weeklyRatio == null ? null : usageUsd * weeklyRatio / cost,
      monthlyEquivalentRequests,
      publishedFiveHourRequests: request?.unlimited ? null : finite(request?.requests5h),
      publishedWeeklyRequests: request?.unlimited ? null : finite(request?.requestsWeek),
      publishedMonthlyRequests: sourceMonthly,
    },
    confidence,
    warnings,
  };
}

function competitionRank(entries, valueOf, direction = "asc") {
  const usable = entries.filter((entry) => Number.isFinite(valueOf(entry)));
  usable.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    const delta = direction === "desc" ? bv - av : av - bv;
    return Math.abs(delta) > EPSILON ? delta : a.name.localeCompare(b.name);
  });
  let prior = null;
  let rank = 0;
  for (let i = 0; i < usable.length; i++) {
    const value = valueOf(usable[i]);
    if (prior == null || Math.abs(value - prior) > EPSILON) rank = i + 1;
    usable[i].rank = rank;
    usable[i].total = usable.length;
    prior = value;
  }
  const counts = new Map();
  for (const entry of usable) counts.set(entry.rank, (counts.get(entry.rank) ?? 0) + 1);
  for (const entry of usable) entry.tieCount = counts.get(entry.rank) ?? 1;
  return usable;
}

function finishPaidRanking(entries, mode) {
  const paid = entries.filter((entry) => entry?.class === "paid");
  const ranked = competitionRank(
    paid,
    mode === "go-capacity"
      ? (entry) => entry.goCapacity?.monthlyEquivalentRequests
      : (entry) => entry.requestsPerDollar,
    "desc",
  );
  const best = ranked[0] ?? null;
  const bestYield = mode === "go-capacity"
    ? best?.goCapacity?.monthlyEquivalentRequests
    : best?.requestsPerDollar;
  for (const entry of ranked) {
    const yieldValue = mode === "go-capacity"
      ? entry.goCapacity?.monthlyEquivalentRequests
      : entry.requestsPerDollar;
    entry.rankBasis = mode;
    entry.fractionOfBest = bestYield > 0 ? yieldValue / bestYield : null;
    entry.costMultipleVsBest = entry.fractionOfBest > 0 ? 1 / entry.fractionOfBest : null;
    entry.valuePercentile = entry.total > 0 ? (entry.total - entry.rank + 1) / entry.total * 100 : null;
  }
  return ranked;
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
    const requestEntry = Object.entries(docs.requests ?? {}).find(([candidate]) => canonicalModelKey(candidate) === key);
    const profileEntry = Object.entries(docs.profiles ?? {}).find(([candidate]) => canonicalModelKey(candidate) === key);
    const request = requestEntry?.[1] ?? null;
    const ownProfile = profileEntry?.[1] ?? null;
    const rows = groups.get(key)?.rows ?? [];

    if (request?.unlimited === true) {
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
        confidence: "high",
        warnings: ["Go quota-exempt status does not prove the underlying free-model gateway has no separate rate limit."],
        goCapacity: { includedUsageUsd: null, fiveHourEquivalentRequests: null, weeklyEquivalentRequests: null, monthlyEquivalentRequests: null },
      });
      continue;
    }

    const evaluated = evaluatePaidModel({
      name,
      rows,
      corpus,
      notes: docs.notes ?? {},
      ownProfile,
      request,
      goLimits: docs.limits ?? null,
    });
    if (evaluated) entries.push(evaluated);
    else entries.push({
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
      confidence: "low",
      warnings: ["Insufficient standardized workload/pricing evidence for a Usage Yield rank."],
    });
  }

  const ranked = finishPaidRanking(entries, "go-capacity");
  const paidTotal = ranked.length;
  for (const entry of entries) if (entry.class !== "paid") entry.total = paidTotal;
  return {
    schema: 2,
    basis: "usage-yield-v2",
    rankScope: "go-standardized-monthly-capacity",
    calibration: corpus,
    entries,
    paidEntries: ranked,
    freeEntries: entries.filter((entry) => entry.class === "quota-exempt"),
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
        variantCount: Array.isArray(model.pricing) ? model.pricing.length : 0,
        confidence: "medium",
        warnings: ["Public Zen sources establish free pricing but not a comparable request-capacity limit."],
      });
      continue;
    }

    if (!corpus?.workloads?.length) {
      entries.push({
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
        variantCount: Array.isArray(model.pricing) ? model.pricing.length : 0,
        confidence: "low",
        warnings: ["No current Go workload calibration is available."],
      });
      continue;
    }

    const rows = (Array.isArray(model.pricing) ? model.pricing : []).map((row) => [row.label ?? name, row]);
    const evaluated = evaluatePaidModel({
      name,
      rows,
      corpus,
      notes: snapshot?.docs?.notes ?? {},
      ownProfile: null,
      request: null,
      goLimits: null,
    });
    if (evaluated) {
      evaluated.goCapacity = null;
      entries.push(evaluated);
    } else {
      entries.push({
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
        confidence: "low",
        warnings: ["Published Zen pricing is incomplete for the standardized coding-agent workload."],
      });
    }
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
    freeEntries: entries.filter((entry) => entry.class === "free-limited-unknown"),
    unrankedEntries: entries.filter((entry) => entry.class === "unranked"),
    byKey: buildByKey(entries),
    total: paidTotal,
  };
}

export function usageYieldFor(ranking, modelName) {
  return ranking?.byKey?.get(canonicalModelKey(basePricingName(modelName))) ?? null;
}
