import test from "node:test";
import assert from "node:assert/strict";
import {
  alertHistoryConfig,
  appendAlertEvent,
  historyEventForFailure,
  historyEventForRecovery,
  historyEventForWatchResult,
  readAlertHistory,
} from "../src/history.js";

class FakeKV {
  map = new Map();
  async get(key, options) {
    const value = this.map.get(key);
    if (value == null) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.map.set(key, value); }
}
const env = () => ({ STATE: new FakeKV() });

test("alert history is stored as Brotli-compressed binary and round-trips", async () => {
  const e = env();
  const event = historyEventForWatchResult({
    status: "changed",
    changes: [{ type: "pricing_changed", key: "DeepSeek V4 Pro (Peak)", field: "inputPerM", before: 0.66, after: 1.32 }],
  }, new Date("2026-08-20T19:00:00Z"));
  const result = await appendAlertEvent(e, event);
  assert.equal(result.archived, true);
  assert(result.compressedBytes < result.rawBytes);
  assert(e.STATE.map.get(alertHistoryConfig.key) instanceof ArrayBuffer);
  const history = await readAlertHistory(e);
  assert.equal(history.length, 1);
  assert.match(history[0].title, /PRICING UPDATE/);
  assert.match(history[0].message, /0\.66 → 1\.32/);
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
