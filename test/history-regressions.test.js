import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { diffSnapshots } from "../src/diff.js";
import { deriveConsistency, parseDocsPage, parseGoPage, parsePromoDescriptor } from "../src/parsers.js";
import { validateTransition } from "../src/watcher.js";

const goHtml = await readFile(new URL("./fixtures/go.html", import.meta.url), "utf8");
const docsHtml = await readFile(new URL("./fixtures/docs.html", import.meta.url), "utf8");

function snapshot() {
  return {
    schema: 1,
    checkedAt: "2026-08-19T18:00:00.000Z",
    sources: { go: "https://opencode.ai/go", docs: "https://opencode.ai/docs/go/" },
    go: parseGoPage(goHtml),
    docs: parseDocsPage(docsHtml),
  };
}

test("historical promo banners yield a model + multiplier descriptor", () => {
  assert.deepEqual(parsePromoDescriptor("Hy3 gets 8× usage limits for a limited time"), { model: "Hy3", multiplier: 8 });
  assert.deepEqual(parsePromoDescriptor("MiniMax M3 gets 3x usage limits for a limited time"), { model: "MiniMax M3", multiplier: 3 });
  assert.deepEqual(parsePromoDescriptor("DeepSeek V4 Flash gets 2× usage limits for a limited time"), { model: "DeepSeek V4 Flash", multiplier: 2 });
});

test("banner promotion explains chart/docs delta even if data-bonus markup disappears", () => {
  const go = parseGoPage(goHtml.replace("<span data-bonus>8x usage</span>", ""));
  const docs = parseDocsPage(docsHtml);
  const consistency = deriveConsistency(go, docs);
  assert.equal(go.chart.Hy3.bonus, null);
  assert.equal(consistency.Hy3.status, "promotion");
  assert.equal(consistency.Hy3.multiplier, 8);
});

test("global subscription allowance changes are semantic changes", () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.docs.limits = { fiveHourUsd: 15, weeklyUsd: 35, monthlyUsd: 70 };
  const changes = diffSnapshots(before, after).filter((change) => change.type === "global_limit_changed");
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map((change) => change.field), ["fiveHourUsd", "weeklyUsd", "monthlyUsd"]);
});

test("peak/off-peak price changes stay isolated to the exact pricing row", () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.docs.pricing["DeepSeek V4 Flash (Off-Peak)"].cachedReadPerM = 0.01;
  const changes = diffSnapshots(before, after).filter((change) => change.type === "pricing_changed");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, "DeepSeek V4 Flash (Off-Peak)");
  assert.equal(changes[0].field, "cachedReadPerM");
});

test("reordering rows across tables is semantically silent", () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.docs.requests = Object.fromEntries(Object.entries(after.docs.requests).reverse());
  after.docs.pricing = Object.fromEntries(Object.entries(after.docs.pricing).reverse());
  after.docs.profiles = Object.fromEntries(Object.entries(after.docs.profiles).reverse());
  after.go.chart = Object.fromEntries(Object.entries(after.go.chart).reverse());
  assert.deepEqual(diffSnapshots(before, after), []);
});

test("transition circuit breaker rejects a suspicious mass shrink", () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.docs.requests = Object.fromEntries(Object.entries(after.docs.requests).slice(0, 10));
  assert.throws(() => validateTransition(before, after), /Suspicious docs request table shrink/);
});

test("transition circuit breaker permits ordinary small model removals", () => {
  const before = snapshot();
  const after = structuredClone(before);
  delete after.docs.requests["GLM-5.1"];
  delete after.docs.pricing["GLM-5.1"];
  assert.doesNotThrow(() => validateTransition(before, after));
});
