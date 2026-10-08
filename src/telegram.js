import { assessGoAllowanceState, canonicalModelKey, deriveConsistency, limitStateOf } from "./parsers.js";
import { basePricingName, buildGoUsageYieldRanking, usageYieldFor } from "./usage-yield.js";

const MAX_MESSAGE = 3850;
const CHAT_ID_KEY = "telegram:chat_id:v1";
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const YIELD_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COST_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
const TIME_FORMATTERS = new Map();
const LABELS = Object.freeze({
  fiveHourUsd: "5 hour",
  weeklyUsd: "Weekly",
  monthlyUsd: "Monthly",
  requests5h: "5 hour",
  requestsWeek: "Weekly",
  requestsMonth: "Monthly",
  promotionMultiplier: "Promo multiplier",
  promotionTiming: "Promo timing",
  inputTokens: "Input/request",
  cachedTokens: "Cached/request",
  outputTokens: "Output/request",
  inputPerM: "Input / 1M",
  outputPerM: "Output / 1M",
  cachedReadPerM: "Cached read / 1M",
  cachedWritePerM: "Cached write / 1M",
  usageUsd: "Included usage",
  baseRequests5h: "Promo base · 5 hour",
  monthlyAllowanceUsd: "Monthly usage",
  baseMonthlyAllowanceUsd: "Promo base · monthly",
  regionUrl: "Region policy",
  bonus: "Promotion",
  chartId: "Chart ID",
  limitState: "Go allowance state",
  plusRequests5h: "Go Plus · 5 hour",
  plusMonthlyAllowanceUsd: "Go Plus · monthly",
  plusLimitState: "Go Plus allowance state",
  deepSeekPeakHours: "DeepSeek peak hours",
  limitsDisclaimer: "Limits disclaimer",
});

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

function fmtNumber(value) {
  return typeof value === "number" ? NUMBER_FORMATTER.format(value) : "—";
}
function fmtMoney(value) { return typeof value === "number" ? `$${NUMBER_FORMATTER.format(value)}` : "—"; }
function fmtCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.00000001) return `$${value.toExponential(2)}`;
  return `$${COST_FORMATTER.format(value)}`;
}
function fmtYield(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return YIELD_FORMATTER.format(value);
}
function fmtPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}
function direction(before, after) {
  if (typeof before === "number" && typeof after === "number") return after > before ? "▲" : after < before ? "▼" : "→";
  return "→";
}
function labelField(field) { return LABELS[field] ?? field; }
function limitMode(value) {
  if (value === "unlimited") return "explicit ∞ / quota-exempt";
  if (value === "unknown") return "unknown / not inferred";
  if (value === "finite") return "metered";
  return "unknown";
}
function evidencedState(row, source) {
  return source === "docs"
    ? assessGoAllowanceState(null, row).docsState
    : assessGoAllowanceState(row, null).chartState;
}
function fmtRequest(row, field = "requests5h", source = "chart") {
  const state = evidencedState(row, source);
  return state === "unlimited" ? "∞" : state === "unknown" ? "unknown" : fmtNumber(row?.[field]);
}

function formatTime(iso, timeZone) {
  try {
    let formatter = TIME_FORMATTERS.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
      TIME_FORMATTERS.set(timeZone, formatter);
    }
    return formatter.format(new Date(iso));
  } catch { return iso; }
}

function requestGrid(row, plan = "Go") {
  if (!row) return "";
  const state = evidencedState(row, "docs");
  if (state === "unlimited") {
    return `<pre>${plan} quota  ∞</pre>\n<i>An explicit source signal marks the ${plan} allowance as quota-exempt. This does not establish free service or unrestricted provider/API access.</i>`;
  }
  if (state === "unknown") {
    return `<pre>${plan} quota  unknown</pre>\n<i>No numeric or explicit ∞ evidence is published here; the watcher refuses to infer quota exemption.</i>`;
  }
  const cells = [["5 hour", fmtNumber(row.requests5h)], ["week", fmtNumber(row.requestsWeek)], ["month", fmtNumber(row.requestsMonth)]];
  const width = Math.max(...cells.map(([, value]) => value.length));
  return `<pre>${cells.map(([label, value]) => `${label.padEnd(6)} ${value.padStart(width)}`).join("\n")}</pre>`;
}

