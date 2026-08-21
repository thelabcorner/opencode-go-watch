import test from "node:test";
import assert from "node:assert/strict";
import { FAILURE_REMINDER_MS, FAILURE_RETRY_MS, shouldRecordFailure } from "../src/resource-budget.js";

const t0 = new Date("2026-08-21T00:00:00Z");
const at = (ms) => new Date(t0.getTime() + ms);

test("new and changed failures are persisted immediately", () => {
  assert.equal(shouldRecordFailure(null, new Error("timeout"), t0), true);
  assert.equal(shouldRecordFailure({ message: "timeout", lastSeenAt: t0.toISOString() }, new Error("parser failed"), at(1)), true);
});

test("unnotified repeated failures retry persistence at most hourly", () => {
  const previous = { message: "timeout", firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(), lastNotifiedAt: null };
  assert.equal(shouldRecordFailure(previous, new Error("timeout"), at(FAILURE_RETRY_MS - 1)), false);
  assert.equal(shouldRecordFailure(previous, new Error("timeout"), at(FAILURE_RETRY_MS)), true);
});

test("notified repeated failures persist only on the six-hour reminder boundary", () => {
  const previous = { message: "timeout", firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(), lastNotifiedAt: t0.toISOString() };
  assert.equal(shouldRecordFailure(previous, new Error("timeout"), at(FAILURE_REMINDER_MS - 1)), false);
  assert.equal(shouldRecordFailure(previous, new Error("timeout"), at(FAILURE_REMINDER_MS)), true);
});

test("malformed legacy timestamps fail open to recording one repair attempt", () => {
  const previous = { message: "timeout", firstSeenAt: "invalid", lastSeenAt: "invalid", lastNotifiedAt: null };
  assert.equal(shouldRecordFailure(previous, new Error("timeout"), t0), true);
});
