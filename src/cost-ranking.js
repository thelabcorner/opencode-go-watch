import { canonicalModelKey } from "./parsers.js";

const EPSILON = 1e-12;

export function basePricingName(name) {
  return String(name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function neutralPriceScore(row) {
  const input = finite(row?.inputPerM);
  const output = finite(row?.outputPerM);
  const cached = finite(row?.cachedReadPerM);
  if (input == null && output == null && cached == null) return null;
  return (input ?? 0) + (output ?? 0) + (cached ?? 0);
}

function typicalRequestCost(profile, row) {
  if (!profile) return null;
  const inputPrice = finite(row?.inputPerM);
  const outputPrice = finite(row?.outputPerM);
  const cachedPrice = finite(row?.cachedReadPerM);
  if (inputPrice == null || outputPrice == null) return null;
  const input = finite(profile.inputTokens) ?? 0;
  const output = finite(profile.outputTokens) ?? 0;
  const cached = finite(profile.cachedTokens) ?? 0;
  return (input * inputPrice + output * outputPrice + cached * (cachedPrice ?? 0)) / 1_000_000;
}

function summarizeScores(name, scores, basis, free = false) {
  const usable = scores.filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!usable.length) return null;
  return {
    name,
    score: usable[0],
    minCost: usable[0],
    maxCost: usable.at(-1),
    variantCount: usable.length,
    basis,
    free,
  };
}

function rank(entries) {
  const sorted = entries.filter(Boolean).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const total = sorted.length;
  let previousScore = null;
  let currentRank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (previousScore == null || Math.abs(entry.score - previousScore) > EPSILON) currentRank = i + 1;
    entry.rank = currentRank;
    entry.total = total;
    previousScore = entry.score;
  }
  const counts = new Map();
  for (const entry of sorted) counts.set(entry.rank, (counts.get(entry.rank) ?? 0) + 1);
  for (const entry of sorted) entry.tieCount = counts.get(entry.rank) ?? 1;
  const byKey = new Map();
  for (const entry of sorted) byKey.set(canonicalModelKey(entry.name), entry);
  return { entries: sorted, byKey, total };
}

function pricingGroups(pricing = {}) {
  const groups = new Map();
  for (const [label, row] of Object.entries(pricing)) {
    const name = basePricingName(label);
    const key = canonicalModelKey(name);
    if (!groups.has(key)) groups.set(key, { name, rows: [] });
    groups.get(key).rows.push(row);
  }
  return groups;
}

export function buildGoCheapnessRanking(snapshot) {
  const docs = snapshot?.docs ?? {};
  const groups = pricingGroups(docs.pricing);
  const names = new Map();
  for (const name of Object.keys(docs.requests ?? {})) names.set(canonicalModelKey(name), name);
  for (const name of Object.keys(docs.profiles ?? {})) names.set(canonicalModelKey(name), name);
  for (const { name } of groups.values()) if (!names.has(canonicalModelKey(name))) names.set(canonicalModelKey(name), name);

  const entries = [];
  for (const [key, name] of names) {
    const request = Object.entries(docs.requests ?? {}).find(([candidate]) => canonicalModelKey(candidate) === key)?.[1] ?? null;
    const profile = Object.entries(docs.profiles ?? {}).find(([candidate]) => canonicalModelKey(candidate) === key)?.[1] ?? null;
    const rows = groups.get(key)?.rows ?? [];

    if (request?.unlimited === true && rows.every((row) => neutralPriceScore(row) == null || neutralPriceScore(row) === 0)) {
      entries.push(summarizeScores(name, [0], "go-quota-exempt", true));
      continue;
    }

    // Keep one unit across the entire Go ranking. OpenCode publishes a model-specific
    // typical-request token profile, so ranked paid models use estimated dollars per
    // typical request. A model without enough profile/pricing data stays unranked
    // instead of mixing an arbitrary token-price index into the same ordinal list.
    const requestCosts = rows.map((row) => typicalRequestCost(profile, row)).filter((value) => value != null);
    if (requestCosts.length) entries.push(summarizeScores(name, requestCosts, "go-typical-request", requestCosts.every((value) => value === 0)));
  }
  return rank(entries);
}

export function buildZenCheapnessRanking(snapshot) {
  const entries = [];
  for (const model of Object.values(snapshot?.models ?? {})) {
    const rows = Array.isArray(model?.pricing) ? model.pricing : [];
    if (model?.free) {
      entries.push(summarizeScores(model.name ?? model.id, [0], "zen-free", true));
      continue;
    }
    // Zen does not publish one comparable typical-request profile for every model.
    // Use a transparent neutral basket of the uniformly meaningful published rates:
    // input + output + cached read. Cached write is excluded because many models do
    // not expose it, which would otherwise penalize only the models that do.
    const scores = rows.map(neutralPriceScore).filter((value) => value != null);
    if (scores.length) entries.push(summarizeScores(model.name ?? model.id, scores, "token-price-index", false));
  }
  return rank(entries);
}

export function cheapnessFor(ranking, modelName) {
  return ranking?.byKey?.get(canonicalModelKey(basePricingName(modelName))) ?? null;
}
