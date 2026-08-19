import { readFile, writeFile } from "node:fs/promises";

const root = process.cwd();
async function edit(path, transform) {
  const full = `${root}/${path}`;
  const before = await readFile(full, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${path}: transformation made no change`);
  await writeFile(full, after);
}
function requireIncludes(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Missing ${label}`);
}
function insertBefore(source, marker, insertion, label) {
  requireIncludes(source, marker, label);
  return source.replace(marker, `${insertion}${marker}`);
}
function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing ${label} start`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Missing ${label} end`);
  return source.slice(0, start) + replacement + source.slice(end);
}
function appendOnce(source, sentinel, addition) {
  if (source.includes(sentinel)) throw new Error(`Already contains ${sentinel}`);
  return `${source.trimEnd()}\n\n${addition.trim()}\n`;
}

await edit("src/html.js", (source) => {
  const marker = "export function decodeHtml(value) {";
  const helper = String.raw`
const MONITOR_TOKEN_RE = /<\/?[A-Za-z][^>]*>|[^<]+/g;
const MONITOR_ATTR_RE = /([:@A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>&#96;]+)))?/g;
const MONITOR_COMMENT_RE = /<!--[\s\S]*?-->/g;
const MONITOR_SVG_RE = /<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi;
const MONITOR_NOISE_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const MONITOR_NOISE_ATTRS = new Set([
  "class", "style", "id", "role", "tabindex", "aria-hidden",
  "data-slot", "data-visible", "data-component", "data-hk", "data-hydrate", "data-hydration",
]);

function canonicalAttributeValue(value) {
  return normalizeSpace(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Noise-normalized representation used only after a monitored body changed. */
export function canonicalMonitoredHtml(fragment, { dropSvg = false, includeText = true } = {}) {
  let source = String(fragment ?? "");
  source = source.replace(MONITOR_COMMENT_RE, " ").replace(MONITOR_NOISE_BLOCK_RE, " ");
  if (dropSvg) source = source.replace(MONITOR_SVG_RE, " ");
  const out = [];
  MONITOR_TOKEN_RE.lastIndex = 0;
  let token;
  while ((token = MONITOR_TOKEN_RE.exec(source)) !== null) {
    const raw = token[0];
    if (!raw.startsWith("<")) {
      if (!includeText) continue;
      const text = normalizeSpace(raw);
      if (text) out.push(text);
      continue;
    }
    const closing = /^<\s*\//.test(raw);
    const nameMatch = /^<\s*\/?\s*([A-Za-z][\w:-]*)/.exec(raw);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (closing) { out.push(__BT__</${name}>__BT__); continue; }
    const attrs = [];
    const attrSource = raw.slice(nameMatch[0].length, raw.length - 1);
    MONITOR_ATTR_RE.lastIndex = 0;
    let attr;
    while ((attr = MONITOR_ATTR_RE.exec(attrSource)) !== null) {
      const attrName = attr[1].toLowerCase();
      if (MONITOR_NOISE_ATTRS.has(attrName) || attrName.startsWith("on")) continue;
      const rawValue = attr[2] ?? attr[3] ?? attr[4];
      attrs.push(rawValue == null ? attrName : __BT__${attrName}="${canonicalAttributeValue(rawValue)}"__BT__);
    }
    attrs.sort();
    out.push(__BT__<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>__BT__);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

`.replaceAll("__BT__", "`");
  return insertBefore(source, marker, helper, "decodeHtml marker");
});