function profileLine(profile) {
  if (!profile) return "";
  return `🧠 <b>Observed request profile</b>  in <code>${fmtNumber(profile.inputTokens)}</code> · cached <code>${fmtNumber(profile.cachedTokens)}</code> · out <code>${fmtNumber(profile.outputTokens)}</code>`;
}
function pricingForModel(snapshot, model) {
  const wanted = canonicalModelKey(model);
  return Object.entries(snapshot.docs.pricing ?? {}).filter(([name]) => canonicalModelKey(basePricingName(name)) === wanted);
}
function chartForModel(snapshot, model) {
  const wanted = canonicalModelKey(model);
  return Object.entries(snapshot.go.chart ?? {}).find(([name]) => canonicalModelKey(name) === wanted)?.[1] ?? null;
}
function pricingSummary(rows, maxRows = 3) {
  if (!rows.length) return "";
  const shown = rows.slice(0, maxRows).map(([name, row]) => {
    const variant = name.replace(basePricingName(name), "").trim();
    const suffix = variant ? ` ${escapeHtml(variant)}` : "";
    return `•${suffix} in <code>${fmtMoney(row.inputPerM)}</code> · cache <code>${fmtMoney(row.cachedReadPerM)}</code> · out <code>${fmtMoney(row.outputPerM)}</code> · usage <code>${fmtMoney(row.usageUsd)}</code>`;
  });
  if (rows.length > maxRows) shown.push(`• …and ${rows.length - maxRows} more pricing row${rows.length - maxRows === 1 ? "" : "s"}`);
  return `💰 <b>Pricing / 1M tokens</b>\n${shown.join("\n")}`;
}
function paidRankLabel(entry) {
  const tie = entry.tieCount > 1 ? ` · ${entry.tieCount}-way tie` : "";
  return `#${entry.rank} of ${entry.total} paid${tie}`;
}
function calibrationLine(ranking) {
  const count = ranking?.calibration?.stats?.uniqueWorkloads;
  return count ? `<i>V2 normalizes every paid model against the same ${count}-shape OpenCode agent workload corpus.</i>` : "";
}
function goUsageValueLine(ranking, model) {
  const entry = usageYieldFor(ranking, model);
  if (!entry || entry.class === "unranked") return `💸 <b>Usage value</b>  <i>pending standardized pricing/workload evidence</i>`;
  if (entry.class === "quota-exempt") return `💸 <b>Usage value</b>  <b>Go quota-exempt</b>\n<i>Explicit ∞/quota evidence is not treated as proof of free service or unrestricted provider/API capacity.</i>`;
  const monthly = entry.goCapacity?.monthlyEquivalentRequests;
  const best = typeof entry.fractionOfBest === "number" ? `${(entry.fractionOfBest * 100).toFixed(0)}% of best` : "";
  const core = [
    `💸 <b>Usage value</b>  <code>${paidRankLabel(entry)}</code>`,
    `~<b>${fmtYield(monthly)}</b> standardized requests / Go monthly allowance`,
    `~<b>${fmtYield(entry.requestsPerDollar)}</b> equivalent req/$ · ${best} · ${fmtCost(entry.costPerEquivalentRequest)} / standardized request`,
  ];
  if (entry.regimes?.time) {
    core.push(`<i>Off-peak ~${fmtYield(entry.regimes.time.offPeakRequestsPerDollar)} req/$ · Peak ~${fmtYield(entry.regimes.time.peakRequestsPerDollar)} req/$ · peak usage ${fmtPercent(entry.regimes.time.peakUsagePenaltyPercent)}</i>`);
  } else if (entry.variantCount > 1) {
    core.push(`<i>${entry.variantCount} pricing variants are applied by workload/context semantics; rank is not based on the cheapest row.</i>`);
  }
  if (entry.confidence !== "high") core.push(`<i>Evidence confidence: ${escapeHtml(entry.confidence)}</i>`);
  return core.filter(Boolean).join("\n");
}
function related(change, model) {
  const wanted = canonicalModelKey(model);
  if (!change.key) return false;
  return canonicalModelKey(basePricingName(change.key)) === wanted || canonicalModelKey(change.key) === wanted;
}

