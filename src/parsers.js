import { canonicalMonitoredHtml, extractHtmlTables, extractSectionHtml, normalizeSpace, textContent } from "./html.js";

const MONEY = /^\$\s*([\d.]+)$/;
const INTEGER = /^-?\d+$/;
const UNLIMITED = /^(?:∞|infinity|unlimited)$/i;
const EMPTY_LIMIT = /^(?:-|—|–)$/;
const LIMIT_STATES = new Set(["finite", "unlimited", "unknown"]);
const REQUEST_PROMO_SUFFIX_RE = /\s+(\d+(?:\.\d+)?)\s*[x×]\s*(?:usage\s*)?(?:(?:[·•|—–-])\s*)?((?:ends?|until|through|expires?)\b.+|limited\s+time\b.*)$/i;
const PROFILE_RE = /^([^\n]+?)\s*[—–-]\s*([\d,]+)\s+input,\s*([\d,]+)\s+cached,\s*([\d,]+)\s+output\s+tokens\s+per\s+request\s*$/gim;
const ITEM_START_RE = /<span\b[^>]*\bdata-item(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>/gi;
const MODEL_ROW_START_RE = /<div\b(?=[^>]*\bdata-slot\s*=\s*(?:"model-row"|'model-row'|model-row))[^>]*>/gi;
const VALUE_RE = /<span\b[^>]*\bdata-value(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>/i;
const NAME_RE = /<span\b[^>]*\bdata-name(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>/i;
const BONUS_RE = /<span\b[^>]*\bdata-bonus(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/span>/i;
const MODEL_CELL_RE = /<div\b(?=[^>]*\bdata-slot\s*=\s*(?:"model"|'model'|model))[^>]*>([\s\S]*?)<\/div>/i;
const REQUESTS_CELL_RE = /<div\b(?=[^>]*\bdata-slot\s*=\s*(?:"requests"|'requests'|requests))[^>]*>([\s\S]*?)<\/div>/i;
const ALLOWANCE_CELL_RE = /<div\b(?=[^>]*\bdata-slot\s*=\s*(?:"allowance"|'allowance'|allowance))[^>]*>([\s\S]*?)<\/div>/i;
const STRIKE_RE = /<s\b[^>]*>([\s\S]*?)<\/s>/i;
const BDI_RE = /<bdi\b[^>]*>([\s\S]*?)<\/bdi>/gi;
const BADGE_RE = /<span\b(?=[^>]*\bdata-slot\s*=\s*(?:"badge"|'badge'|badge))[^>]*>([\s\S]*?)<\/span>/gi;
const ANCHOR_TAG_RE = /<a\b[^>]*>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
const CURRENT_REGION_SLOT_RE = /\bdata-slot\s*=\s*(?:"region"|'region'|region)(?:\s|>|$)/i;
const LEGACY_REGION_MARKER_RE = /\bdata-regions(?:\s|=|>|$)/i;
const GRAPH_MARKER_RE = /\bdata-component\s*=\s*["'](?:limit-graph|go-usage|go-plan-chart)["']/i;
const PLAN_CHART_ROW_RE = /<tr\b[^>]*>\s*<th\b(?=[^>]*\bscope\s*=\s*["']row["'])[^>]*>[\s\S]*?<\/tr>/gi;
const PLAN_NUMBER_CELL_RE = /<td\b(?=[^>]*\bdata-slot\s*=\s*["']number["'])[^>]*>([\s\S]*?)<\/td>/gi;
const PLAN_SCALAR_RE = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
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

function parseEffectiveMoney(value) {
  const exact = parseMoney(value);
  if (exact != null) return exact;
  const source = compactScalar(value);
  const matches = [...source.matchAll(/\$\s*([\d,.]+)/g)];
  if (!matches.length) return null;
  const parsed = Number(matches.at(-1)[1].replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRequestLimit(value) {
  const source = compactScalar(value);
  if (UNLIMITED.test(source)) return { kind: "unlimited", value: null };
  if (!source || EMPTY_LIMIT.test(source)) return { kind: "empty", value: null };
  const parsed = parseInteger(source);
  if (parsed != null) return { kind: "finite", value: parsed };
  // Promotional docs cells can contain a struck-through baseline followed by the
  // effective request count. After HTML text extraction that becomes two numeric
  // tokens (for example "6,500 26,000"). Accept only an all-numeric sequence and
  // use the final value, matching the rendered effective value without guessing
  // from arbitrary prose.
  if (/^[\d,]+(?:\s+[\d,]+)+$/.test(source)) {
    const effective = parseInteger(source.split(/\s+/).at(-1));
    if (effective != null) return { kind: "finite", value: effective };
  }
  return { kind: "invalid", value: null, raw: source };
}

/**
 * Semantic allowance state with backward compatibility for stored snapshots that
 * predate the explicit state field. New parsers always emit limitState directly.
 */
export function limitStateOf(row) {
  if (LIMIT_STATES.has(row?.limitState)) return row.limitState;
  if (row?.unlimited === true) return "unlimited";
  if ([row?.requests5h, row?.requestsWeek, row?.requestsMonth].some((value) => Number.isFinite(value))) return "finite";
  return "unknown";
}

function hasExplicitUnlimitedEvidence(row, source) {
  if (limitStateOf(row) !== "unlimited") return false;
  if (source === "chart") return ["chart_data_infinite", "chart_explicit_text", "chart_marker_and_text"].includes(row?.limitEvidence);
  if (source === "docs") return row?.limitEvidence === "docs_explicit_unlimited";
  return false;
}

/**
 * Combine chart/docs evidence without allowing one source to silently erase a
 * contradiction in the other. "quota_exempt" means the public Go allowance
 * surface explicitly establishes exemption; it is deliberately not synonymous
 * with free service or absence of a separate provider/API rate limit.
 */
export function assessGoAllowanceState(chart, doc) {
  const chartPresent = Boolean(chart);
  const docsPresent = Boolean(doc);
  const rawChartState = chartPresent ? limitStateOf(chart) : "absent";
  const rawDocsState = docsPresent ? limitStateOf(doc) : "absent";
  // Legacy snapshots only carried a boolean and may have derived it from weak
  // evidence such as three dashes. Never let that historical boolean satisfy the
  // modern explicit-evidence gate.
  const chartState = rawChartState === "unlimited" && !hasExplicitUnlimitedEvidence(chart, "chart") ? "unknown" : rawChartState;
  const docsState = rawDocsState === "unlimited" && !hasExplicitUnlimitedEvidence(doc, "docs") ? "unknown" : rawDocsState;
  const evidence = [chart?.limitEvidence, doc?.limitEvidence].filter(Boolean);

  if (chartState === "unlimited" && docsState === "finite" || chartState === "finite" && docsState === "unlimited") {
    return { state: "conflict", confidence: "low", chartState, docsState, evidence };
  }
  if (chartState === "unlimited" && docsState === "unlimited") {
    return { state: "quota_exempt", confidence: "high", chartState, docsState, evidence };
  }
  if (chartState === "unlimited" || docsState === "unlimited") {
    return { state: "quota_exempt", confidence: "medium", chartState, docsState, evidence };
  }
  if (chartState === "finite" && docsState === "finite") {
    return { state: "finite", confidence: "high", chartState, docsState, evidence };
  }
  if (chartState === "finite" || docsState === "finite") {
    return { state: "finite", confidence: "medium", chartState, docsState, evidence };
  }
  return { state: "unknown", confidence: "low", chartState, docsState, evidence };
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
    const promotion = parseRequestPromotion(row[model]);
    const name = promotion.name;
    if (!name) continue;
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      throw new Error(`Docs request table contains duplicate stable model identity ${JSON.stringify(name)} after promotion normalization`);
    }
    const five = parseRequestLimit(row[fiveHour]);
    const week = parseRequestLimit(row[weekly]);
    const month = parseRequestLimit(row[monthly]);
    const cells = [five, week, month];
    const invalid = cells.find((cell) => cell.kind === "invalid");
    if (invalid) throw new Error(`Docs request row ${JSON.stringify(name)} contains an unrecognized limit value: ${JSON.stringify(invalid.raw)}`);

    const finiteCount = cells.filter((cell) => cell.kind === "finite").length;
    const unlimitedCount = cells.filter((cell) => cell.kind === "unlimited").length;
    const emptyCount = cells.filter((cell) => cell.kind === "empty").length;

    if (finiteCount === 3) {
      out[name] = {
        requests5h: five.value,
        requestsWeek: week.value,
        requestsMonth: month.value,
        promotionMultiplier: promotion.multiplier,
        promotionTiming: promotion.timing,
        limitState: "finite",
        limitEvidence: "docs_numeric",
        unlimited: false,
      };
      continue;
    }

    // An explicit infinity/unlimited token is strong semantic evidence, but only
    // when the other windows do not contradict it with finite values. Empty cells
    // may accompany that explicit signal in historical representations.
    if (unlimitedCount > 0 && finiteCount === 0 && unlimitedCount + emptyCount === 3) {
      out[name] = {
        requests5h: null,
        requestsWeek: null,
        requestsMonth: null,
        promotionMultiplier: promotion.multiplier,
        promotionTiming: promotion.timing,
        limitState: "unlimited",
        limitEvidence: "docs_explicit_unlimited",
        unlimited: true,
      };
      continue;
    }

    // Three dashes/blanks are absence of numeric evidence, not proof of infinity.
    // Preserve the model as unknown so a historical/future empty row cannot be
    // upgraded into "unlimited" merely because parsing lost all three numbers.
    if (emptyCount === 3) {
      out[name] = {
        requests5h: null,
        requestsWeek: null,
        requestsMonth: null,
        promotionMultiplier: promotion.multiplier,
        promotionTiming: promotion.timing,
        limitState: "unknown",
        limitEvidence: "docs_empty_row",
        unlimited: false,
      };
      continue;
    }

    throw new Error(`Docs request row ${JSON.stringify(name)} mixes finite, unlimited, and/or empty limit states; refusing to infer a quota mode`);
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
      // Monthly-limit cells may show a struck baseline, effective dollar value,
      // and promotion annotation. The last currency token is the rendered value.
      usageUsd: parseEffectiveMoney(row[usage]),
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
  return normalizeRequestModelName(value)
    .replace(/\([^)]*\)\s*$/g, "")
    .replace(/\bcode\b\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Strip a temporary promotion annotation from a request-table model label without
 * changing the stable model entity. OpenCode currently renders annotations through
 * nested <small> markup which table text extraction intentionally flattens.
 *
 * The rule is structural/semantic rather than model-specific: a multiplier only
 * becomes decoration when it is followed by an explicit finite promotion marker.
 * Names such as "Model 4x Large" therefore remain untouched.
 */
export function normalizeRequestModelName(value) {
  return parseRequestPromotion(value).name;
}

/**
 * Parse temporary request-table promotion decoration without folding it into the
 * stable model identity. The semantic timing text is retained so a deadline move
 * such as "Ends Sep 20" → "Ends Sep 27" becomes a promotion update rather than a
 * remove/add pair or generic prose churn.
 */
export function parseRequestPromotion(value) {
  const source = normalizeSpace(value);
  const match = REQUEST_PROMO_SUFFIX_RE.exec(source);
  if (!match) return { name: source, multiplier: null, timing: null };
  const multiplier = Number(match[1]);
  return {
    name: source.slice(0, match.index).trim(),
    multiplier: Number.isFinite(multiplier) ? multiplier : null,
    timing: normalizeSpace(match[2]),
  };
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

function strikeScalar(fragment, parser) {
  const struck = STRIKE_RE.exec(String(fragment ?? ""));
  return struck ? parser(textContent(struck[1])) : null;
}

function lastBdiScalar(fragment, parser) {
  BDI_RE.lastIndex = 0;
  let value = null;
  let match;
  while ((match = BDI_RE.exec(String(fragment ?? ""))) !== null) {
    const parsed = parser(textContent(match[1]));
    if (parsed != null) value = parsed;
  }
  return value;
}

function regionUrl(fragment) {
  const source = String(fragment ?? "");
  ANCHOR_TAG_RE.lastIndex = 0;
  let anchor;
  while ((anchor = ANCHOR_TAG_RE.exec(source)) !== null) {
    if (!CURRENT_REGION_SLOT_RE.test(anchor[0]) && !LEGACY_REGION_MARKER_RE.test(anchor[0])) continue;
    const href = HREF_RE.exec(anchor[0]);
    if (href) return normalizeSpace(href[1] ?? href[2] ?? href[3]);
  }
  // The Go/Go Plus comparison puts the policy link inside the model's label
  // cell without the historical data-slot/data-regions marker. The link text
  // must itself establish the semantic role; do not capture unrelated links.
  const policy = /<a\b([^>]*)>\s*limited\s+regions\s*<\/a>/i.exec(source);
  if (policy) {
    const href = HREF_RE.exec(policy[1]);
    if (href) return normalizeSpace(href[1] ?? href[2] ?? href[3]);
  }
  // Historical markup put data-regions on a wrapper and the href on its child.
  if (LEGACY_REGION_MARKER_RE.test(source)) {
    const href = HREF_RE.exec(source);
    if (href) return normalizeSpace(href[1] ?? href[2] ?? href[3]);
  }
  return null;
}

function chartRow({ requests5h, bonus = null, limitState, limitEvidence, baseRequests5h = null, monthlyAllowanceUsd = null, baseMonthlyAllowanceUsd = null, region = null }) {
  const state = limitState ?? (Number.isFinite(requests5h) ? "finite" : "unknown");
  return {
    requests5h,
    baseRequests5h,
    monthlyAllowanceUsd,
    baseMonthlyAllowanceUsd,
    bonus,
    regionUrl: region,
    limitState: state,
    limitEvidence: limitEvidence ?? (state === "finite" ? "chart_numeric" : null),
    unlimited: state === "unlimited",
  };
}

function chartLimitState({ tag = "", valueText = "", parsedValue = null, context = "Go chart row" }) {
  const marker = /\bdata-infinite(?:\s|=|>)/i.test(tag);
  const explicitText = UNLIMITED.test(compactScalar(valueText));
  if ((marker || explicitText) && parsedValue != null) {
    throw new Error(`${context} contains both explicit unlimited evidence and a finite request value`);
  }
  if (marker || explicitText) {
    return {
      limitState: "unlimited",
      limitEvidence: marker && explicitText ? "chart_marker_and_text" : marker ? "chart_data_infinite" : "chart_explicit_text",
    };
  }
  if (parsedValue != null) return { limitState: "finite", limitEvidence: "chart_numeric" };
  return { limitState: "unknown", limitEvidence: "chart_unparsed" };
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
  PLAN_CHART_ROW_RE.lastIndex = 0;
  while ((match = PLAN_CHART_ROW_RE.exec(chartHtml)) !== null) starts.push({ index: match.index, tagName: "tr" });
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

  // Go/Go Plus comparison tables are explicitly two-tier. The first scalar
  // belongs to Go and the second to Go Plus, matching the named legend and
  // ordered lanes. Never flatten both numbers into one value or infer that a
  // visually empty/dash cell means unlimited.
  if (/\bdata-component\s*=\s*["']go-plan-chart["']/i.test(prepared.chartHtml)) {
    if (!/\bdata-tier\s*=\s*["']go["']/i.test(prepared.chartHtml) || !/\bdata-tier\s*=\s*["']plus["']/i.test(prepared.chartHtml)) {
      throw new Error("Go plan chart lacks explicit Go and Go Plus tier evidence");
    }
    PLAN_CHART_ROW_RE.lastIndex = 0;
    let match;
    while ((match = PLAN_CHART_ROW_RE.exec(prepared.chartHtml)) !== null) {
      const segment = match[0];
      const modelCell = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(segment)?.[1] ?? "";
      BDI_RE.lastIndex = 0;
      const name = normalizeSpace(textContent(BDI_RE.exec(modelCell)?.[1] ?? ""));
      if (!name) throw new Error("Go plan chart has a row with no model name");

      PLAN_NUMBER_CELL_RE.lastIndex = 0;
      const cells = [...segment.matchAll(PLAN_NUMBER_CELL_RE)].map((cell) => {
        PLAN_SCALAR_RE.lastIndex = 0;
        return [...cell[1].matchAll(PLAN_SCALAR_RE)].map((value) => normalizeSpace(textContent(value[1])));
      });
      if (cells.length !== 2 || cells.some((values) => values.length !== 2)) {
        throw new Error(`Go plan chart row ${JSON.stringify(name)} lacks two paired numeric cells`);
      }
      const [goRequests, plusRequests] = cells[0].map(parseRequestLimit);
      const [goAllowance, plusAllowance] = cells[1];
      if ([goRequests, plusRequests].some((value) => !["finite", "unlimited"].includes(value.kind))) {
        throw new Error(`Go plan chart row ${JSON.stringify(name)} has an invalid or unknown quota state`);
      }
      const allowances = [goAllowance, plusAllowance].map((value) => UNLIMITED.test(value) ? null : parseMoney(value));
      if ([goAllowance, plusAllowance].some((value, index) => !UNLIMITED.test(value) && allowances[index] == null)) {
        throw new Error(`Go plan chart row ${JSON.stringify(name)} has an invalid monthly allowance`);
      }
      if ([goRequests, plusRequests].some((value, index) => (value.kind === "unlimited") !== UNLIMITED.test(cells[1][index]))) {
        throw new Error(`Go plan chart row ${JSON.stringify(name)} has conflicting request and monthly allowance states`);
      }
      if (Object.hasOwn(chart, name)) throw new Error(`Go plan chart has duplicate model ${JSON.stringify(name)}`);
      chart[name] = {
        ...chartRow({
          requests5h: goRequests.value,
          monthlyAllowanceUsd: allowances[0],
          region: regionUrl(modelCell),
          limitState: goRequests.kind,
          limitEvidence: goRequests.kind === "unlimited" ? "chart_explicit_text" : "chart_numeric",
        }),
        plusRequests5h: plusRequests.value,
        plusMonthlyAllowanceUsd: allowances[1],
        plusLimitState: plusRequests.kind,
        plusLimitEvidence: plusRequests.kind === "unlimited" ? "chart_explicit_text" : "chart_numeric",
      };
    }
    if (!Object.keys(chart).length) throw new Error("Go plan chart has no model rows");
    return { chart, promoBanner: prepared.promoBanner, monitorStructure: prepared.monitorStructure };
  }

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
    const requests5h = lastBdiScalar(requestsCell, parseInteger);
    const baseRequests5h = strikeScalar(requestsCell, parseInteger);
    const requestText = textContent(requestsCell);
    const limit = chartLimitState({ tag: modelRows[i].tag, valueText: requestText, parsedValue: requests5h, context: `Go chart row ${JSON.stringify(name || "unknown")}` });

    const allowanceCell = ALLOWANCE_CELL_RE.exec(segment)?.[1] ?? "";
    const monthlyAllowanceUsd = lastBdiScalar(allowanceCell, parseMoney);
    const baseMonthlyAllowanceUsd = strikeScalar(allowanceCell, parseMoney);

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
    if (name && limit.limitState === "unknown") throw new Error(`Go chart row ${JSON.stringify(name)} has no parseable finite or explicit unlimited request state`);
    if (name) {
      chart[name] = chartRow({
        requests5h: limit.limitState === "unlimited" ? null : requests5h,
        baseRequests5h,
        monthlyAllowanceUsd,
        baseMonthlyAllowanceUsd,
        bonus,
        region: regionUrl(modelCell),
        ...limit,
      });
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
    const parsedRequests = parseInteger(valueText);
    const limit = chartLimitState({ tag: starts[i].tag, valueText, parsedValue: parsedRequests, context: `Legacy Go chart row ${JSON.stringify(textContent(nameMatch[1]))}` });
    const requests5h = limit.limitState === "unlimited" ? null : parsedRequests;
    const normalized = normalizeChartName(textContent(nameMatch[1]), bonusMatch ? textContent(bonusMatch[1]) : null);
    if (normalized.name && limit.limitState === "unknown") throw new Error(`Legacy Go chart row ${JSON.stringify(normalized.name)} has no parseable finite or explicit unlimited request state`);
    if (normalized.name) {
      chart[normalized.name] = chartRow({ requests5h, bonus: normalized.bonus, region: regionUrl(segment), ...limit });
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
      const parsedRequests = parseInteger(row[1]);
      const limit = chartLimitState({ valueText: row[1], parsedValue: parsedRequests, context: `Text-fallback Go chart row ${JSON.stringify(row[2])}` });
      const requests5h = limit.limitState === "unlimited" ? null : parsedRequests;
      const normalized = normalizeChartName(row[2], null);
      if (normalized.name && limit.limitState !== "unknown") chart[normalized.name] = chartRow({ requests5h, bonus: normalized.bonus, ...limit });
    }
    const bonusMatch = /([\d,]+)\s+([A-Z][A-Za-z0-9.-]*(?:\s+[A-Za-z0-9.-]+){0,8})\s+(\d+(?:\.\d+)?[x×]\s+usage)/i.exec(region);
    if (bonusMatch) {
      const requests5h = parseInteger(bonusMatch[1]);
      const normalized = normalizeChartName(bonusMatch[2], bonusMatch[3]);
      if (requests5h != null) chart[normalized.name] = chartRow({ requests5h, bonus: normalized.bonus, limitState: "finite", limitEvidence: "chart_numeric" });
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
  const allRequestTables = tables.filter((rows) => rows[0] && headerIndex(rows[0], "model") >= 0 && headerIndex(rows[0], "requests per 5 hour") >= 0 && headerIndex(rows[0], "requests per week") >= 0 && headerIndex(rows[0], "requests per month") >= 0);
  const allPricingTables = tables.filter((rows) => rows[0] && headerIndex(rows[0], "model") >= 0 && headerIndex(rows[0], "input") >= 0 && headerIndex(rows[0], "output") >= 0 && headerIndex(rows[0], "cached read") >= 0 && headerIndex(rows[0], ["usage", "monthly limit", "monthly usage", "included usage"]) >= 0);

  if (!requestTable) throw new Error("Docs parser could not find request-count table");
  if (!pricingTable) throw new Error("Docs parser could not find pricing table");

  const limits = parseLimits(usageText);
  const requests = rowsToRequestMap(requestTable);
  const pricing = rowsToPricingMap(pricingTable);
  // The docs render both tab bodies into SSR. Preserve the independently
  // published Go Plus allowances instead of silently discarding the second
  // table. Historical single-plan documents keep the fields absent.
  const requestsPlus = allRequestTables.length >= 2 ? rowsToRequestMap(allRequestTables[1]) : null;
  const pricingPlus = allPricingTables.length >= 2 ? rowsToPricingMap(allPricingTables[1]) : null;
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
    ...(requestsPlus ? { requestsPlus } : {}),
    ...(pricingPlus ? { pricingPlus } : {}),
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
      out[name] = { status: "chart_only", chart: chart.requests5h, docs: null, chartLimitState: limitStateOf(chart) };
      continue;
    }
    const allowance = assessGoAllowanceState(chart, doc);
    if (allowance.state === "conflict") {
      out[name] = { status: "mismatch", chart: chart.requests5h, docs: doc.requests5h, chartLimitState: allowance.chartState, docsLimitState: allowance.docsState };
      continue;
    }
    if (allowance.state === "quota_exempt") {
      if (allowance.confidence === "high") out[name] = { status: "match", chart: null, docs: null, limitState: "unlimited" };
      else out[name] = { status: "uncertain", chart: chart.requests5h, docs: doc.requests5h, chartLimitState: allowance.chartState, docsLimitState: allowance.docsState };
      continue;
    }
    if (allowance.state === "unknown" || allowance.chartState === "unknown" || allowance.docsState === "unknown") {
      out[name] = { status: "uncertain", chart: chart.requests5h, docs: doc.requests5h, chartLimitState: allowance.chartState, docsLimitState: allowance.docsState };
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
