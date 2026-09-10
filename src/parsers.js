import { canonicalMonitoredHtml, extractHtmlTables, extractSectionHtml, normalizeSpace, textContent } from "./html.js";

const MONEY = /^\$([\d.]+)$/;
const INTEGER = /^-?\d+$/;
const UNLIMITED = /^(?:∞|infinity|unlimited)$/i;
const EMPTY_LIMIT = /^(?:-|—|–)$/;
const PROFILE_RE = /^([^\n]+?)\s*[—–-]\s*([\d,]+)\s+input,\s*([\d,]+)\s+cached,\s*([\d,]+)\s+output\s+tokens\s+per\s+request\s*$/gim;
const ITEM_START_RE = /<span\b[^>]*\bdata-item(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>/gi;
const MODEL_ROW_START_RE = /<div\b(?=[^>]*\bdata-slot\s*=\s*(?:"model-row"|'model-row'|model-row))[^>]*>/gi;
const VALUE_RE = /<span\b[^>]*\bdata-value(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>/i;
const NAME_RE = /<span\b[^>]*\bdata-name(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>/i;
const BONUS_RE = /<span\b[^>]*\bdata-bonus(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>/i;
const MODEL_CELL_RE = /<div\b(?=[^>]*\bdata-slot\s*=\s*(?:"model"|'model'|model))[^>]*>([\s\S]*?)<\/div>/i;
const REQUESTS_CELL_RE = /<div\b(?=[^>]*\bdata-slot\s*=\s*(?:"requests"|'requests'|requests))[^>]*>([\s\S]*?)<\/div>/i;
const BDI_RE = /<bdi\b[^>]*>([\s\S]*?)<\/bdi>/gi;
const BADGE_RE = /<span\b(?=[^>]*\bdata-slot\s*=\s*(?:"badge"|'badge'|badge))[^>]*>([\s\S]*?)<\/span>/gi;
const GRAPH_MARKER_RE = /\bdata-component\s*=\s*["'](?:limit-graph|go-usage)["']/i;
const PROMO_TEXT_RE = /usage\s+limits?/i;
const LIMITED_TIME_RE = /limited\s+time/i;
const MAX_PROMO_PREFIX = 96_000;

function compactScalar(value) {
  let source = String(value ?? "").trim();
  if (source.includes("&")) source = normalizeSpace(source);
  return source;
}

export function parseInteger(value) {
  const s = compactScalar(value).replaceAll(",", "");
  if (!INTEGER.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseMoney(value) {
  const source = compactScalar(value);
  if (source === "-" || source === "—" || source === "") return null;
  const match = MONEY.exec(source.replaceAll(",", ""));
  return match ? Number(match[1]) : null;
}

function parseRequestLimit(value) {
  const source = compactScalar(value);
  if (UNLIMITED.test(source)) return { value: null, unlimited: true, empty: false };
  if (!source || EMPTY_LIMIT.test(source)) return { value: null, unlimited: false, empty: true };
  const parsed = parseInteger(source);
  return { value: parsed, unlimited: false, empty: parsed == null };
}

function canonicalHeader(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findTable(tables, requiredHeaders) {
  for (const rows of tables) {
    const headers = rows[0] ?? [];
    let matched = true;
    for (const requirement of requiredHeaders) {
      const needles = Array.isArray(requirement) ? requirement : [requirement];
      let found = false;
      for (const header of headers) {
        if (needles.some((needle) => canonicalHeader(header).includes(canonicalHeader(needle)))) {
          found = true;
          break;
        }
      }
      if (!found) {
        matched = false;
        break;
      }
    }
    if (matched) return rows;
  }
  return undefined;
}

function headerIndex(headers, aliases) {
  const needles = (Array.isArray(aliases) ? aliases : [aliases]).map(canonicalHeader);
  const canonical = headers.map(canonicalHeader);
  for (const needle of needles) {
    const exact = canonical.indexOf(needle);
    if (exact >= 0) return exact;
  }
  return canonical.findIndex((header) => needles.some((needle) => header.includes(needle)));
}

function rowsToRequestMap(rows) {
  const out = {};
  const headers = rows[0] ?? [];
  const model = headerIndex(headers, "model");
  const fiveHour = headerIndex(headers, "requests per 5 hour");
  const weekly = headerIndex(headers, "requests per week");
  const monthly = headerIndex(headers, "requests per month");
  if ([model, fiveHour, weekly, monthly].some((index) => index < 0)) return out;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[model]) continue;
    const five = parseRequestLimit(row[fiveHour]);
    const week = parseRequestLimit(row[weekly]);
    const month = parseRequestLimit(row[monthly]);
    const explicitUnlimited = five.unlimited || week.unlimited || month.unlimited;
    // OpenCode currently represents Go models that sit outside the dollar quota as
    // ∞ on the landing chart but '-' across all request-count cells in the docs.
    // Preserve that row instead of dropping it. We only infer quota exemption from
    // an all-empty row; this does NOT imply absence of a separate free-model rate limit.
    const quotaExempt = explicitUnlimited || (five.empty && week.empty && month.empty);
    if (quotaExempt) {
      out[row[model]] = { requests5h: null, requestsWeek: null, requestsMonth: null, unlimited: true };
      continue;
    }
    if (five.value == null || week.value == null || month.value == null) continue;
    out[row[model]] = { requests5h: five.value, requestsWeek: week.value, requestsMonth: month.value, unlimited: false };
  }
  return out;
}

function rowsToPricingMap(rows) {
  const out = {};
  const headers = rows[0] ?? [];
  const model = headerIndex(headers, "model");
  const input = headerIndex(headers, "input");
  const output = headerIndex(headers, "output");
  const cachedRead = headerIndex(headers, "cached read");
  const cachedWrite = headerIndex(headers, "cached write");
  const usage = headerIndex(headers, ["usage", "monthly limit", "monthly usage", "included usage"]);
  if ([model, input, output, cachedRead, usage].some((index) => index < 0)) return out;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[model]) continue;
    out[row[model]] = {
      inputPerM: parseMoney(row[input]),
      outputPerM: parseMoney(row[output]),
      cachedReadPerM: parseMoney(row[cachedRead]),
      cachedWritePerM: cachedWrite < 0 ? null : parseMoney(row[cachedWrite]),
      usageUsd: parseMoney(row[usage]),
    };
  }
  return out;
}

function parseLimits(sectionText) {
  // Current docs define window limits as percentages of each model's monthly limit.
  // Normalize that policy onto a $60 monthly reference so the existing snapshot
  // fields stay compatible with historical {12,30,60} baselines without depending
  // on the docs retaining a particular dollar example.
  const fiveHourPercent = /5\s*[-–—]?\s*hour\s*[—–-]\s*([\d.]+)\s*%/i.exec(sectionText);
  const weeklyPercent = /\bweekly\s*[—–-]\s*([\d.]+)\s*%/i.exec(sectionText);
  const monthlyPercent = /\bmonthly\s*[—–-]\s*([\d.]+)\s*%/i.exec(sectionText);
  if (fiveHourPercent && weeklyPercent && monthlyPercent) {
    const five = Number(fiveHourPercent[1]);
    const week = Number(weeklyPercent[1]);
    const month = Number(monthlyPercent[1]);
    if (Number.isFinite(five) && Number.isFinite(week) && Number.isFinite(month) && month > 0) {
      const referenceMonthlyUsd = 60;
      const normalized = (percent) => Number((referenceMonthlyUsd * percent / month).toFixed(6));
      return {
        fiveHourUsd: normalized(five),
        weeklyUsd: normalized(week),
        monthlyUsd: referenceMonthlyUsd,
      };
    }
  }

  // Historical docs exposed explicit dollar values. Keep this fallback so archived
  // fixtures and older source representations remain parseable.
  const fiveHour = /5\s*[-–—]?\s*hour\s*limit\s*[—–-]\s*\$([\d.]+)/i.exec(sectionText);
  const weekly = /weekly\s*limit\s*[—–-]\s*\$([\d.]+)/i.exec(sectionText);
  const monthly = /monthly\s*limit\s*[—–-]\s*\$([\d.]+)/i.exec(sectionText);
  const out = {};
  if (fiveHour) out.fiveHourUsd = Number(fiveHour[1]);
  if (weekly) out.weeklyUsd = Number(weekly[1]);
  if (monthly) out.monthlyUsd = Number(monthly[1]);
  return out;
}

export function canonicalModelKey(value) {
  return normalizeSpace(value)
    .replace(/\([^)]*\)\s*$/g, "")
    .replace(/\bcode\b\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function requestNameIndex(requestNames) {
  const index = new Map();
  for (const name of requestNames) index.set(canonicalModelKey(name), name);
  return index;
}

function resolveProfileCandidate(candidate, index) {
  const key = canonicalModelKey(candidate);
  return key ? index.get(key) ?? null : null;
}

function expandProfileLabelIndexed(label, index) {
  const clean = normalizeSpace(label).replace(/^[-*•]\s*/, "");
  const parts = clean.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1) return [resolveProfileCandidate(clean, index) ?? clean];

  const first = parts[0];
  const names = [];
  const firstResolved = resolveProfileCandidate(first, index);
  if (firstResolved) names.push(firstResolved);

  const version = /^(.*?)(\d+(?:\.\d+)+(?:\s+.*)?)$/.exec(first);
  const prefix = version?.[1] ?? "";

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    let candidate = part;
    if (prefix) {
      const lead = /^([A-Za-z-]*)(\d.*)$/.exec(part);
      candidate = lead && lead[1] && prefix.toLowerCase().endsWith(lead[1].toLowerCase())
        ? `${prefix.slice(0, -lead[1].length)}${part}`
        : `${prefix}${part}`;
    }
    const resolved = resolveProfileCandidate(candidate, index);
    if (resolved) names.push(resolved);
  }

  return names.length ? [...new Set(names)] : [clean];
}

/** Expand grouped historical labels such as GLM-5.3/5.2/5.1. */
export function expandProfileLabel(label, requestNames) {
  return expandProfileLabelIndexed(label, requestNameIndex(requestNames));
}

function parseProfiles(sectionText, requestNames) {
  const out = {};
  const index = requestNameIndex(requestNames);
  PROFILE_RE.lastIndex = 0;
  let match;
  while ((match = PROFILE_RE.exec(sectionText)) !== null) {
    const inputTokens = parseInteger(match[2]);
    const cachedTokens = parseInteger(match[3]);
    const outputTokens = parseInteger(match[4]);
    if (inputTokens == null || cachedTokens == null || outputTokens == null) continue;
    const profile = { inputTokens, cachedTokens, outputTokens };
    for (const model of expandProfileLabelIndexed(match[1], index)) out[model] = profile;
  }
  return out;
}

function normalizeChartName(rawName, explicitBonus) {
  let name = normalizeSpace(rawName);
  let bonus = explicitBonus ? normalizeSpace(explicitBonus) : null;
  const embedded = /^(.*?)\s*\((\d+(?:\.\d+)?\s*[x×]\s*usage)\)\s*$/i.exec(name);
  if (embedded) {
    name = normalizeSpace(embedded[1]);
    if (!bonus) bonus = normalizeSpace(embedded[2]).replace(/\s*[×]\s*/g, "x ").replace(/\s*x\s*/i, "x ");
  }
  return { name, bonus };
}

function parsePromoBannerText(pageText) {
  const source = String(pageText ?? "");
  const lines = source.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line && PROMO_TEXT_RE.test(line) && LIMITED_TIME_RE.test(line)) return line.replace(/^New\s+/i, "");
  }
  const match = /(?:^|\n)New\s*\n?([^\n]{1,220}?(?:usage limits?|usage|limited time)[^\n]*)/i.exec(source);
  return match ? normalizeSpace(match[1]) : null;
}

function graphSlice(source) {
  const marker = GRAPH_MARKER_RE.exec(source);
  if (!marker) return { chartHtml: source, chartStart: -1 };
  const start = source.lastIndexOf("<figure", marker.index);
  if (start < 0) return { chartHtml: source, chartStart: -1 };
  const close = source.indexOf("</figure>", marker.index);
  if (close < 0) return { chartHtml: source.slice(start), chartStart: start };
  return { chartHtml: source.slice(start, close + 9), chartStart: start };
}

function balancedElementEnd(source, start, tagName) {
  const re = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (/^<\s*\//.test(match[0])) depth--;
    else depth++;
    if (depth === 0) return re.lastIndex;
  }
  return -1;
}

function monitoredRanges(chartHtml) {
  const starts = [];
  ITEM_START_RE.lastIndex = 0;
  MODEL_ROW_START_RE.lastIndex = 0;
  let match;
  while ((match = ITEM_START_RE.exec(chartHtml)) !== null) starts.push({ index: match.index, tagName: "span" });
  while ((match = MODEL_ROW_START_RE.exec(chartHtml)) !== null) starts.push({ index: match.index, tagName: "div" });
  starts.sort((a, b) => a.index - b.index);
  return starts
    .map(({ index, tagName }) => [index, balancedElementEnd(chartHtml, index, tagName)])
    .filter(([, end]) => end >= 0);
}

function buildGoMonitorStructure(chartHtml) {
  const items = [];
  const ranges = monitoredRanges(chartHtml);
  for (const [start, end] of ranges) {
    items.push(canonicalMonitoredHtml(chartHtml.slice(start, end), { dropSvg: true, includeText: true }));
  }

  // Model ordering on the graph is presentation, not semantics. Sort canonical
  // item blocks so a harmless reorder remains silent while unknown attributes or
  // text inside an item still alter the residual representation.
  items.sort();
  let rest = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    rest += chartHtml.slice(cursor, start);
    cursor = end;
  }
  rest += chartHtml.slice(cursor);
  const shell = canonicalMonitoredHtml(rest, { dropSvg: true, includeText: true });
  return `${shell}\n--items--\n${items.join("\n")}`.trim();
}

