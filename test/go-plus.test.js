import test from "node:test";
import assert from "node:assert/strict";
import { parseDocsPage, parseGoPage } from "../src/parsers.js";
import { diffSnapshots } from "../src/diff.js";
import { buildChangeMessages } from "../src/telegram.js";
import { historyEventForWatchResult } from "../src/history.js";

const figure = (rows) => `<figure data-component="go-plan-chart"><ul data-slot="legend"><li><i data-tier="go"></i>Go</li><li><i data-tier="plus"></i>Go Plus</li></ul><table><thead><tr><th>Model</th><th>Est. requests / 5h</th><th>Monthly usage</th></tr></thead><tbody>${rows.join("")}</tbody></table></figure>`;
const row = (name, go, plus, allowanceGo, allowancePlus, label = "") => `<tr data-hk="transient"><th scope="row"><bdi>${name}</bdi>${label}</th><td data-slot="bars" aria-hidden="true"><div data-tier="go"></div><div data-tier="plus"></div></td><td data-slot="number"><span>${go}</span><span>${plus}</span></td><td data-slot="number"><span>${allowanceGo}</span><span>${allowancePlus}</span></td></tr>`;
const primary = row("Synthetic A", "100", "400", "$15", "$60");
const sibling = row("Synthetic B", "250", "750", "$30", "$90", '<span data-slot="labels"><a href="https://example.com/region-policy">Limited Regions</a></span>');
const free = row("Preview Free", "∞", "∞", "∞", "∞", '<span data-slot="labels"><small>Limited Time</small></span>');
const html = figure([primary, sibling, free]);

test("dual-plan chart extracts independent Go/Plus allowance states and region evidence", () => {
  const { chart } = parseGoPage(html);
  assert.equal(chart["Synthetic A"].requests5h, 100);
  assert.equal(chart["Synthetic A"].plusRequests5h, 400);
  assert.equal(chart["Synthetic A"].monthlyAllowanceUsd, 15);
  assert.equal(chart["Synthetic A"].plusMonthlyAllowanceUsd, 60);
  assert.equal(chart["Synthetic B"].plusRequests5h, 750);
  assert.equal(chart["Synthetic B"].regionUrl, "https://example.com/region-policy");
  assert.equal(chart["Preview Free"].limitState, "unlimited");
  assert.equal(chart["Preview Free"].plusLimitState, "unlimited");
  assert.equal(chart["Preview Free"].plusMonthlyAllowanceUsd, null);
});

test("a second synthetic entity follows the same independent tier rules", () => {
  const chart = parseGoPage(figure([row("Entirely New Model", "1,250", "5,000", "$20", "$80")])).chart;
  assert.equal(chart["Entirely New Model"].requests5h, 1250);
  assert.equal(chart["Entirely New Model"].plusRequests5h, 5000);
  assert.equal(chart["Entirely New Model"].plusMonthlyAllowanceUsd, 80);
});

test("presentation reorder and hydration churn are silent but unknown semantic attributes remain monitored", () => {
  const before = parseGoPage(html);
  const after = parseGoPage(figure([free.replace('data-hk="transient"', 'data-hk="new"'), primary, sibling]));
  assert.deepEqual(before.chart, after.chart);
  assert.equal(before.monitorStructure, after.monitorStructure);
  assert.notEqual(before.monitorStructure, parseGoPage(html.replace('scope="row"', 'scope="row" data-future-allowance="changed"')).monitorStructure);
});

test("ambiguous tiers and conflicting infinity evidence fail closed", () => {
  assert.throws(() => parseGoPage(figure([row("Unknown", "-", "400", "$15", "$60")])), /invalid or unknown quota/);
  assert.throws(() => parseGoPage(figure([row("Conflict", "∞", "400", "$15", "$60")])), /conflicting request and monthly/);
  assert.throws(() => parseGoPage(html.replace('<span>400</span>', "")), /two paired numeric cells/);
  assert.throws(() => parseGoPage(html.replace('data-tier="plus"', 'data-tier="other"').replaceAll('data-tier="plus"', 'data-tier="other"')), /lacks explicit Go and Go Plus tier/);
});