function renderModelAdded(change, snapshot, ranking) {
  const model = change.key;
  const chart = chartForModel(snapshot, model);
  const pricing = pricingForModel(snapshot, model);
  const allowance = assessGoAllowanceState(chart, change.after);
  const corroboratedQuotaExempt = allowance.state === "quota_exempt" && allowance.confidence === "high";
  const parts = [
    corroboratedQuotaExempt ? `♾️ <b>GO QUOTA-EXEMPT MODEL ADDED</b>` : `🆕 <b>MODEL ADDED</b>`,
    `<b>${escapeHtml(model)}</b>`,
    goUsageValueLine(ranking, model),
    calibrationLine(ranking),
    requestGrid(change.after),
  ];
  if (chart) parts.push(`📈 <b>Go chart</b>  <code>${fmtRequest(chart)}</code> / 5h${typeof chart.monthlyAllowanceUsd === "number" ? `  ·  <code>${fmtMoney(chart.monthlyAllowanceUsd)}</code> monthly` : ""}${chart.bonus ? `  ·  🎁 ${escapeHtml(chart.bonus)}` : ""}${chart.regionUrl ? `\n🌍 Region policy: <code>${escapeHtml(chart.regionUrl)}</code>` : ""}`);
  const profile = snapshot.docs.profiles?.[model];
  if (profile) parts.push(profileLine(profile));
  if (pricing.length) parts.push(pricingSummary(pricing));
  return parts.filter(Boolean).join("\n");
}

function renderModelRemoved(change, relatedChanges) {
  const pricingRemoved = relatedChanges.filter((item) => item.type === "pricing_row_removed");
  const state = evidencedState(change.before, "docs");
  return [
    state === "unlimited" ? `♾️ <b>GO QUOTA-EXEMPT MODEL REMOVED</b>` : `🗑 <b>MODEL REMOVED</b>`,
    `<b>${escapeHtml(change.key)}</b>`,
    `<i>Previous request estimates</i>`, requestGrid(change.before),
    pricingRemoved.length ? `💰 ${pricingRemoved.length} associated pricing row${pricingRemoved.length === 1 ? "" : "s"} removed` : "",
  ].filter(Boolean).join("\n");
}

function renderRequestChanges(model, changes, ranking) {
  const lines = changes.map((change) => {
    const label = `${change.plan === "Go Plus" ? "Go Plus · " : ""}${labelField(change.field)}`;
    if (change.field === "limitState") return `${label}: <code>${limitMode(change.before)} → ${limitMode(change.after)}</code>`;
    const pct = fmtPercent(change.percent);
    return `${label.padEnd(8)} <code>${fmtNumber(change.before)} → ${fmtNumber(change.after)}</code>  ${direction(change.before, change.after)}${pct ? ` ${pct}` : ""}`;
  });
  const modeChange = changes.some((change) => change.field === "limitState");
  return `${modeChange ? "⚖️ <b>GO ALLOWANCE STATE CHANGED</b>" : "📊 <b>REQUEST LIMIT CHANGED</b>"}\n<b>${escapeHtml(model)}</b>\n${goUsageValueLine(ranking, model)}\n${lines.join("\n")}`;
}
function renderPromotionChanges(model, changes) {
  const lines = changes.map((change) => {
    if (change.field === "promotionMultiplier") return `${labelField(change.field)}: <code>${fmtNumber(change.before)}x → ${fmtNumber(change.after)}x</code>`;
    return `${labelField(change.field)}: <code>${escapeHtml(change.before ?? "none")} → ${escapeHtml(change.after ?? "none")}</code>`;
  });
  return `🎁 <b>PROMOTION WINDOW CHANGED</b>\n<b>${escapeHtml(model)}</b>\n${lines.join("\n")}`;
}
function renderPricingChanges(rowName, changes, ranking) {
  const lines = changes.map((change) => {
    const pct = fmtPercent(change.percent);
    return `${change.plan === "Go Plus" ? "Go Plus · " : ""}${labelField(change.field)}: <code>${fmtMoney(change.before)} → ${fmtMoney(change.after)}</code> ${direction(change.before, change.after)}${pct ? ` ${pct}` : ""}`;
  });
  return `💰 <b>PRICING CHANGED</b>\n<b>${escapeHtml(rowName)}</b>\n${goUsageValueLine(ranking, basePricingName(rowName))}\n${lines.join("\n")}`;
}
function renderProfileChanges(model, changes, ranking) {
  const lines = changes.map((change) => `${labelField(change.field)}: <code>${fmtNumber(change.before)} → ${fmtNumber(change.after)}</code> ${direction(change.before, change.after)} ${fmtPercent(change.percent)}`.trim());
  return `🧠 <b>REQUEST PROFILE CHANGED</b>\n<b>${escapeHtml(model)}</b>\n${goUsageValueLine(ranking, model)}\n${lines.join("\n")}\n📐 <i>The shared V2 workload corpus was recalculated; all paid Usage Value ranks are recomputed from the new corpus.</i>`;
}
function renderChartChanges(model, changes, ranking) {
  const onlyChartId = changes.every((change) => change.field === "chartId");
  const hasLimitState = changes.some((change) => change.field === "limitState" || change.field === "plusLimitState");
  const lines = changes.map((change) => {
    if (change.field === "bonus") return `Promotion: <code>${escapeHtml(change.before ?? "none")} → ${escapeHtml(change.after ?? "none")}</code>`;
    if (change.field === "chartId") return `Chart ID: <code>${escapeHtml(change.before ?? "none")} → ${escapeHtml(change.after ?? "none")}</code>`;
    if (change.field === "limitState" || change.field === "plusLimitState") return `${change.field === "plusLimitState" ? "Go Plus" : "Go"} allowance: <code>${limitMode(change.before)} → ${limitMode(change.after)}</code>`;
    if (change.field === "regionUrl") return `Region policy: <code>${escapeHtml(change.before ?? "none")} → ${escapeHtml(change.after ?? "none")}</code>`;
    const money = change.field === "monthlyAllowanceUsd" || change.field === "baseMonthlyAllowanceUsd" || change.field === "plusMonthlyAllowanceUsd";
    const format = money ? fmtMoney : fmtNumber;
    return `${labelField(change.field)}: <code>${format(change.before)} → ${format(change.after)}</code> ${direction(change.before, change.after)} ${fmtPercent(change.percent)}`.trim();
  });
  const title = onlyChartId ? "🪪 <b>GO CHART ID CHANGED</b>" : hasLimitState ? "⚖️ <b>GO ALLOWANCE STATE CHANGED</b>" : "📈 <b>GO CHART CHANGED</b>";
  return `${title}\n<b>${escapeHtml(model)}</b>${hasLimitState ? `\n${goUsageValueLine(ranking, model)}` : ""}\n${lines.join("\n")}`;
}
function groupByKey(changes, type) {
  const groups = new Map();
  changes.forEach((change, index) => { if (change.type !== type) return; if (!groups.has(change.key)) groups.set(change.key, []); groups.get(change.key).push({ ...change, __index: index }); });
  return groups;
}