/**
 * Cheap pre-parser used by the watcher before SHA-256 fingerprinting. It limits
 * downstream work to the graph and the small prefix where OpenCode renders the
 * promotional banner, rather than repeatedly stripping the entire landing page.
 */
export function prepareGoPage(html) {
  const source = String(html ?? "");
  const { chartHtml, chartStart } = graphSlice(source);
  const prefixEnd = chartStart >= 0 ? chartStart : source.length;
  const prefixStart = Math.max(0, prefixEnd - MAX_PROMO_PREFIX);
  const promoText = textContent(source.slice(prefixStart, prefixEnd));
  const promoBanner = parsePromoBannerText(promoText);
  const monitorStructure = buildGoMonitorStructure(chartHtml);
  return {
    chartHtml,
    promoBanner,
    monitorStructure,
    fingerprintSource: `${chartHtml}\n<!--promo:${promoBanner ?? ""}-->`,
  };
}

export function parsePreparedGoPage(prepared) {
  const chart = {};

  // Current Go markup uses an ARIA table with model-row/data-slot semantics rather
  // than the historical limit-graph span pills. Parse by stable semantic slots and
  // keep the old representation below for snapshot/history compatibility.
  const modelRows = [];
  MODEL_ROW_START_RE.lastIndex = 0;
  let modelRowStart;
  while ((modelRowStart = MODEL_ROW_START_RE.exec(prepared.chartHtml)) !== null) {
    modelRows.push({ index: modelRowStart.index, tag: modelRowStart[0] });
  }
  for (let i = 0; i < modelRows.length; i++) {
    const segment = prepared.chartHtml.slice(modelRows[i].index, i + 1 < modelRows.length ? modelRows[i + 1].index : prepared.chartHtml.length);
    const modelCell = MODEL_CELL_RE.exec(segment)?.[1] ?? "";
    BDI_RE.lastIndex = 0;
    const nameMatch = BDI_RE.exec(modelCell);
    const name = nameMatch ? normalizeSpace(textContent(nameMatch[1])) : "";

    const requestsCell = REQUESTS_CELL_RE.exec(segment)?.[1] ?? "";
    BDI_RE.lastIndex = 0;
    let requests5h = null;
    let requestValue;
    while ((requestValue = BDI_RE.exec(requestsCell)) !== null) {
      const parsed = parseInteger(textContent(requestValue[1]));
      if (parsed != null) requests5h = parsed;
    }
    const explicitInfinite = /\bdata-infinite(?:\s|=|>)/i.test(modelRows[i].tag)
      || UNLIMITED.test(compactScalar(textContent(requestsCell)));

    let bonus = null;
    BADGE_RE.lastIndex = 0;
    let badge;
    while ((badge = BADGE_RE.exec(modelCell)) !== null) {
      const multiplier = parseBonusMultiplier(textContent(badge[1]));
      if (multiplier != null) {
        bonus = `${multiplier}x usage`;
        break;
      }
    }
    if (name && (explicitInfinite || requests5h != null)) {
      chart[name] = { requests5h: explicitInfinite ? null : requests5h, bonus, unlimited: explicitInfinite };
    }
  }

  // Segment by each outer data-item rather than assuming data-value/data-name are
  // adjacent siblings. Solid SSR may interleave hydration markers/comments.
  const starts = [];
  ITEM_START_RE.lastIndex = 0;
  let itemStart;
  while ((itemStart = ITEM_START_RE.exec(prepared.chartHtml)) !== null) starts.push({ index: itemStart.index, tag: itemStart[0] });
  for (let i = 0; i < starts.length; i++) {
    const segment = prepared.chartHtml.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : prepared.chartHtml.length);
    const valueMatch = VALUE_RE.exec(segment);
    const nameMatch = NAME_RE.exec(segment);
    if (!nameMatch) continue;
    const bonusMatch = BONUS_RE.exec(segment);
    const valueText = valueMatch ? textContent(valueMatch[1]) : "";
    const explicitInfinite = /\bdata-infinite(?:\s|=|>)/i.test(starts[i].tag) || UNLIMITED.test(compactScalar(valueText));
    const requests5h = explicitInfinite ? null : parseInteger(valueText);
    const normalized = normalizeChartName(textContent(nameMatch[1]), bonusMatch ? textContent(bonusMatch[1]) : null);
    if (normalized.name && (explicitInfinite || requests5h != null)) {
      chart[normalized.name] = { requests5h, bonus: normalized.bonus, unlimited: explicitInfinite };
    }
  }

  // Text fallback also runs for suspiciously small structured results, not just
  // zero. This lets the validator see the complete chart after an SSR shape shift.
  if (Object.keys(chart).length < 5) {
    const chartText = textContent(prepared.chartHtml);
    const regionMatch = /Go\s+1x[\s\S]{0,8000}?Requests per 5 hour/i.exec(chartText);
    const region = regionMatch?.[0] ?? chartText;
    const rowPattern = /([\d,]+|∞)\s+([A-Z][A-Za-z0-9.-]*(?:\s+[A-Za-z0-9().×x-]+){0,8}?)(?=\s+(?:[\d,]+|∞)\s+[A-Z]|\s+\d+(?:\.\d+)?[x×]\s+usage|\s+Requests per 5 hour)/g;
    let row;
    while ((row = rowPattern.exec(region)) !== null) {
      const explicitInfinite = UNLIMITED.test(compactScalar(row[1]));
      const requests5h = explicitInfinite ? null : parseInteger(row[1]);
      const normalized = normalizeChartName(row[2], null);
      if (normalized.name && (explicitInfinite || requests5h != null)) chart[normalized.name] = { requests5h, bonus: normalized.bonus, unlimited: explicitInfinite };
    }
    const bonusMatch = /([\d,]+)\s+([A-Z][A-Za-z0-9.-]*(?:\s+[A-Za-z0-9.-]+){0,8})\s+(\d+(?:\.\d+)?[x×]\s+usage)/i.exec(region);
    if (bonusMatch) {
      const requests5h = parseInteger(bonusMatch[1]);
      const normalized = normalizeChartName(bonusMatch[2], bonusMatch[3]);
      if (requests5h != null) chart[normalized.name] = { requests5h, bonus: normalized.bonus, unlimited: false };
    }
  }

  if (!Object.keys(chart).length) throw new Error("Go page parser found no chart models");
  return { chart, promoBanner: prepared.promoBanner, monitorStructure: prepared.monitorStructure };
}

