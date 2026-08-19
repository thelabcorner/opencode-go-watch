import { extractHtmlTables, extractSectionHtml, normalizeSpace, textContent } from "./html.js";

const MONEY = /^\$([\d.]+)$/;

export function parseInteger(value) {
  const s = normalizeSpace(value).replace(/,/g, "");
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseMoney(value) {
  const s = normalizeSpace(value);
  if (s === "-" || s === "—" || s === "") return null;
  const match = MONEY.exec(s.replace(/,/g, ""));
  return match ? Number(match[1]) : null;
}

function canonicalHeader(value) {
  return normalizeSpace(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findTable(tables, requiredHeaders) {
  return tables.find((rows) => {
    const headers = (rows[0] ?? []).map(canonicalHeader);
    return requiredHeaders.every((needle) => headers.some((header) => header.includes(needle)));
  });
}

function rowsToRequestMap(rows) {
  const out = {};
  for (const row of rows.slice(1)) {
    if (row.length < 4) continue;
    const [model, fiveHour, week, month] = row;
    const requests5h = parseInteger(fiveHour);
    const requestsWeek = parseInteger(week);
    const requestsMonth = parseInteger(month);
    if (!model || requests5h == null || requestsWeek == null || requestsMonth == null) continue;
    out[normalizeSpace(model)] = { requests5h, requestsWeek, requestsMonth };
  }
  return out;
}

function rowsToPricingMap(rows) {
  const out = {};
  for (const row of rows.slice(1)) {
    if (row.length < 6) continue;
    const [model, input, output, cachedRead, cachedWrite, usage] = row;
    const name = normalizeSpace(model);
    if (!name) continue;
    out[name] = {
      inputPerM: parseMoney(input),
      outputPerM: parseMoney(output),
      cachedReadPerM: parseMoney(cachedRead),
      cachedWritePerM: parseMoney(cachedWrite),
      usageUsd: parseMoney(usage),
    };
  }
  return out;
}

function parseLimits(sectionText) {
  const patterns = {
    fiveHourUsd: /5\s*hour\s*limit\s*[—–-]\s*\$([\d.]+)/i,
    weeklyUsd: /weekly\s*limit\s*[—–-]\s*\$([\d.]+)/i,
    monthlyUsd: /monthly\s*limit\s*[—–-]\s*\$([\d.]+)/i,
  };
  const out = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = pattern.exec(sectionText);
    if (match) out[key] = Number(match[1]);
  }
  return out;
}

export function canonicalModelKey(value) {
  return normalizeSpace(value)
    .replace(/\([^)]*\)\s*$/g, "")
    .replace(/\bcode\b\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function resolveProfileCandidate(candidate, requestNames) {
  const key = canonicalModelKey(candidate);
  if (!key) return null;
  const exact = requestNames.find((name) => canonicalModelKey(name) === key);
  return exact ?? null;
}

/**
 * OpenCode often groups identical request profiles, e.g.:
 *   GLM-5.3/5.2/5.1
 *   Kimi K2.7/K2.6
 *
 * History shows that adding a model extends the grouped label rather than adding a
 * second row. Expand those labels back to actual request-table model names so a
 * GLM-5.3 launch is reported as "GLM-5.3 profile added" instead of a noisy
 * "GLM-5.2/5.1 removed + GLM-5.3/5.2/5.1 added" pair.
 */
export function expandProfileLabel(label, requestNames) {
  const clean = normalizeSpace(label).replace(/^[-*•]\s*/, "");
  const parts = clean.split("/").map(normalizeSpace).filter(Boolean);
  if (parts.length === 1) return [resolveProfileCandidate(clean, requestNames) ?? clean];

  const first = parts[0];
  const names = [];
  const firstResolved = resolveProfileCandidate(first, requestNames);
  if (firstResolved) names.push(firstResolved);

  // Split the first model into family prefix + numeric version. Examples:
  // "GLM-5.3" -> prefix "GLM-"; "Kimi K2.7" -> prefix "Kimi K".
  const version = /^(.*?)(\d+(?:\.\d+)+(?:\s+.*)?)$/.exec(first);
  const prefix = version?.[1] ?? "";

  for (const part of parts.slice(1)) {
    let candidate = part;
    if (prefix) {
      const lead = /^([A-Za-z-]*)(\d.*)$/.exec(part);
      if (lead && lead[1] && prefix.toLowerCase().endsWith(lead[1].toLowerCase())) {
        candidate = `${prefix.slice(0, -lead[1].length)}${part}`;
      } else {
        candidate = `${prefix}${part}`;
      }
    }
    const resolved = resolveProfileCandidate(candidate, requestNames);
    if (resolved) names.push(resolved);
  }

  return names.length ? [...new Set(names)] : [clean];
}

function parseProfiles(sectionText, requestNames) {
  const out = {};
  const pattern = /^([^\n]+?)\s*[—–-]\s*([\d,]+)\s+input,\s*([\d,]+)\s+cached,\s*([\d,]+)\s+output\s+tokens\s+per\s+request\s*$/gim;
  for (const match of sectionText.matchAll(pattern)) {
    const inputTokens = parseInteger(match[2]);
    const cachedTokens = parseInteger(match[3]);
    const outputTokens = parseInteger(match[4]);
    if (inputTokens == null || cachedTokens == null || outputTokens == null) continue;
    const profile = { inputTokens, cachedTokens, outputTokens };
    for (const model of expandProfileLabel(match[1], requestNames)) out[model] = profile;
  }
  return out;
}

function normalizeChartName(rawName, explicitBonus) {
  let name = normalizeSpace(rawName);
  let bonus = explicitBonus ? normalizeSpace(explicitBonus) : null;

  // Historical Go chart revisions encoded the promotion in the model name,
  // e.g. "GPT 5.6 Luna (2x usage)", before data-bonus became a separate span.
  const embedded = /^(.*?)\s*\((\d+(?:\.\d+)?\s*[x×]\s*usage)\)\s*$/i.exec(name);
  if (embedded) {
    name = normalizeSpace(embedded[1]);
    if (!bonus) bonus = normalizeSpace(embedded[2]).replace(/\s*[×]\s*/g, "x ").replace(/\s*x\s*/i, "x ");
  }
  return { name, bonus };
}

function parsePromoBanner(pageText) {
  const lines = String(pageText ?? "").split("\n").map(normalizeSpace).filter(Boolean);
  const direct = lines.find((line) => /usage\s+limits?/i.test(line) && /limited\s+time/i.test(line));
  if (direct) return direct.replace(/^New\s+/i, "");

  const match = /(?:^|\n)New\s*\n?([^\n]{1,220}?(?:usage limits?|usage|limited time)[^\n]*)/i.exec(pageText);
  return match ? normalizeSpace(match[1]) : null;
}

export function parseGoPage(html) {
  const source = String(html ?? "");
  const chart = {};

  // Parse the semantic pill content instead of SVG geometry. Attribute values may
  // be omitted (data-value) or present (data-value="...").
  const itemPattern = /<span\b[^>]*\bdata-value(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>(?:\s|<!--[\s\S]*?-->)*<span\b[^>]*\bdata-name(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>(?:(?:\s|<!--[\s\S]*?-->)*<span\b[^>]*\bdata-bonus(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>)?/gi;

  for (const match of source.matchAll(itemPattern)) {
    const requests5h = parseInteger(textContent(match[1]));
    const normalized = normalizeChartName(textContent(match[2]), match[3] ? textContent(match[3]) : null);
    if (!normalized.name || requests5h == null) continue;
    chart[normalized.name] = { requests5h, bonus: normalized.bonus };
  }

  // Fallback for a renderer that flattens the graph to text. This intentionally
  // scopes itself to the chart region to avoid interpreting unrelated numbers.
  const pageText = textContent(source);
  if (!Object.keys(chart).length) {
    const regionMatch = /Go\s+1x[\s\S]{0,5000}?Requests per 5 hour/i.exec(pageText);
    const region = regionMatch?.[0] ?? "";
    const rowPattern = /([\d,]+)\s+([A-Z][A-Za-z0-9.-]*(?:\s+[A-Za-z0-9().×x-]+){0,6})(?=\s+[\d,]+\s+[A-Z]|\s+\d+(?:\.\d+)?[x×]\s+usage|\s+Requests per 5 hour)/g;
    for (const match of region.matchAll(rowPattern)) {
      const requests5h = parseInteger(match[1]);
      const normalized = normalizeChartName(match[2], null);
      if (requests5h != null && normalized.name) chart[normalized.name] = { requests5h, bonus: normalized.bonus };
    }
    const bonusMatch = /([\d,]+)\s+([A-Z][A-Za-z0-9.-]*(?:\s+[A-Za-z0-9.-]+){0,5})\s+(\d+(?:\.\d+)?[x×]\s+usage)\s+Requests per 5 hour/i.exec(region);
    if (bonusMatch) {
      const requests5h = parseInteger(bonusMatch[1]);
      const normalized = normalizeChartName(bonusMatch[2], bonusMatch[3]);
      if (requests5h != null) chart[normalized.name] = { requests5h, bonus: normalized.bonus };
    }
  }

  if (!Object.keys(chart).length) throw new Error("Go page parser found no chart models");
  return { chart, promoBanner: parsePromoBanner(pageText) };
}

function extractUsageNotes(usageText) {
  const notes = {};
  const peak = /DeepSeek[^.\n]*Peak hours[^.\n]*\.?/i.exec(usageText);
  if (peak) notes.deepSeekPeakHours = normalizeSpace(peak[0]);
  const mutable = /Usage limits may change[^.\n]*\.?/i.exec(usageText);
  if (mutable) notes.limitsDisclaimer = normalizeSpace(mutable[0]);
  return notes;
}

export function parseDocsPage(html) {
  const source = String(html ?? "");
  const usageHtml = extractSectionHtml(source, "Usage\\s+limits") || source;
  const usageText = textContent(usageHtml);
  const tables = extractHtmlTables(usageHtml);
  const requestTable = findTable(tables, ["model", "requests per 5 hour", "requests per week", "requests per month"]);
  const pricingTable = findTable(tables, ["model", "input", "output", "cached read", "usage"]);

  if (!requestTable) throw new Error("Docs parser could not find request-count table");
  if (!pricingTable) throw new Error("Docs parser could not find pricing table");

  const limits = parseLimits(usageText);
  const requests = rowsToRequestMap(requestTable);
  const pricing = rowsToPricingMap(pricingTable);
  const profiles = parseProfiles(usageText, Object.keys(requests));
  const notes = extractUsageNotes(usageText);

  if (Object.keys(limits).length !== 3) throw new Error("Docs parser could not parse all three dollar limits");
  if (!Object.keys(requests).length) throw new Error("Docs parser request-count table was empty");
  if (!Object.keys(pricing).length) throw new Error("Docs parser pricing table was empty");
  if (!Object.keys(profiles).length) throw new Error("Docs parser request profiles were empty");

  return {
    limits,
    requests,
    pricing,
    profiles,
    notes,
    usageText: usageText.replace(/\s+/g, " ").trim(),
  };
}

export function parseBonusMultiplier(value) {
  const match = /^(\d+(?:\.\d+)?)\s*[x×]\s*usage$/i.exec(normalizeSpace(value));
  return match ? Number(match[1]) : null;
}

export function parsePromoDescriptor(value) {
  const text = normalizeSpace(value);
  if (!text) return null;
  const multiplier = /(\d+(?:\.\d+)?)\s*[x×]\s*(?:higher\s+)?usage(?:\s+limits?)?/i.exec(text);
  if (!multiplier) return null;
  const prefix = text.slice(0, multiplier.index).replace(/\s+(?:gets?|has|receives?|offers?)\s*$/i, "").trim();
  if (!prefix) return null;
  return { model: prefix, multiplier: Number(multiplier[1]) };
}

export function deriveConsistency(go, docs) {
  const out = {};
  const bannerPromo = parsePromoDescriptor(go.promoBanner);
  for (const [name, chart] of Object.entries(go.chart ?? {})) {
    const doc = docs.requests?.[name];
    if (!doc) {
      out[name] = { status: "chart_only", chart: chart.requests5h, docs: null };
      continue;
    }
    if (chart.requests5h === doc.requests5h) {
      out[name] = { status: "match", chart: chart.requests5h, docs: doc.requests5h };
      continue;
    }
    let multiplier = parseBonusMultiplier(chart.bonus);
    if (!multiplier && bannerPromo && canonicalModelKey(bannerPromo.model) === canonicalModelKey(name)) {
      multiplier = bannerPromo.multiplier;
    }
    if (multiplier && Math.round(doc.requests5h * multiplier) === chart.requests5h) {
      out[name] = { status: "promotion", chart: chart.requests5h, docs: doc.requests5h, multiplier };
      continue;
    }
    out[name] = { status: "mismatch", chart: chart.requests5h, docs: doc.requests5h };
  }
  return out;
}