function renderBlocks(changes, snapshot) {
  const consumed = new Set();
  const blocks = [];
  const ranking = buildGoUsageYieldRanking(snapshot);
  changes.forEach((change, index) => {
    if (change.type !== "model_added" && change.type !== "model_removed") return;
    consumed.add(index);
    const associated = [];
    changes.forEach((other, otherIndex) => {
      if (consumed.has(otherIndex) || otherIndex === index) return;
      const lifecycle = change.type === "model_added" ? ["request_profile_added", "pricing_row_added", "chart_model_added"] : ["request_profile_removed", "pricing_row_removed", "chart_model_removed"];
      if (lifecycle.includes(other.type) && related(other, change.key)) { associated.push(other); consumed.add(otherIndex); }
    });
    blocks.push(change.type === "model_added" ? renderModelAdded(change, snapshot, ranking) : renderModelRemoved(change, associated));
  });
  for (const [model, group] of groupByKey(changes, "request_limit_changed")) {
    const active = group.filter((item) => !consumed.has(item.__index)); if (!active.length) continue; active.forEach((item) => consumed.add(item.__index)); blocks.push(renderRequestChanges(model, active, ranking));
  }
  for (const [model, group] of groupByKey(changes, "request_promotion_changed")) {
    const active = group.filter((item) => !consumed.has(item.__index)); if (!active.length) continue; active.forEach((item) => consumed.add(item.__index)); blocks.push(renderPromotionChanges(model, active));
  }
  for (const [name, group] of groupByKey(changes, "pricing_changed")) {
    const active = group.filter((item) => !consumed.has(item.__index)); if (!active.length) continue; active.forEach((item) => consumed.add(item.__index)); blocks.push(renderPricingChanges(name, active, ranking));
  }
  for (const [model, group] of groupByKey(changes, "request_profile_changed")) {
    const active = group.filter((item) => !consumed.has(item.__index)); if (!active.length) continue; active.forEach((item) => consumed.add(item.__index)); blocks.push(renderProfileChanges(model, active, ranking));
  }
  for (const [model, group] of groupByKey(changes, "chart_changed")) {
    const active = group.filter((item) => !consumed.has(item.__index)); if (!active.length) continue; active.forEach((item) => consumed.add(item.__index)); blocks.push(renderChartChanges(model, active, ranking));
  }

  const global = changes.map((change, index) => ({ ...change, __index: index })).filter((item) => item.type === "global_limit_changed" && !consumed.has(item.__index));
  if (global.length) { global.forEach((item) => consumed.add(item.__index)); blocks.push(`💳 <b>USAGE WINDOW POLICY CHANGED</b>\n${global.map((item) => `${labelField(item.field)}: <code>${fmtMoney(item.before)} → ${fmtMoney(item.after)}</code> ${direction(item.before, item.after)} ${fmtPercent(item.percent)}`.trim()).join("\n")}\n<i>Values use the normalized $60 monthly reference; each model's actual monthly limit remains in its pricing row.</i>`); }

  changes.forEach((change, index) => {
    if (consumed.has(index)) return;
    consumed.add(index);
    switch (change.type) {
      case "request_profile_added": blocks.push(`🧠 <b>REQUEST PROFILE ADDED</b>\n<b>${escapeHtml(change.key)}</b>\n${goUsageValueLine(ranking, change.key)}\n${profileLine(change.after)}\n📐 <i>Shared V2 workload corpus recalibrated.</i>`); break;
      case "request_profile_removed": blocks.push(`🧠 <b>REQUEST PROFILE REMOVED</b>\n<b>${escapeHtml(change.key)}</b>\n${goUsageValueLine(ranking, change.key)}\n📐 <i>Shared V2 workload corpus recalibrated.</i>`); break;
      case "pricing_row_added": blocks.push(`💰 <b>PRICING ROW ADDED</b>\n<b>${escapeHtml(change.key)}</b>\n${goUsageValueLine(ranking, basePricingName(change.key))}\n${pricingSummary([[change.key, change.after]], 1)}`); break;
      case "pricing_row_removed": blocks.push(`🧹 <b>PRICING ROW REMOVED</b>\n<b>${escapeHtml(change.key)}</b>\n${goUsageValueLine(ranking, basePricingName(change.key))}`); break;
      case "go_plus_request_row_added": blocks.push(`📊 <b>GO PLUS REQUEST MODEL ADDED</b>\n<b>${escapeHtml(change.key)}</b>\n${requestGrid(change.after, "Go Plus")}`); break;
      case "go_plus_request_row_removed": blocks.push(`📊 <b>GO PLUS REQUEST MODEL REMOVED</b>\n<b>${escapeHtml(change.key)}</b>`); break;
      case "go_plus_pricing_row_added": blocks.push(`💰 <b>GO PLUS PRICING ROW ADDED</b>\n<b>${escapeHtml(change.key)}</b>\n${pricingSummary([[change.key, change.after]], 1)}`); break;
      case "go_plus_pricing_row_removed": blocks.push(`💰 <b>GO PLUS PRICING ROW REMOVED</b>\n<b>${escapeHtml(change.key)}</b>`); break;
      case "chart_model_added": {
        const state = evidencedState(change.after, "chart");
        blocks.push(`${state === "unlimited" ? "♾️ <b>GO CHART EXPLICIT ∞ MODEL ADDED</b>" : "🟢 <b>GO CHART MODEL ADDED</b>"}\n<b>${escapeHtml(change.key)}</b>\n${state === "unlimited" ? `${goUsageValueLine(ranking, change.key)}\n` : ""}<code>${fmtRequest(change.after)}</code> requests / 5h${typeof change.after?.monthlyAllowanceUsd === "number" ? ` · <code>${fmtMoney(change.after.monthlyAllowanceUsd)}</code> monthly` : ""}${state === "unlimited" ? "\n<i>The chart explicitly shows ∞; this is not treated as proof of free or unrestricted provider/API access.</i>" : ""}${change.after?.bonus ? `\n🎁 ${escapeHtml(change.after.bonus)}` : ""}${change.after?.regionUrl ? `\n🌍 <code>${escapeHtml(change.after.regionUrl)}</code>` : ""}`);
        break;
      }
      case "chart_model_removed": blocks.push(`${evidencedState(change.before, "chart") === "unlimited" ? "♾️ <b>GO CHART EXPLICIT ∞ MODEL REMOVED</b>" : "🔴 <b>GO CHART MODEL REMOVED</b>"}\n<b>${escapeHtml(change.key)}</b>\nwas <code>${fmtRequest(change.before)}</code> requests / 5h`); break;
      case "promo_banner_changed": blocks.push(`🎁 <b>PROMOTION BANNER CHANGED</b>\n<code>${escapeHtml(change.before ?? "none")}</code>\n↓\n<code>${escapeHtml(change.after ?? "none")}</code>`); break;
      case "consistency_mismatch": blocks.push(`⚠️ <b>CHART / DOCS MISMATCH</b>\n<b>${escapeHtml(change.key)}</b>\nchart <code>${change.after?.chartLimitState ? limitMode(change.after.chartLimitState) : fmtNumber(change.after?.chart)}</code> · docs <code>${change.after?.docsLimitState ? limitMode(change.after.docsLimitState) : fmtNumber(change.after?.docs)}</code>`); break;
      case "consistency_resolved": blocks.push(`✅ <b>CHART / DOCS MISMATCH RESOLVED</b>\n<b>${escapeHtml(change.key)}</b>`); break;
      case "usage_note_added": case "usage_note_removed": case "usage_note_changed": blocks.push(`🕒 <b>${escapeHtml(labelField(change.key))} changed</b>\n<code>${escapeHtml(change.before ?? "none")}</code>\n↓\n<code>${escapeHtml(change.after ?? "none")}</code>`); break;
      case "usage_copy_changed": blocks.push(`📝 <b>USAGE SECTION WORDING CHANGED</b>\n<b>Before</b> <code>${escapeHtml(change.before || "…")}</code>\n<b>After</b> <code>${escapeHtml(change.after || "…")}</code>`); break;
      case "unclassified_source_change": {
        const surface = change.source === "go" ? "Go usage chart" : "Usage docs";
        blocks.push([`🟡 <b>UNCLASSIFIED MONITORED CHANGE</b>`, `<b>${surface}</b>`, `The monitored surface changed, but all semantic fields the watcher currently knows about stayed the same.`, ``, `<b>Before</b> <code>${escapeHtml(change.before || "(nothing at this position)")}</code>`, `<b>After</b> <code>${escapeHtml(change.after || "(nothing at this position)")}</code>`].join("\n"));
        break;
      }
      default: blocks.push(`• <b>${escapeHtml(change.type)}</b>`);
    }
  });
  return blocks;
}