export function parseGoPage(html) {
  return parsePreparedGoPage(prepareGoPage(html));
}

function extractUsageNotes(usageText) {
  const notes = {};
  // Do not use '.' as a sentence boundary before "Peak hours": model families can
  // contain dotted versions such as DeepSeek V4.1 Flash. Paragraph/newline scope is
  // the stable boundary in the rendered docs.
  const peak = /\bDeepSeek\b[^\n]{0,600}?\bPeak hours?\b[^\n]*/i.exec(usageText);
  if (peak) notes.deepSeekPeakHours = normalizeSpace(peak[0]);
  const mutable = /Usage limits may change[^.\n]*\.?/i.exec(usageText);
  if (mutable) notes.limitsDisclaimer = normalizeSpace(mutable[0]);
  return notes;
}

export function prepareDocsPage(html) {
  const source = String(html ?? "");
  const usageHtml = extractSectionHtml(source, "Usage\\s+limits") || source;
  // Visible copy is already tracked separately as usageText. This structural form
  // retains unknown tags/attributes while avoiding a duplicate copy of all text.
  const monitorStructure = canonicalMonitoredHtml(usageHtml, { includeText: false });
  return { usageHtml, monitorStructure, fingerprintSource: usageHtml };
}

export function parsePreparedDocsPage(prepared) {
  const usageText = textContent(prepared.usageHtml);
  const tables = extractHtmlTables(prepared.usageHtml);
  const requestTable = findTable(tables, ["model", "requests per 5 hour", "requests per week", "requests per month"]);
  const pricingTable = findTable(tables, ["model", "input", "output", "cached read", ["usage", "monthly limit", "monthly usage", "included usage"]]);

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
    monitorStructure: prepared.monitorStructure,
  };
}