const pricingTable = (usd) => `<table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr></thead><tbody><tr><td>Synthetic A</td><td>$0.1</td><td>$0.5</td><td>$0.02</td><td>-</td><td>$${usd}</td></tr></tbody></table>`;
const requestTable = (n) => `<table><thead><tr><th>Model</th><th>Requests per 5 hours</th><th>Requests per week</th><th>Requests per month</th></tr></thead><tbody><tr><td>Synthetic A</td><td>${n}</td><td>${n * 2}</td><td>${n * 3}</td></tr><tr><td>Preview Free</td><td>Unlimited</td><td>Unlimited</td><td>Unlimited</td></tr></tbody></table>`;
const docsHtml = `<h2 id="usage-limits">Usage limits</h2><p>5-hour — 20%; weekly — 50%; monthly — 100%</p><h3>Prices</h3>${pricingTable(15)}${pricingTable(60)}<h3>Estimated requests</h3>${requestTable(100)}${requestTable(400)}<p>Synthetic A — 1,000 input, 50,000 cached, 200 output tokens per request</p><h2>Next section</h2>`;

test("Go docs preserve both SSR tab tables as distinct per-plan sources", () => {
  const docs = parseDocsPage(docsHtml);
  assert.equal(docs.requests["Synthetic A"].requests5h, 100);
  assert.equal(docs.requestsPlus["Synthetic A"].requests5h, 400);
  assert.equal(docs.pricing["Synthetic A"].usageUsd, 15);
  assert.equal(docs.pricingPlus["Synthetic A"].usageUsd, 60);
  assert.equal(docs.requestsPlus["Preview Free"].limitState, "unlimited");
});

test("Go Plus semantic changes are tier-labeled and old one-plan snapshots migrate silently", () => {
  const before = { go: parseGoPage(html), docs: parseDocsPage(docsHtml) };
  const after = { go: parseGoPage(html.replace('<span>400</span>', '<span>450</span>')), docs: parseDocsPage(docsHtml.replace(requestTable(400), requestTable(450))) };
  const changes = diffSnapshots(before, after);
  assert.ok(changes.some((change) => change.type === "chart_changed" && change.key === "Synthetic A" && change.field === "plusRequests5h" && change.before === 400 && change.after === 450));
  assert.ok(changes.some((change) => change.type === "request_limit_changed" && change.key === "Synthetic A" && change.plan === "Go Plus" && change.field === "requests5h" && change.after === 450));
  const legacy = { ...before, docs: { ...before.docs, requestsPlus: undefined, pricingPlus: undefined }, go: { ...before.go, chart: Object.fromEntries(Object.entries(before.go.chart).map(([name, value]) => {
    const { plusRequests5h, plusLimitState, plusLimitEvidence, plusMonthlyAllowanceUsd, ...historical } = value;
    return [name, historical];
  })) } };
  assert.ok(!diffSnapshots(legacy, before).some((change) => change.field?.startsWith("plus") || change.plan === "Go Plus"));
});

test("Go Plus changes remain plan-specific in Telegram and archived history", () => {
  const snapshot = { checkedAt: "2026-10-08T19:00:00.000Z", go: parseGoPage(html), docs: parseDocsPage(docsHtml) };
  const changes = [
    { type: "request_limit_changed", key: "Synthetic A", plan: "Go Plus", field: "requests5h", before: 400, after: 450 },
    { type: "chart_changed", key: "Synthetic A", field: "plusRequests5h", before: 400, after: 450 },
    { type: "go_plus_pricing_row_added", key: "Synthetic C", plan: "Go Plus", after: { inputPerM: 1, outputPerM: 2, cachedReadPerM: 0.1, usageUsd: 60 } },
  ];
  const message = buildChangeMessages(changes, snapshot).join("\n");
  assert.match(message, /Go Plus · 5 hour:/);
  assert.match(message, /Go Plus · 5 hour: <code>400 → 450<\/code>/);
  assert.match(message, /GO PLUS PRICING ROW ADDED/);
  assert.doesNotMatch(message, /GO PLUS PRICING ROW REMOVED/);
  const history = historyEventForWatchResult({ status: "changed", changes });
  assert.match(history.message, /Go Plus · Synthetic A: 5h requests 400 → 450/);
  assert.match(history.message, /Go Plus pricing row added: Synthetic C/);
});
