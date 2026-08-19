import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  deriveConsistency,
  expandProfileLabel,
  parseDocsPage,
  parseGoPage,
} from "../src/parsers.js";

const goHtml = await readFile(new URL("./fixtures/go.html", import.meta.url), "utf8");
const docsHtml = await readFile(new URL("./fixtures/docs.html", import.meta.url), "utf8");

test("parses Go chart and promotion", () => {
  const go = parseGoPage(goHtml);
  assert.equal(go.chart["GPT 5.6 Luna"].requests5h, 2050);
  assert.equal(go.chart.Hy3.requests5h, 34400);
  assert.equal(go.chart.Hy3.bonus, "8x usage");
  assert.equal(go.promoBanner, "Hy3 gets 8× usage limits for a limited time");
});

test("parses docs limits, request table, expanded profiles and pricing", () => {
  const docs = parseDocsPage(docsHtml);
  assert.deepEqual(docs.limits, { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 });
  assert.deepEqual(docs.requests["GPT 5.6 Luna"], { requests5h: 2050, requestsWeek: 5100, requestsMonth: 10250 });
  assert.equal(docs.profiles["Grok 4.5"].cachedTokens, 71500);
  assert.equal(docs.profiles["GLM-5.3"].cachedTokens, 52000);
  assert.equal(docs.profiles["GLM-5.2"].cachedTokens, 52000);
  assert.equal(docs.profiles["GLM-5.1"].cachedTokens, 52000);
  assert.equal(docs.profiles["Kimi K2.7 Code"].cachedTokens, 55000);
  assert.equal(docs.profiles["Kimi K2.6"].cachedTokens, 55000);
  assert.equal(docs.pricing["GPT 5.6 Luna (≤ 272K tokens)"].cachedWritePerM, 0.25);
  assert.equal(docs.pricing["Grok 4.5"].cachedWritePerM, null);
});

test("expands historical grouped profile labels without rename noise", () => {
  const names = ["GLM-5.3", "GLM-5.2", "GLM-5.1", "Kimi K2.7 Code", "Kimi K2.6"];
  assert.deepEqual(expandProfileLabel("GLM-5.3/5.2/5.1", names), ["GLM-5.3", "GLM-5.2", "GLM-5.1"]);
  assert.deepEqual(expandProfileLabel("Kimi K2.7/K2.6", names), ["Kimi K2.7 Code", "Kimi K2.6"]);
});

test("understands chart promotions rather than flagging a mismatch", () => {
  const go = parseGoPage(goHtml);
  const docs = parseDocsPage(docsHtml);
  const consistency = deriveConsistency(go, docs);
  assert.equal(consistency.Hy3.status, "promotion");
  assert.equal(consistency.Hy3.multiplier, 8);
  assert.equal(consistency["Kimi K3"].status, "match");
});

test("normalizes historical promotion embedded in model name", () => {
  const html = `
    <figure><span data-item>
      <span data-value>4,100</span>
      <span data-name>GPT 5.6 Luna (2x usage)</span>
    </span></figure>`;
  const go = parseGoPage(html);
  assert.deepEqual(go.chart["GPT 5.6 Luna"], { requests5h: 4100, bonus: "2x usage" });
  assert.equal(go.chart["GPT 5.6 Luna (2x usage)"], undefined);
});

test("chart DOM reordering does not alter parsed semantic data", () => {
  const reversed = goHtml.replace(
    /(<span data-item[\s\S]*?<\/span>\s*){11}/,
    (block) => block,
  );
  // Explicitly reorder the 11 item lines in the fixture.
  const lines = goHtml.split("\n");
  const itemLines = lines.filter((line) => line.includes("<span data-item"));
  const rebuilt = lines.filter((line) => !line.includes("<span data-item"));
  const insertAt = rebuilt.findIndex((line) => line.includes('<div data-slot="pills">')) + 1;
  rebuilt.splice(insertAt, 0, ...itemLines.reverse());
  assert.deepEqual(parseGoPage(rebuilt.join("\n")).chart, parseGoPage(goHtml).chart);
  assert.ok(reversed); // keep the test intentionally independent of formatting details
});

test("unknown chart attributes alter the fallback monitor structure without altering known semantics", () => {
  const before = parseGoPage(goHtml);
  const changedHtml = goHtml.replace('data-model="hy3"', 'data-model="hy3" data-context-window="1m"');
  const after = parseGoPage(changedHtml);
  assert.deepEqual(after.chart, before.chart);
  assert.notEqual(after.monitorStructure, before.monitorStructure);
  assert.match(after.monitorStructure, /data-context-window="1m"/);
});

test("presentation-only chart markup and item reordering are silent in the fallback monitor structure", () => {
  const before = parseGoPage(goHtml);
  const noisy = goHtml
    .replace('data-model="hy3"', 'class="foo" style="left: 50%" data-model="hy3"')
    .replace('<figure data-component="limit-graph">', '<figure class="new-layout" data-component="limit-graph">');
  assert.equal(parseGoPage(noisy).monitorStructure, before.monitorStructure);

  const lines = goHtml.split("\n");
  const itemLines = lines.filter((line) => line.includes("<span data-item"));
  const rebuilt = lines.filter((line) => !line.includes("<span data-item"));
  const insertAt = rebuilt.findIndex((line) => line.includes('<div data-slot="pills">')) + 1;
  rebuilt.splice(insertAt, 0, ...itemLines.reverse());
  assert.equal(parseGoPage(rebuilt.join("\n")).monitorStructure, before.monitorStructure);
});
