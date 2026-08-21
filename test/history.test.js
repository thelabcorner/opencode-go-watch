import test from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync } from "node:zlib";
import {
  alertHistoryConfig,
  appendAlertEvent,
  appendAlertEvents,
  historyEventForFailure,
  historyEventForRecovery,
  historyEventForWatchResult,
  readAlertHistory,
} from "../src/history.js";

class FakeKV {
  map = new Map();
  writes = [];
  async get(key, options) {
    const value = this.map.get(key);
    if (value == null) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.writes.push(key);
    this.map.set(key, value);
  }
}
const env = () => ({ STATE: new FakeKV() });
const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("alert history is stored as bounded raw JSON and round-trips", async () => {
  const e = env();
  const event = historyEventForWatchResult({
    status: "changed",
    changes: [{ type: "pricing_changed", key: "DeepSeek V4 Pro (Peak)", field: "inputPerM", before: 0.66, after: 1.32 }],
  }, new Date("2026-08-20T19:00:00Z"));
  const result = await appendAlertEvent(e, event);
  assert.equal(result.archived, true);
  assert.equal(result.storedBytes, result.rawBytes);
  assert(result.storedBytes <= alertHistoryConfig.maxJsonBytes);
  const stored = e.STATE.map.get(alertHistoryConfig.key);
  assert(stored instanceof ArrayBuffer);
  assert.doesNotThrow(() => JSON.parse(decoder.decode(new Uint8Array(stored))));
  const history = await readAlertHistory(e);
  assert.equal(history.length, 1);
  assert.match(history[0].title, /PRICING UPDATE/);
  assert.match(history[0].message, /0\.66 → 1\.32/);
});

test("legacy Brotli history remains readable after the raw-JSON migration", async () => {
  const e = env();
  const legacy = {
    schema: 1,
    events: [{
      id: "legacy",
      at: "2026-08-20T18:00:00.000Z",
      kind: "change",
      severity: "info",
      title: "legacy compressed event",
      detail: "before migration",
      count: 1,
      changes: [],
      message: "legacy payload",
    }],
  };
  const compressed = brotliCompressSync(encoder.encode(JSON.stringify(legacy)));
  e.STATE.map.set(alertHistoryConfig.key, compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength));
  const history = await readAlertHistory(e);
  assert.equal(history.length, 1);
  assert.equal(history[0].title, "legacy compressed event");
});

test("batched archive appends multiple events with one KV write", async () => {
  const e = env();
  const result = await appendAlertEvents(e, [
    { at: "2026-08-20T19:00:00Z", title: "go change", kind: "change", severity: "info" },
    { at: "2026-08-20T19:00:00Z", title: "zen change", kind: "zen-change", severity: "info" },
  ]);
  assert.equal(result.archived, true);
  assert.equal(result.added, 2);
  assert.equal(e.STATE.writes.length, 1);
  const history = await readAlertHistory(e);
  assert.deepEqual(history.map((event) => event.title), ["go change", "zen change"]);
});

test("history keeps newest-first order and caps the rolling event count", async () => {
  const e = env();
  for (let i = 0; i < alertHistoryConfig.maxEvents + 7; i++) {
    await appendAlertEvent(e, {
      at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      title: `event ${i}`, kind: "change", severity: "info",
      detail: `detail ${i}`, message: `message ${i}`,
    });
  }
  const history = await readAlertHistory(e);
  assert.equal(history.length, alertHistoryConfig.maxEvents);
  assert.equal(history[0].title, `event ${alertHistoryConfig.maxEvents + 6}`);
  assert.equal(history.at(-1).title, "event 7");
});

test("watch outcomes classify semantic, failure and recovery history cards", () => {
  const change = historyEventForWatchResult({
    status: "changed",
    changes: [{ type: "unclassified_source_change", source: "go", before: "old", after: "new" }],
  }, new Date("2026-08-20T19:00:00Z"));
  assert.equal(change.kind, "unclassified");
  assert.equal(change.severity, "warning");
  assert.match(change.detail, /Unclassified Go chart change/);
  const failure = historyEventForFailure(new Error("timeout"), new Date("2026-08-20T19:05:00Z"));
  assert.equal(failure.severity, "error");
  assert.match(failure.detail, /timeout/);
  const recovery = historyEventForRecovery({ message: "timeout" }, new Date("2026-08-20T19:10:00Z"));
  assert.equal(recovery.severity, "success");
  assert.match(recovery.detail, /timeout/);
});

test("model routing ID replacements get a dedicated semantic history card", () => {
  const event = historyEventForWatchResult({
    status: "changed",
    changes: [{ type: "chart_changed", key: "Ox Alpha", field: "modelId", before: "x-preview-f-free", after: "ox-alpha-free" }],
  }, new Date("2026-08-21T09:10:00Z"));
  assert.equal(event.kind, "model-id");
  assert.equal(event.severity, "info");
  assert.match(event.title, /MODEL ID CHANGED/);
  assert.match(event.detail, /Ox Alpha/);
  assert.match(event.detail, /x-preview-f-free → ox-alpha-free/);
});