function headlineFor(changes) {
  const types = new Set(changes.map((change) => change.type));
  if (types.has("unclassified_source_change")) return "🟡 <b>OPENCODE GO · UNCLASSIFIED CHANGE</b>";
  if (types.has("request_promotion_changed")) return "🎁 <b>OPENCODE GO · PROMOTION UPDATE</b>";
  if (changes.some((change) => change.field === "limitState" || change.field === "plusLimitState")) return "⚖️ <b>OPENCODE GO · ALLOWANCE STATE UPDATE</b>";
  if (changes.length > 0 && changes.every((change) => change.type === "chart_changed" && change.field === "chartId")) return "🪪 <b>OPENCODE GO · CHART ID CHANGED</b>";
  if (changes.filter((change) => change.type === "model_added").length === 1 && types.size <= 4) return "🆕 <b>OPENCODE GO · NEW MODEL</b>";
  if (changes.filter((change) => change.type === "model_removed").length === 1 && types.size <= 4) return "🗑 <b>OPENCODE GO · MODEL REMOVED</b>";
  if ([...types].some((type) => type.includes("pricing"))) return "💰 <b>OPENCODE GO · PRICING UPDATE</b>";
  if ([...types].some((type) => type.includes("promo") || type === "chart_changed")) return "🎁 <b>OPENCODE GO · USAGE UPDATE</b>";
  return "🚨 <b>OPENCODE GO WATCH</b>";
}

