import { deriveConsistency } from "./parsers.js";

const GO_CHANGE_TYPES = new Set([
  "chart_model_added",
  "chart_model_removed",
  "chart_changed",
  "promo_banner_changed",
]);

const DOCS_CHANGE_TYPES = new Set([
  "global_limit_changed",
  "model_added",
  "model_removed",
  "request_limit_changed",
  "request_profile_added",
  "request_profile_removed",
  "request_profile_changed",
  "pricing_row_added",
  "pricing_row_removed",
  "pricing_changed",
  "usage_note_added",
  "usage_note_removed",
  "usage_note_changed",
  "usage_copy_changed",
]);

const WRAPPED_REGION_RE = /<span\b(?=[^>]*\bdata-regions\b)[^>]*>\s*\(\s*<a\b(?=[^>]*\bhref="([^"]+)")[^>]*>\s*limited\s+regions\s*<\/a>\s*\)\s*<\/span>/gi;
const DIRECT_REGION_RE = /<a\b(?=[^>]*\bdata-regions\b)(?=[^>]*\bhref="([^"]+)")[^>]*>\s*\(?\s*limited\s+regions\s*\)?\s*<\/a>/gi;
const MONITOR_ITEM_RE = /<span\b(?=[^>]*\bdata-item\b)[^>]*>/gi;
const DATA_MODEL_RE = /\bdata-model="([^"]+)"/i;
const DATA_NAME_RE = /<span\b[^>]*\bdata-name(?:="[^"]*")?[^>]*>([\s\S]*?)<\/span>/i;

function same(a, b) { return Object.is(a, b); }

function numericDelta(before, after) {
  if (typeof before !== "number" || typeof after !== "number") return {};
  const absolute = after - before;
  const percent = before === 0 ? null : (absolute / before) * 100;
  return { absolute, percent };
}

function fieldValue(row, field) {
  return field === "unlimited" ? Boolean(row?.unlimited) : row?.[field];
}

function diffMap({ before = {}, after = {}, addedType, removedType, changedType, fields }) {
  const changes = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    if (!(key in before)) { changes.push({ type: addedType, key, after: after[key] }); continue; }
    if (!(key in after)) { changes.push({ type: removedType, key, before: before[key] }); continue; }
    for (const field of fields) {
      const oldValue = fieldValue(before[key], field);
      const newValue = fieldValue(after[key], field);
      if (same(oldValue, newValue)) continue;
      changes.push({ type: changedType, key, field, before: oldValue ?? null, after: newValue ?? null, ...numericDelta(oldValue, newValue) });
    }
  }
  return changes;
}

function compactTextDelta(before = "", after = "", width = 420) {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const oldMid = before.slice(prefix, before.length - suffix || undefined).trim();
  const newMid = after.slice(prefix, after.length - suffix || undefined).trim();
  const clip = (s) => s.length > width ? `${s.slice(0, width - 1)}…` : s;
  return { before: clip(oldMid), after: clip(newMid) };
}

function normalizeKnownMonitorVariants(value) {
  const token = (href) => `<region-restriction href="${href}">limited regions</region-restriction>`;
  return String(value ?? "").replace(WRAPPED_REGION_RE, (_match, href) => token(href)).replace(DIRECT_REGION_RE, (_match, href) => token(href));
}

function decodeMonitorText(value) {
  return String(value ?? "").replace(/<[^>]+>/g, "").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replace(/\s+/g, " ").trim();
}

function chartModelIdsFromMonitor(structure) {
  const source = String(structure ?? "");
  if (!source) return {};
  const starts = [];
  MONITOR_ITEM_RE.lastIndex = 0;
  let match;
  while ((match = MONITOR_ITEM_RE.exec(source)) !== null) starts.push({ index: match.index, tag: match[0] });
  const ids = {};
  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];
    const modelId = DATA_MODEL_RE.exec(current.tag)?.[1] ?? null;
    if (!modelId) continue;
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    const segment = source.slice(current.index, end);
    const name = decodeMonitorText(DATA_NAME_RE.exec(segment)?.[1]);
    if (name) ids[name] = modelId;
  }
  return ids;
}

function diffChartModelIds(beforeGo, afterGo) {
  const before = chartModelIdsFromMonitor(beforeGo?.monitorStructure);
  const after = chartModelIdsFromMonitor(afterGo?.monitorStructure);
  const changes = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (!(name in before) || !(name in after) || before[name] === after[name]) continue;
    changes.push({ type: "chart_changed", key: name, field: "modelId", before: before[name], after: after[name] });
  }
  return changes;
}

function compactStructureDelta(before = "", after = "", width = 420) {
  const tokenize = (value) => (String(value ?? "").match(/<[^>]+>|[^<>\n]+/g) ?? []).map((token) => token.replace(/\s+/g, " ").trim()).filter(Boolean);
  const counts = (tokens) => { const map = new Map(); for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1); return map; };
  const beforeCounts = counts(tokenize(before));
  const afterCounts = counts(tokenize(after));
  const removed = [];
  const added = [];
  for (const [token, count] of beforeCounts) { const delta = count - (afterCounts.get(token) ?? 0); for (let i = 0; i < delta; i++) removed.push(token); }
  for (const [token, count] of afterCounts) { const delta = count - (beforeCounts.get(token) ?? 0); for (let i = 0; i < delta; i++) added.push(token); }
  const clip = (tokens) => { const text = tokens.join(" | "); if (!text) return ""; return text.length > width ? `${text.slice(0, width - 1)}…` : text; };
  return { before: clip(removed), after: clip(added) };
}

