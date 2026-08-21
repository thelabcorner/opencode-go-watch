/// <reference path="./node-zlib.d.ts" />
import { brotliDecompressSync } from "node:zlib";

const HISTORY_KEY = "alert-history:v1";
const HISTORY_SCHEMA = 1;
const MAX_EVENTS = 96;
const MAX_JSON_BYTES = 96 * 1024;
const MAX_DETAIL_CHARS = 1600;
const MAX_CHANGE_ROWS = 24;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function clip(value, limit = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function fmt(value) {
  if (value == null) return "none";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
  if (typeof value === "object") return clip(JSON.stringify(value), 180);
  return clip(value, 180);
}

function fieldLabel(field) {
  return ({
    requests5h: "5h requests",
    requestsWeek: "weekly requests",
    requestsMonth: "monthly requests",
    inputPerM: "input price",
    outputPerM: "output price",
    cachedReadPerM: "cached-read price",
    cachedWritePerM: "cached-write price",
    usageUsd: "included usage",
    inputTokens: "input/request",
    cachedTokens: "cached/request",
    outputTokens: "output/request",
    bonus: "promotion",
    fiveHourUsd: "5h allowance",
    weeklyUsd: "weekly allowance",
    monthlyUsd: "monthly allowance",
  })[field] ?? field ?? "value";
}

function describeChange(change) {
  const key = change.key ? `${change.key}: ` : "";
  switch (change.type) {
    case "model_added": return `Model added: ${change.key}`;
    case "model_removed": return `Model removed: ${change.key}`;
    case "chart_model_added": return `Go chart added ${change.key}`;
    case "chart_model_removed": return `Go chart removed ${change.key}`;
    case "pricing_row_added": return `Pricing row added: ${change.key}`;
    case "pricing_row_removed": return `Pricing row removed: ${change.key}`;
    case "request_profile_added": return `Request profile added: ${change.key}`;
    case "request_profile_removed": return `Request profile removed: ${change.key}`;
    case "promo_banner_changed": return `Promotion banner: ${fmt(change.before)} → ${fmt(change.after)}`;
    case "consistency_mismatch": return `Chart/docs mismatch: ${change.key}`;
    case "consistency_resolved": return `Chart/docs mismatch resolved: ${change.key}`;
    case "usage_copy_changed": return `Usage wording: ${fmt(change.before)} → ${fmt(change.after)}`;
    case "unclassified_source_change": return `Unclassified ${change.source === "go" ? "Go chart" : "docs"} change: ${fmt(change.before)} → ${fmt(change.after)}`;
    default:
      if (change.field) return `${key}${fieldLabel(change.field)} ${fmt(change.before)} → ${fmt(change.after)}`;
      return `${key}${change.type}`;
  }
}

function headlineForChanges(changes) {
  const types = new Set(changes.map((change) => change.type));
  if (types.has("unclassified_source_change")) return { title: "🟡 OPENCODE GO · UNCLASSIFIED CHANGE", kind: "unclassified", severity: "warning" };
  if (changes.some((change) => change.type === "model_added")) return { title: "🆕 OPENCODE GO · NEW MODEL", kind: "model", severity: "info" };
  if (changes.some((change) => change.type === "model_removed")) return { title: "🗑 OPENCODE GO · MODEL REMOVED", kind: "model", severity: "warning" };
  if ([...types].some((type) => type.includes("pricing"))) return { title: "💰 OPENCODE GO · PRICING UPDATE", kind: "pricing", severity: "info" };
  if ([...types].some((type) => type.includes("promo") || type === "chart_changed")) return { title: "🎁 OPENCODE GO · USAGE UPDATE", kind: "usage", severity: "info" };
  return { title: "🚨 OPENCODE GO WATCH", kind: "change", severity: "info" };
}

function sanitizeEvent(event) {
  if (!event || typeof event.title !== "string") return null;
  const changes = Array.isArray(event.changes)
    ? event.changes.slice(0, MAX_CHANGE_ROWS).map((row) => clip(row, 260))
    : [];
  return {
    id: typeof event.id === "string" ? event.id : crypto.randomUUID(),
    at: typeof event.at === "string" ? event.at : new Date().toISOString(),
    kind: clip(event.kind || "change", 32),
    severity: ["info", "success", "warning", "error"].includes(event.severity) ? event.severity : "info",
    title: clip(event.title, 140),
    detail: clip(event.detail, 520),
    count: Number.isFinite(event.count) ? Math.max(0, Math.trunc(event.count)) : null,
    changes,
    message: clip(event.message || changes.join("\n"), MAX_DETAIL_CHARS),
  };
}

function encodeHistory(events) {
  let retained = events.slice(0, MAX_EVENTS);
  let json = JSON.stringify({ schema: HISTORY_SCHEMA, events: retained });
  let input = ENCODER.encode(json);
  while (input.byteLength > MAX_JSON_BYTES && retained.length > 1) {
    retained = retained.slice(0, -1);
    json = JSON.stringify({ schema: HISTORY_SCHEMA, events: retained });
    input = ENCODER.encode(json);
  }
  return {
    events: retained,
    bytes: input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength),
    rawBytes: input.byteLength,
    storedBytes: input.byteLength,
  };
}