export function buildChangeMessages(changes, snapshot, timeZone = "America/Chicago") {
  const blocks = renderBlocks(changes, snapshot);
  const header = `${headlineFor(changes)}\n━━━━━━━━━━━━━━━━━━━━\n<b>${changes.length}</b> semantic field change${changes.length === 1 ? "" : "s"} · <b>${blocks.length}</b> update card${blocks.length === 1 ? "" : "s"}`;
  const footer = `\n\n🕒 ${escapeHtml(formatTime(snapshot.checkedAt, timeZone))}\n🔎 Go chart + usage docs`;
  const messages = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}${footer}`;
    if (candidate.length > MAX_MESSAGE && current !== header) { messages.push(`${current}${footer}`); current = `↪️ <b>OPENCODE GO WATCH · continued</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${block}`; }
    else current += `\n\n${block}`;
  }
  messages.push(`${current}${footer}`);
  return messages;
}

export function buildBootMessage(snapshot, timeZone = "America/Chicago") {
  const modelCount = Object.keys(snapshot.docs.requests).length;
  const chartCount = Object.keys(snapshot.go.chart).length;
  const allowanceStates = Object.entries(snapshot.go.chart).map(([name, chart]) => ({
    name,
    allowance: assessGoAllowanceState(chart, snapshot.docs.requests?.[name]),
  }));
  const corroboratedQuotaExempt = allowanceStates.filter(({ allowance }) => allowance.state === "quota_exempt" && allowance.confidence === "high");
  const chartOnlyQuotaExempt = allowanceStates.filter(({ allowance }) => allowance.state === "quota_exempt" && allowance.confidence === "medium");
  const limits = snapshot.docs.limits;
  const consistency = deriveConsistency(snapshot.go, snapshot.docs);
  const mismatches = Object.values(consistency).filter((item) => item.status === "mismatch").length;
  const promos = Object.entries(consistency).filter(([, item]) => item.status === "promotion");
  const ranking = buildGoUsageYieldRanking(snapshot);
  const best = ranking.paidEntries[0];
  return [
    "🟢 <b>OPENCODE GO WATCH · ARMED</b>", "━━━━━━━━━━━━━━━━━━━━", "Baseline captured. Semantic monitoring is live.", "",
    `📚 <b>${modelCount}</b> usage-table models  ·  📈 <b>${chartCount}</b> chart models`,
    `<b>Window policy · $60 monthly reference</b>\n<pre>5 hour  ${fmtMoney(limits.fiveHourUsd)}\nweek    ${fmtMoney(limits.weeklyUsd)}\nmonth   ${fmtMoney(limits.monthlyUsd)}</pre>`,
    best ? `💸 <b>Best paid Usage Value</b>  ${escapeHtml(best.name)} · ~${fmtYield(best.goCapacity?.monthlyEquivalentRequests)} standardized requests / monthly Go allowance` : "",
    ranking.calibration?.stats?.uniqueWorkloads ? `📐 V2 calibration: <b>${ranking.calibration.stats.uniqueWorkloads}</b> unique OpenCode request shapes` : "",
    corroboratedQuotaExempt.length ? `♾️ <b>${corroboratedQuotaExempt.length}</b> corroborated Go quota-exempt model${corroboratedQuotaExempt.length === 1 ? "" : "s"}: ${corroboratedQuotaExempt.map(({ name }) => escapeHtml(name)).join(" · ")}` : "",
    chartOnlyQuotaExempt.length ? `ℹ️ <b>${chartOnlyQuotaExempt.length}</b> explicit ∞ state${chartOnlyQuotaExempt.length === 1 ? "" : "s"} awaiting cross-source corroboration: ${chartOnlyQuotaExempt.map(({ name }) => escapeHtml(name)).join(" · ")}` : "",
    corroboratedQuotaExempt.length || chartOnlyQuotaExempt.length ? `<i>Quota-exempt Go allowance evidence is never reported as proof of free service or unrestricted provider/API capacity.</i>` : "",
    promos.length ? `🎁 ${promos.map(([name, item]) => `${escapeHtml(name)} ${item.multiplier}x`).join(" · ")}` : "",
    mismatches ? `⚠️ ${mismatches} unexplained chart/docs mismatch${mismatches === 1 ? "" : "es"}` : "✅ Chart/docs cross-check healthy",
    snapshot.go.promoBanner ? `\n<i>${escapeHtml(snapshot.go.promoBanner)}</i>` : "", "", `🕒 ${escapeHtml(formatTime(snapshot.checkedAt, timeZone))}`,
  ].filter(Boolean).join("\n");
}

export function buildRecoveryMessage(previousError, snapshot, timeZone = "America/Chicago") { return `✅ <b>OPENCODE GO WATCH · RECOVERED</b>\n━━━━━━━━━━━━━━━━━━━━\nBoth monitored surfaces parsed successfully again.\n\nLast error\n<code>${escapeHtml(previousError?.message ?? "unknown")}</code>\n\n🕒 ${escapeHtml(formatTime(snapshot.checkedAt, timeZone))}`; }
export function buildErrorMessage(error, checkedAt, timeZone = "America/Chicago") { return `🔴 <b>OPENCODE GO WATCH · ERROR</b>\n━━━━━━━━━━━━━━━━━━━━\nA monitoring run failed. The previous semantic baseline was preserved, so no false removals will be recorded.\n\n<code>${escapeHtml(error?.message ?? String(error))}</code>\n\n🕒 ${escapeHtml(formatTime(checkedAt, timeZone))}`; }

export function watcherDashboardUrl(env, path = "/") {
  const configured = String(env?.WATCHER_DASHBOARD_URL ?? "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.search = ""; url.hash = ""; url.pathname = "/";
    const base = url.toString().replace(/\/$/, "");
    const suffix = path === "/" ? "/" : `/${String(path).replace(/^\/+|\/+$/g, "")}`;
    return `${base}${suffix}`;
  } catch { return null; }
}
export function telegramKeyboard(env = {}) {
  const rows = [];
  const dashboard = watcherDashboardUrl(env, "/");
  if (dashboard) rows.push([{ text: "🛰 Watcher Dashboard", url: dashboard }]);
  rows.push([{ text: "📊 Open Go", url: "https://opencode.ai/go" }, { text: "📚 Usage Docs", url: "https://opencode.ai/docs/go/#usage-limits" }]);
  return { inline_keyboard: rows };
}

async function telegramApi(env, method, payload, fetchImpl = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const base = { signal: AbortSignal.timeout(10_000) };
  const init = payload == null ? { ...base, headers: { accept: "application/json" } } : { ...base, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  const response = await fetchImpl(url, init);
  const body = await response.text();
  let data; try { data = JSON.parse(body); } catch { data = null; }
  if (!response.ok || !data?.ok) throw new Error(`Telegram ${method} failed: ${data?.description ?? `HTTP ${response.status}`}`);
  return data.result;
}
export async function resolveTelegramChatId(env, fetchImpl = fetch) {
  if (env.TELEGRAM_CHAT_ID) return String(env.TELEGRAM_CHAT_ID);
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const cached = env.STATE ? await env.STATE.get(CHAT_ID_KEY) : null;
  if (cached) return String(cached);
  const updates = await telegramApi(env, "getUpdates?limit=100&timeout=0", null, fetchImpl);
  const chats = (updates ?? []).map((update) => update.message?.chat ?? update.edited_message?.chat ?? update.channel_post?.chat).filter((chat) => chat?.id && chat.type === "private");
  const chat = chats.at(-1);
  if (!chat) throw new Error("No private Telegram chat found. Send the bot /start, then run Telegram setup again.");
  if (env.STATE) await env.STATE.put(CHAT_ID_KEY, String(chat.id));
  return String(chat.id);
}
export async function telegramConfigured(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  if (env.TELEGRAM_CHAT_ID) return true;
  return Boolean(env.STATE && await env.STATE.get(CHAT_ID_KEY));
}
export async function sendTelegram(env, html, fetchImpl = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN) return { skipped: true, reason: "telegram_bot_token_not_configured" };
  const chatId = await resolveTelegramChatId(env, fetchImpl);
  if (!chatId) return { skipped: true, reason: "telegram_chat_not_configured" };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: telegramKeyboard(env) }, fetchImpl);
  return { skipped: false, chatIdSuffix: String(chatId).slice(-4) };
}
export async function setupTelegram(env, fetchImpl = fetch) {
  const bot = await telegramApi(env, "getMe", null, fetchImpl);
  const chatId = await resolveTelegramChatId(env, fetchImpl);
  await sendTelegram(env, ["🤖 <b>OPENCODE GO WATCH · CONNECTED</b>", "━━━━━━━━━━━━━━━━━━━━", `Bot <b>@${escapeHtml(bot?.username ?? "unknown")}</b> is connected to this chat.`, "", "✅ Rich HTML cards", "✅ Inline navigation", "✅ Semantic diff alerts", "✅ Failure-safe baseline"].join("\n"), fetchImpl);
  return { ok: true, bot: bot?.username ?? null, chatIdSuffix: String(chatId).slice(-4) };
}