export function parseDocsPage(html) {
  return parsePreparedDocsPage(prepareDocsPage(html));
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
      out[name] = { status: "chart_only", chart: chart.requests5h, docs: null, unlimited: Boolean(chart.unlimited) };
      continue;
    }
    if (Boolean(chart.unlimited) && Boolean(doc.unlimited)) {
      out[name] = { status: "match", chart: null, docs: null, unlimited: true };
      continue;
    }
    if (Boolean(chart.unlimited) !== Boolean(doc.unlimited)) {
      out[name] = { status: "mismatch", chart: chart.requests5h, docs: doc.requests5h, chartUnlimited: Boolean(chart.unlimited), docsUnlimited: Boolean(doc.unlimited) };
      continue;
    }
    if (chart.requests5h === doc.requests5h) {
      out[name] = { status: "match", chart: chart.requests5h, docs: doc.requests5h };
      continue;
    }
    let multiplier = parseBonusMultiplier(chart.bonus);
    if (!multiplier && bannerPromo && canonicalModelKey(bannerPromo.model) === canonicalModelKey(name)) multiplier = bannerPromo.multiplier;
    if (multiplier && Math.round(doc.requests5h * multiplier) === chart.requests5h) {
      out[name] = { status: "promotion", chart: chart.requests5h, docs: doc.requests5h, multiplier };
      continue;
    }
    out[name] = { status: "mismatch", chart: chart.requests5h, docs: doc.requests5h };
  }
  return out;
}