await edit("src/parsers.js", (source) => {
  source = source.replace(
    'import { extractHtmlTables, extractSectionHtml, normalizeSpace, textContent } from "./html.js";',
    'import { canonicalMonitoredHtml, extractHtmlTables, extractSectionHtml, normalizeSpace, textContent } from "./html.js";',
  );
  requireIncludes(source, "canonicalMonitoredHtml", "canonicalMonitoredHtml import");

  const monitorHelpers = String.raw`
function balancedSpanEnd(source, start) {
  const re = /<\/?span\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (/^<\s*\//.test(match[0])) depth--;
    else depth++;
    if (depth === 0) return re.lastIndex;
  }
  return -1;
}
function buildGoMonitorStructure(chartHtml) {
  const items = [], ranges = [];
  ITEM_START_RE.lastIndex = 0;
  let match;
  while ((match = ITEM_START_RE.exec(chartHtml)) !== null) {
    const end = balancedSpanEnd(chartHtml, match.index);
    if (end < 0) continue;
    ranges.push([match.index, end]);
    items.push(canonicalMonitoredHtml(chartHtml.slice(match.index, end), { dropSvg: true, includeText: true }));
    ITEM_START_RE.lastIndex = end;
  }
  items.sort();
  let rest = "", cursor = 0;
  for (const [start, end] of ranges) { rest += chartHtml.slice(cursor, start); cursor = end; }
  rest += chartHtml.slice(cursor);
  const shell = canonicalMonitoredHtml(rest, { dropSvg: true, includeText: true });
  return __BT__${shell}\n--items--\n${items.join("\n")}__BT__.trim();
}
`.replaceAll("__BT__", "`");
  source = insertBefore(source, "export function prepareGoPage(html)", `${monitorHelpers}\n`, "prepareGoPage marker");

  const newPrepareGo = String.raw`export function prepareGoPage(html){const source=String(html??""),g=graphSlice(source),end=g.chartStart>=0?g.chartStart:source.length,start=Math.max(0,end-MAX_PROMO_PREFIX),promoBanner=parsePromoBannerText(textContent(source.slice(start,end))),monitorStructure=buildGoMonitorStructure(g.chartHtml);return{chartHtml:g.chartHtml,promoBanner,monitorStructure,fingerprintSource:__BT__${g.chartHtml}\n<!--promo:${promoBanner??""}-->__BT__};}`.replaceAll("__BT__", "`");
  source = replaceBetween(source, "export function prepareGoPage(html)", "\nfunction parseItemSegment", newPrepareGo, "prepareGoPage");
  source = source.replace(
    "return{chart,promoBanner:prepared.promoBanner};}",
    "return{chart,promoBanner:prepared.promoBanner,monitorStructure:prepared.monitorStructure};}",
  );
  requireIncludes(source, "monitorStructure:prepared.monitorStructure", "Go monitorStructure return");

  const newPrepareDocs = 'export function prepareDocsPage(html){const source=String(html??""),usageHtml=extractSectionHtml(source,"Usage\\\\s+limits")||source,monitorStructure=canonicalMonitoredHtml(usageHtml,{includeText:false});return{usageHtml,monitorStructure,fingerprintSource:usageHtml};}';
  source = replaceBetween(source, "export function prepareDocsPage(html)", "\nexport function parsePreparedDocsPage", newPrepareDocs, "prepareDocsPage");
  source = source.replace(
    'usageText:usageText.replace(/\\s+/g," ").trim()};',
    'usageText:usageText.replace(/\\s+/g," ").trim(),monitorStructure:prepared.monitorStructure};',
  );
  requireIncludes(source, "monitorStructure:prepared.monitorStructure", "Docs monitorStructure return");
  return source;
});

await edit("src/diff.js", (source) => {
  const sets = `\nconst GO_CHANGE_TYPES = new Set(["chart_model_added", "chart_model_removed", "chart_changed", "promo_banner_changed"]);\nconst DOCS_CHANGE_TYPES = new Set([\n  "global_limit_changed", "model_added", "model_removed", "request_limit_changed",\n  "request_profile_added", "request_profile_removed", "request_profile_changed",\n  "pricing_row_added", "pricing_row_removed", "pricing_changed",\n  "usage_note_added", "usage_note_removed", "usage_note_changed", "usage_copy_changed",\n]);\n`;
  source = source.replace('import { deriveConsistency } from "./parsers.js";\n', `import { deriveConsistency } from "./parsers.js";\n${sets}`);
  source = source.replace('function compactTextDelta(before = "", after = "", width = 220) {', 'function compactTextDelta(before = "", after = "", width = 420) {');
  const helper = String.raw`
function compactStructureDelta(before = "", after = "", width = 420) {
  const tokenize = (value) => (String(value ?? "").match(/<[^>]+>|[^<>\n]+/g) ?? [])
    .map((token) => token.replace(/\s+/g, " ").trim()).filter(Boolean);
  const counts = (tokens) => { const map = new Map(); for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1); return map; };
  const beforeCounts = counts(tokenize(before)), afterCounts = counts(tokenize(after));
  const removed = [], added = [];
  for (const [token, count] of beforeCounts) for (let i = 0, n = count - (afterCounts.get(token) ?? 0); i < n; i++) removed.push(token);
  for (const [token, count] of afterCounts) for (let i = 0, n = count - (beforeCounts.get(token) ?? 0); i < n; i++) added.push(token);
  const clip = (tokens) => { const text = tokens.join(" | "); return text.length > width ? __BT__${text.slice(0, width - 1)}…__BT__ : text; };
  return { before: clip(removed), after: clip(added) };
}

`.replaceAll("__BT__", "`");
  source = insertBefore(source, "function diffConsistency", helper, "diffConsistency marker");
  const oldTail = `  const structural = changes.filter((change) => !["consistency_mismatch", "consistency_resolved"].includes(change.type)).length;\n  if (structural === 0 && before.docs.usageText !== after.docs.usageText) {\n    changes.push({ type: "usage_copy_changed", ...compactTextDelta(before.docs.usageText, after.docs.usageText) });\n  }\n\n  return changes;`;
  const newTail = `  const docsKnownBeforeCopy = changes.some((change) => DOCS_CHANGE_TYPES.has(change.type));\n  if (!docsKnownBeforeCopy && before.docs.usageText !== after.docs.usageText) {\n    changes.push({ type: "usage_copy_changed", source: "docs", ...compactTextDelta(before.docs.usageText, after.docs.usageText) });\n  }\n\n  const goKnown = changes.some((change) => GO_CHANGE_TYPES.has(change.type));\n  if (!goKnown && typeof before.go.monitorStructure === "string" && typeof after.go.monitorStructure === "string" && before.go.monitorStructure !== after.go.monitorStructure) {\n    changes.push({ type: "unclassified_source_change", source: "go", ...compactStructureDelta(before.go.monitorStructure, after.go.monitorStructure) });\n  }\n  const docsKnown = changes.some((change) => DOCS_CHANGE_TYPES.has(change.type));\n  if (!docsKnown && typeof before.docs.monitorStructure === "string" && typeof after.docs.monitorStructure === "string" && before.docs.monitorStructure !== after.docs.monitorStructure) {\n    changes.push({ type: "unclassified_source_change", source: "docs", ...compactStructureDelta(before.docs.monitorStructure, after.docs.monitorStructure) });\n  }\n\n  return changes;`;
  requireIncludes(source, oldTail, "old diff tail");
  return source.replace(oldTail, newTail);
});