function diffConsistency(oldSnapshot, newSnapshot) {
  const oldConsistency = deriveConsistency(oldSnapshot.go, oldSnapshot.docs);
  const newConsistency = deriveConsistency(newSnapshot.go, newSnapshot.docs);
  const changes = [];
  const keys = new Set([...Object.keys(oldConsistency), ...Object.keys(newConsistency)]);
  for (const key of keys) {
    const before = oldConsistency[key]?.status ?? null;
    const after = newConsistency[key]?.status ?? null;
    if (before === after) continue;
    if (after === "mismatch") changes.push({ type: "consistency_mismatch", key, before: oldConsistency[key] ?? null, after: newConsistency[key] });
    else if (before === "mismatch") changes.push({ type: "consistency_resolved", key, before: oldConsistency[key], after: newConsistency[key] ?? null });
  }
  return changes;
}

export function diffSnapshots(before, after) {
  const changes = [];
  for (const field of ["fiveHourUsd", "weeklyUsd", "monthlyUsd"]) {
    const oldValue = before.docs.limits[field];
    const newValue = after.docs.limits[field];
    if (!same(oldValue, newValue)) changes.push({ type: "global_limit_changed", field, before: oldValue, after: newValue, ...numericDelta(oldValue, newValue) });
  }

  changes.push(...diffMap({ before: before.docs.requests, after: after.docs.requests, addedType: "model_added", removedType: "model_removed", changedType: "request_limit_changed", fields: ["requests5h", "requestsWeek", "requestsMonth", "unlimited"] }));
  changes.push(...diffMap({ before: before.docs.profiles, after: after.docs.profiles, addedType: "request_profile_added", removedType: "request_profile_removed", changedType: "request_profile_changed", fields: ["inputTokens", "cachedTokens", "outputTokens"] }));
  changes.push(...diffMap({ before: before.docs.pricing, after: after.docs.pricing, addedType: "pricing_row_added", removedType: "pricing_row_removed", changedType: "pricing_changed", fields: ["inputPerM", "outputPerM", "cachedReadPerM", "cachedWritePerM", "usageUsd"] }));
  changes.push(...diffMap({ before: before.go.chart, after: after.go.chart, addedType: "chart_model_added", removedType: "chart_model_removed", changedType: "chart_changed", fields: ["requests5h", "bonus", "unlimited"] }));
  changes.push(...diffChartModelIds(before.go, after.go));

  if (before.go.promoBanner !== after.go.promoBanner) changes.push({ type: "promo_banner_changed", before: before.go.promoBanner, after: after.go.promoBanner });

  const noteKeys = new Set([...Object.keys(before.docs.notes ?? {}), ...Object.keys(after.docs.notes ?? {})]);
  for (const key of noteKeys) {
    const oldValue = before.docs.notes?.[key] ?? null;
    const newValue = after.docs.notes?.[key] ?? null;
    if (oldValue === newValue) continue;
    changes.push({ type: oldValue == null ? "usage_note_added" : newValue == null ? "usage_note_removed" : "usage_note_changed", key, before: oldValue, after: newValue });
  }

  changes.push(...diffConsistency(before, after));
  const docsKnownBeforeCopy = changes.some((change) => DOCS_CHANGE_TYPES.has(change.type));
  if (!docsKnownBeforeCopy && before.docs.usageText !== after.docs.usageText) changes.push({ type: "usage_copy_changed", source: "docs", ...compactTextDelta(before.docs.usageText, after.docs.usageText) });

  const goKnown = changes.some((change) => GO_CHANGE_TYPES.has(change.type));
  const beforeGoStructure = typeof before.go.monitorStructure === "string" ? normalizeKnownMonitorVariants(before.go.monitorStructure) : null;
  const afterGoStructure = typeof after.go.monitorStructure === "string" ? normalizeKnownMonitorVariants(after.go.monitorStructure) : null;
  if (!goKnown && beforeGoStructure != null && afterGoStructure != null && beforeGoStructure !== afterGoStructure) {
    changes.push({ type: "unclassified_source_change", source: "go", ...compactStructureDelta(beforeGoStructure, afterGoStructure) });
  }

  const docsKnown = changes.some((change) => DOCS_CHANGE_TYPES.has(change.type));
  if (!docsKnown && typeof before.docs.monitorStructure === "string" && typeof after.docs.monitorStructure === "string" && before.docs.monitorStructure !== after.docs.monitorStructure) {
    changes.push({ type: "unclassified_source_change", source: "docs", ...compactStructureDelta(before.docs.monitorStructure, after.docs.monitorStructure) });
  }
  return changes;
}
