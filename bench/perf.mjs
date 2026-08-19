import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { diffSnapshots } from "../src/diff.js";
import { parseDocsPage, parseGoPage } from "../src/parsers.js";
import { buildChangeMessages } from "../src/telegram.js";
import { runWatch } from "../src/watcher.js";

const goHtml = await readFile(new URL("../test/fixtures/go.html", import.meta.url), "utf8");
const docsHtml = await readFile(new URL("../test/fixtures/docs.html", import.meta.url), "utf8");

class FakeKV {
  map = new Map();
  async get(key, opts) {
    const value = this.map.get(key);
    if (value == null) return null;
    return opts?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

function environment() {
  return {
    STATE: new FakeKV(),
    OPENCODE_GO_URL: "https://opencode.ai/go",
    OPENCODE_DOCS_URL: "https://opencode.ai/docs/go/",
    NOTIFY_ON_BOOTSTRAP: "false",
    TIMEZONE: "America/Chicago",
  };
}

async function steadyState(mode, iterations = 2_000) {
  const env = environment();
  let initialized = false;
  const fetchImpl = async (url, init = {}) => {
    const isGo = url === env.OPENCODE_GO_URL;
    const etag = isGo ? '"go-v1"' : '"docs-v1"';
    if (mode === "304" && initialized && init.headers?.["if-none-match"] === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(isGo ? goHtml : docsHtml, {
      status: 200,
      headers: mode === "304" ? { etag } : {},
    });
  };
  await runWatch(env, { fetchImpl, now: new Date("2026-08-19T18:00:00Z") });
  initialized = true;
  const start = performance.now();
  let optimization;
  for (let i = 0; i < iterations; i++) {
    const result = await runWatch(env, { fetchImpl, now: new Date(1_787_162_700_000 + i * 300_000) });
    optimization = result.optimization;
  }
  return { mode, iterations, averageMs: (performance.now() - start) / iterations, optimization };
}

function parserBench(iterations = 10_000) {
  for (let i = 0; i < 100; i++) { parseGoPage(goHtml); parseDocsPage(docsHtml); }
  let start = performance.now();
  for (let i = 0; i < iterations; i++) parseGoPage(goHtml);
  const goMs = (performance.now() - start) / iterations;
  start = performance.now();
  for (let i = 0; i < iterations; i++) parseDocsPage(docsHtml);
  const docsMs = (performance.now() - start) / iterations;
  return { iterations, goMs, docsMs, combinedMs: goMs + docsMs };
}

function telegramBench(iterations = 20_000) {
  const before = { checkedAt: new Date().toISOString(), go: parseGoPage(goHtml), docs: parseDocsPage(docsHtml) };
  const after = structuredClone(before);
  after.docs.requests["GPT 5.6 Luna"].requests5h = 2_300;
  after.docs.requests["GPT 5.6 Luna"].requestsWeek = 5_750;
  after.docs.requests["GPT 5.6 Luna"].requestsMonth = 11_500;
  after.docs.pricing["Grok 4.5"].inputPerM = 2.5;
  after.go.chart.Hy3.requests5h = 35_000;
  const changes = diffSnapshots(before, after);
  for (let i = 0; i < 100; i++) buildChangeMessages(changes, after);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) buildChangeMessages(changes, after);
  return { iterations, changes: changes.length, averageMs: (performance.now() - start) / iterations };
}

const results = {
  runtime: process.version,
  parser: parserBench(),
  steady304: await steadyState("304"),
  steadyFingerprint: await steadyState("fingerprint"),
  telegram: telegramBench(),
};
console.log(JSON.stringify(results, null, 2));