function normalizeEvents(value) {
  if (!value || value.schema !== HISTORY_SCHEMA || !Array.isArray(value.events)) return [];
  return value.events.filter((event) => event && typeof event.at === "string" && typeof event.title === "string");
}

function bytesOf(raw) {
  if (typeof raw === "string") return ENCODER.encode(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return null;
}

function decodeHistory(raw) {
  const bytes = bytesOf(raw);
  if (!bytes) return [];

  // New records are bounded raw UTF-8 JSON. Avoid synchronous compression work on
  // the alert-producing path: CPU is much scarcer than the <=96 KiB history value.
  try {
    return normalizeEvents(JSON.parse(DECODER.decode(bytes)));
  } catch {
    // Migration compatibility for history written by versions that stored Brotli.
    const decompressed = brotliDecompressSync(bytes);
    return normalizeEvents(JSON.parse(DECODER.decode(decompressed)));
  }
}

export async function readAlertHistory(env, limit = MAX_EVENTS) {
  if (!env.STATE) return [];
  const raw = await env.STATE.get(HISTORY_KEY, { type: "arrayBuffer" });
  if (!raw) return [];
  try {
    return decodeHistory(raw).slice(0, Math.max(0, limit));
  } catch (error) {
    console.error("alert history decode failed", error);
    return [];
  }
}

export async function appendAlertEvents(env, events) {
  if (!env.STATE) return { archived: false, reason: "state_unavailable" };
  const safeEvents = (Array.isArray(events) ? events : [events]).map(sanitizeEvent).filter(Boolean);
  if (!safeEvents.length) return { archived: false, reason: "invalid_event" };
  const existing = await readAlertHistory(env);
  const encoded = encodeHistory([...safeEvents, ...existing]);
  await env.STATE.put(HISTORY_KEY, encoded.bytes);
  return {
    archived: true,
    added: safeEvents.length,
    count: encoded.events.length,
    rawBytes: encoded.rawBytes,
    storedBytes: encoded.storedBytes,
  };
}

export async function appendAlertEvent(env, event) {
  return appendAlertEvents(env, [event]);
}

export function historyEventForWatchResult(result, at = new Date()) {
  if (!result) return null;
  if (result.status === "bootstrapped") {
    const snapshot = result.snapshot;
    const docs = Object.keys(snapshot?.docs?.requests ?? {}).length;
    const chart = Object.keys(snapshot?.go?.chart ?? {}).length;
    return sanitizeEvent({
      at: at.toISOString(), kind: "armed", severity: "success",
      title: "🟢 OPENCODE GO WATCH · ARMED",
      detail: `Baseline captured with ${docs} docs models and ${chart} Go-chart models.`,
      count: 0,
      message: `Baseline captured. Semantic monitoring is live. ${docs} docs models · ${chart} chart models.`,
    });
  }
  const changes = Array.isArray(result.changes) ? result.changes : [];
  if (result.status !== "changed" || !changes.length) return null;
  const headline = headlineForChanges(changes);
  const rows = changes.slice(0, MAX_CHANGE_ROWS).map(describeChange);
  const omitted = Math.max(0, changes.length - rows.length);
  if (omitted) rows.push(`…and ${omitted} more semantic field change${omitted === 1 ? "" : "s"}`);
  return sanitizeEvent({
    at: at.toISOString(), ...headline,
    count: changes.length,
    detail: rows.slice(0, 3).join(" · "),
    changes: rows,
    message: rows.join("\n"),
  });
}

export function historyEventForFailure(error, at = new Date()) {
  const message = clip(error?.message ?? String(error), 1200);
  return sanitizeEvent({
    at: at.toISOString(), kind: "error", severity: "error",
    title: "🔴 OPENCODE GO WATCH · ERROR",
    detail: message,
    message: `Monitoring run failed. Previous semantic baseline preserved.\n${message}`,
  });
}

export function historyEventForRecovery(previousError, at = new Date()) {
  const message = clip(previousError?.message ?? "unknown error", 900);
  return sanitizeEvent({
    at: at.toISOString(), kind: "recovery", severity: "success",
    title: "✅ OPENCODE GO WATCH · RECOVERED",
    detail: `Monitoring recovered after: ${message}`,
    message: `Both monitored surfaces parsed successfully again.\nLast error: ${message}`,
  });
}

export const alertHistoryConfig = Object.freeze({
  key: HISTORY_KEY,
  maxEvents: MAX_EVENTS,
  maxJsonBytes: MAX_JSON_BYTES,
  encoding: "json-utf8",
  legacyBrotliRead: true,
});
