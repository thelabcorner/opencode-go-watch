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