await edit("src/telegram.js", (source) => {
  const oldCase = `      case "usage_copy_changed":\n        blocks.push(\`📝 <b>USAGE SECTION WORDING CHANGED</b>\\n<b>Before</b> <code>\${escapeHtml(change.before || "…")}</code>\\n<b>After</b> <code>\${escapeHtml(change.after || "…")}</code>\`);\n        break;\n      default:`;
  const newCase = `      case "usage_copy_changed":\n        blocks.push(\`📝 <b>USAGE SECTION WORDING CHANGED</b>\\n<b>Before</b> <code>\${escapeHtml(change.before || "…")}</code>\\n<b>After</b> <code>\${escapeHtml(change.after || "…")}</code>\`);\n        break;\n      case "unclassified_source_change": {\n        const surface = change.source === "go" ? "Go usage chart" : "Usage docs";\n        blocks.push([\n          \`🟡 <b>UNCLASSIFIED MONITORED CHANGE</b>\`,\n          \`<b>\${surface}</b>\`,\n          "The monitored surface changed, but all semantic fields the watcher currently knows about stayed the same.",\n          "",\n          \`<b>Before</b> <code>\${escapeHtml(change.before || "(nothing at this position)")}</code>\`,\n          \`<b>After</b> <code>\${escapeHtml(change.after || "(nothing at this position)")}</code>\`,\n        ].join("\\n"));\n        break;\n      }\n      default:`;
  requireIncludes(source, oldCase, "usage_copy switch case");
  source = source.replace(oldCase, newCase);
  const headline = 'function headlineFor(changes) {\n  const types = new Set(changes.map((change) => change.type));\n';
  requireIncludes(source, headline, "headlineFor");
  return source.replace(headline, `${headline}  if (types.has("unclassified_source_change")) return "🟡 <b>OPENCODE GO · UNCLASSIFIED CHANGE</b>";\n`);
});

await edit("src/watcher.js", (source) => {
  requireIncludes(source, "const SNAPSHOT_SCHEMA = 2;", "snapshot schema 2");
  return source.replace("const SNAPSHOT_SCHEMA = 2;", "const SNAPSHOT_SCHEMA = 3;");
});

await edit("src/types.js", (source) => source
  .replace("notes:Record<string,string>, usageText:string}", "notes:Record<string,string>, usageText:string, monitorStructure:string}")
  .replace("promoBanner:string|null, chart:Record<string, ChartRow>}", "promoBanner:string|null, chart:Record<string, ChartRow>, monitorStructure:string}")
  .replace("@typedef {{schema:1,", "@typedef {{schema:3,"));

await edit("test/parsers.test.js", (source) => appendOnce(source, "unknown chart attributes alter the fallback", String.raw`
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
`));

await edit("test/diff.test.js", (source) => appendOnce(source, "emits an unclassified fallback", String.raw`
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
`));

await edit("test/watcher.test.js", (source) => {
  const marker = 'test("steady-state conditional requests hit the 304 zero-parse fast path", async () => {';
  const addition = String.raw`
test("unknown monitored chart changes are surfaced through Telegram", async () => {
  const e = env();
  await runWatch(e, { fetchImpl: makeFetch(), now: new Date("2026-08-19T18:00:00Z") });
  const changedGo = goHtml.replace('data-model="hy3"', 'data-model="hy3" data-context-window="1m"');
  const telegram = [];
  const result = await runWatch(e, { fetchImpl: makeFetch({ go: changedGo, telegram }), now: new Date("2026-08-19T18:05:00Z") });
  assert.equal(result.status, "changed");
  assert(result.changes.some((change) => change.type === "unclassified_source_change" && change.source === "go"));
  assert.equal(telegram.length, 1);
  assert.match(telegram[0].text, /UNCLASSIFIED MONITORED CHANGE/);
  assert.match(telegram[0].text, /data-context-window/);
});

`;
  return insertBefore(source, marker, addition, "watcher hot-path test marker");
});

console.log("Applied unknown-change fallback changes.");
