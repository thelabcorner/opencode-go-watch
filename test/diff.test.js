import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDocsPage, parseGoPage } from "../src/parsers.js";
import { diffSnapshots } from "../src/diff.js";

const goHtml = await readFile(new URL("./fixtures/go.html", import.meta.url), "utf8");
const docsHtml = await readFile(new URL("./fixtures/docs.html", import.meta.url), "utf8");

function snap() {
  return { schema: 1, checkedAt: "2026-08-19T18:00:00.000Z", go: parseGoPage(goHtml), docs: parseDocsPage(docsHtml) };
}

test("finds changed requests, additions/removals, pricing and chart changes", () => {
  const before = snap();
  const after = structuredClone(before);
  after.checkedAt = "2026-08-19T18:05:00.000Z";
  after.docs.requests["GPT 5.6 Luna"].requests5h = 2300;
  after.docs.requests["New Model"] = { requests5h: 999, requestsWeek: 2000, requestsMonth: 4000 };
  delete after.docs.requests["GLM-5.2"];
  after.docs.pricing["Grok 4.5"].cachedReadPerM = 0.35;
  after.go.chart.Hy3.requests5h = 4300;
  after.go.chart.Hy3.bonus = null;

  const changes = diffSnapshots(before, after);
  assert(changes.some((c) => c.type === "request_limit_changed" && c.key === "GPT 5.6 Luna"));
  assert(changes.some((c) => c.type === "model_added" && c.key === "New Model"));
  assert(changes.some((c) => c.type === "model_removed" && c.key === "GLM-5.2"));
  assert(changes.some((c) => c.type === "pricing_changed" && c.key === "Grok 4.5"));
  assert(changes.some((c) => c.type === "chart_changed" && c.key === "Hy3" && c.field === "bonus"));
});

test("emits an unclassified fallback when monitored chart structure changes without a known semantic delta", () => {
  const before = snap();
  const changedHtml = goHtml.replace('data-model="hy3"', 'data-model="hy3" data-context-window="1m"');
  const after = { ...structuredClone(before), go: parseGoPage(changedHtml), checkedAt: "2026-08-19T18:05:00.000Z" };
  const changes = diffSnapshots(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "unclassified_source_change");
  assert.equal(changes[0].source, "go");
  assert.match(changes[0].after, /data-context-window/);
});

test("does not emit an unclassified fallback for presentation-only markup churn", () => {
  const before = snap();
  const noisyHtml = goHtml.replace('data-model="hy3"', 'class="foo" style="left: 50%" data-model="hy3"');
  const after = { ...structuredClone(before), go: parseGoPage(noisyHtml), checkedAt: "2026-08-19T18:05:00.000Z" };
  assert.deepEqual(diffSnapshots(before, after), []);
});
