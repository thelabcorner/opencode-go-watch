import { canonicalMonitoredHtml, extractHtmlTables, normalizeSpace, textContent } from "./html.js";
import { sha256Text } from "./fingerprint.js";

const SNAPSHOT_KEY = "zen:snapshot:v1";
const HOT_KEY = "zen:hot:v1";
const META_KEY = "zen:meta:v1";
const ERROR_KEY = "zen:error:v1";
const SCHEMA = 1;
const ERROR_REMINDER_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60 * 60 * 1000;
const MIN_API_MODELS = 20;
const MIN_ENDPOINT_MODELS = 20;
const MIN_PRICING_ROWS = 20;
const MAX_SHRINK_FRACTION = 0.35;
const TABLE_RE = /<table\b[^>]*>[\s\S]*?<\/table>/gi;

function canonicalHeader(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findTable(tables, requiredHeaders) {
  for (const rows of tables) {
    const headers = rows[0] ?? [];
    if (requiredHeaders.every((needle) => headers.some((header) => canonicalHeader(header).includes(needle)))) return rows;
  }
  return undefined;
}

function parsePrice(value) {
  const source = normalizeSpace(value);
  if (/^free$/i.test(source)) return 0;
  if (!source || source === "-" || source === "—") return null;
  const match = /^\$([\d,.]+)$/.exec(source);
  if (!match) return null;
  const parsed = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalName(value) {
  return normalizeSpace(value).replace(/\([^)]*\)\s*$/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function pricingBaseName(value) {
  return normalizeSpace(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function headingSlice(source, id, nextLevel = 2) {
  const idRe = new RegExp(`\\bid\\s*=\\s*["']${id}["']`, "i");
  const anchor = idRe.exec(source);
  if (!anchor) return "";
  const open = source.lastIndexOf(`<h${nextLevel}`, anchor.index);
  if (open < 0) return "";
  const next = source.indexOf(`<h${nextLevel}`, anchor.index + anchor[0].length);
  return source.slice(open, next >= 0 ? next : source.length);
}

function rowsToEndpoints(rows) {
  /** @type {Record<string, {name:string, modelId:string, endpoint:string, sdk:string}>} */
  const out = {};
  if (!rows) return out;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.[0] || !row?.[1] || row.length < 4) continue;
    const modelId = normalizeSpace(row[1]);
    out[modelId] = { name: normalizeSpace(row[0]), modelId, endpoint: normalizeSpace(row[2]), sdk: normalizeSpace(row[3]) };
  }
  return out;
}

function rowsToPricing(rows) {
  /** @type {Record<string, {inputPerM:number|null, outputPerM:number|null, cachedReadPerM:number|null, cachedWritePerM:number|null, free:boolean}>} */
  const out = {};
  if (!rows) return out;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.[0] || row.length < 5) continue;
    const inputPerM = parsePrice(row[1]);
    const outputPerM = parsePrice(row[2]);
    const cachedReadPerM = parsePrice(row[3]);
    const cachedWritePerM = parsePrice(row[4]);
    const free = inputPerM === 0 && outputPerM === 0 && cachedReadPerM === 0;
    out[normalizeSpace(row[0])] = { inputPerM, outputPerM, cachedReadPerM, cachedWritePerM, free };
  }
  return out;
}

function rowsToDeprecated(rows) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!rows) return out;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row?.[0] && row?.[1]) out[normalizeSpace(row[0])] = normalizeSpace(row[1]);
  }
  return out;
}

function freeNotesFromText(sectionText, endpoints) {
  /** @type {Record<string, string>} */
  const notes = {};
  const match = /The free models:\s*([\s\S]*?)(?:Contact us|Auto-reload|Monthly limits|Deprecated models|$)/i.exec(sectionText);
  if (!match) return notes;
  const lines = match[1].split("\n").map((line) => normalizeSpace(line)).filter(Boolean);
  const endpointList = Object.values(endpoints).sort((a, b) => b.name.length - a.name.length);
  for (const line of lines) {
    const endpoint = endpointList.find((item) => line.toLowerCase().startsWith(item.name.toLowerCase()));
    if (endpoint) notes[endpoint.modelId] = line;
  }
  return notes;
}

function notesFromText(sectionText) {
  /** @type {Record<string, string>} */
  const notes = {};
  const peak = /DeepSeek[^.\n]*Peak hours[^.\n]*\.?/i.exec(sectionText);
  if (peak) notes.deepSeekPeakHours = normalizeSpace(peak[0]);
  const fees = /Credit card fees[^.\n]*\.?/i.exec(sectionText);
  if (fees) notes.cardFees = normalizeSpace(fees[0]);
  const reload = /If your balance goes below \$[\d.]+[^.\n]*\.?/i.exec(sectionText);
  if (reload) notes.autoReload = normalizeSpace(reload[0]);
  return notes;
}

function offersFromText(sectionText) {
  const lines = String(sectionText ?? "").split("\n").map((line) => normalizeSpace(line)).filter(Boolean);
  const offerRe = /\b(?:discount(?:ed)?|promotion|promo|limited[- ]time|introductory|special price|price reduction|\d+(?:\.\d+)?%\s+off)\b/i;
  return [...new Set(lines.filter((line) => offerRe.test(line)))].sort();
}

function semanticFreeIds(endpoints, pricing, freeNotes) {
  const byName = new Map(Object.values(endpoints).map((entry) => [canonicalName(entry.name), entry.modelId]));
  const ids = new Set(Object.keys(freeNotes));
  for (const [label, row] of Object.entries(pricing)) {
    if (!row.free) continue;
    const id = byName.get(canonicalName(pricingBaseName(label)));
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

function stripParsedTables(fragment) {
  TABLE_RE.lastIndex = 0;
  return fragment.replace(TABLE_RE, " ");
}

function normalizeListOrdering(fragment) {
  return String(fragment ?? "").replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (whole, inner) => {
    const items = [];
    const re = /<li\b[^>]*>[\s\S]*?<\/li>/gi;
    let match;
    while ((match = re.exec(inner)) !== null) items.push(match[0]);
    if (items.length < 2) return whole;
    items.sort((a, b) => normalizeSpace(textContent(a)).localeCompare(normalizeSpace(textContent(b))));
    return `<ul>${items.join("")}</ul>`;
  });
}

export function prepareZenDocsPage(html) {
  const source = String(html ?? "");
  const endpointsHtml = headingSlice(source, "endpoints", 2);
  const pricingHtml = headingSlice(source, "pricing", 2);
  if (!endpointsHtml || !pricingHtml) throw new Error("Zen docs parser could not locate Endpoints/Pricing sections");
  const regionHtml = `${endpointsHtml}\n${pricingHtml}`;
  const residualHtml = normalizeListOrdering(stripParsedTables(regionHtml));
  return {
    regionHtml,
    fingerprintSource: regionHtml,
    monitorStructure: canonicalMonitoredHtml(residualHtml, { dropSvg: true, includeText: true }),
  };
}

export function parsePreparedZenDocs(prepared) {
  const tables = extractHtmlTables(prepared.regionHtml);
  const endpointRows = findTable(tables, ["model", "model id", "endpoint", "ai sdk"]);
  const pricingRows = findTable(tables, ["model", "input", "output", "cached read", "cached write"]);
  const deprecatedRows = findTable(tables, ["model", "deprecation date"]);
  const endpoints = rowsToEndpoints(endpointRows);
  const pricing = rowsToPricing(pricingRows);
  const deprecated = rowsToDeprecated(deprecatedRows);
  const sectionText = textContent(prepared.regionHtml);
  const freeNotes = freeNotesFromText(sectionText, endpoints);
  const notes = notesFromText(sectionText);
  const offers = offersFromText(sectionText);
  const freeIds = semanticFreeIds(endpoints, pricing, freeNotes);
  return { endpoints, pricing, deprecated, freeNotes, freeIds, notes, offers, monitorStructure: prepared.monitorStructure };
}

export function parseZenDocs(html) {
  return parsePreparedZenDocs(prepareZenDocsPage(html));
}

export function parseZenModelsApi(text) {
  let parsed;
  try { parsed = JSON.parse(String(text ?? "")); } catch { throw new Error("Zen models API returned invalid JSON"); }
  if (!parsed || !Array.isArray(parsed.data)) throw new Error("Zen models API response is missing data[]");
  const models = parsed.data
    .filter((item) => item && typeof item.id === "string" && item.id.trim())
    .map((item) => ({ id: item.id.trim(), object: typeof item.object === "string" ? item.object : null, ownedBy: typeof item.owned_by === "string" ? item.owned_by : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const extras = parsed.data
    .filter((item) => item && typeof item.id === "string")
    .map((item) => {
      const extra = {};
      for (const [key, value] of Object.entries(item)) {
        if (["id", "object", "created", "owned_by"].includes(key)) continue;
        extra[key] = value;
      }
      return Object.keys(extra).length ? [item.id, extra] : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a?.[0]).localeCompare(String(b?.[0])));
  return { models, modelIds: models.map((item) => item.id), monitorStructure: JSON.stringify(extras) };
}

const SPECIAL_NAMES = Object.freeze({
  "x-preview-f-free": "Ox Alpha Free",
  "mimo-v2.5-free": "MiMo-V2.5 Free",
  "hy3-free": "Hy3 Free",
  "laguna-s-2.1-free": "Laguna S 2.1 Free",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra Free",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning Free",
  "muse-spark-1.2-contributor-free": "Muse Spark 1.2 Contributor Free",
  "big-pickle": "Big Pickle",
});

function humanizeId(id) {
  if (SPECIAL_NAMES[id]) return SPECIAL_NAMES[id];
  return id.split("-").map((part) => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
    .replace(/Gpt/g, "GPT").replace(/Glm/g, "GLM").replace(/Deepseek/g, "DeepSeek").replace(/Minimax/g, "MiniMax");
}

function pricingRowsForName(pricing, name) {
  const wanted = canonicalName(name);
  return Object.entries(pricing).filter(([label]) => canonicalName(pricingBaseName(label)) === wanted).map(([label, row]) => ({ label, ...row }));
}

function freeFromDocs(docs, id, name) {
  if (docs.freeIds.includes(id)) return true;
  return pricingRowsForName(docs.pricing, name).some((row) => row.free);
}

export function buildZenSnapshot(docs, api, checkedAt = new Date().toISOString()) {
  /** @type {Record<string, any>} */
  const models = {};
  for (const entry of api.models) {
    const endpoint = docs.endpoints[entry.id] ?? null;
    const name = endpoint?.name ?? humanizeId(entry.id);
    const pricing = pricingRowsForName(docs.pricing, name);
    models[entry.id] = {
      id: entry.id,
      name,
      free: entry.id.endsWith("-free") || freeFromDocs(docs, entry.id, name),
      endpoint: endpoint?.endpoint ?? null,
      sdk: endpoint?.sdk ?? null,
      documented: Boolean(endpoint),
      ownedBy: entry.ownedBy,
      pricing,
    };
  }
  const apiSet = new Set(api.modelIds);
  const apiOnly = api.modelIds.filter((id) => !docs.endpoints[id]);
  const docsOnly = Object.keys(docs.endpoints).filter((id) => !apiSet.has(id)).sort();
  return { schema: SCHEMA, checkedAt, docs, api, models, consistency: { apiOnly, docsOnly } };
}

export function validateZenSnapshot(snapshot) {
  const apiCount = snapshot?.api?.modelIds?.length ?? 0;
  const endpointCount = Object.keys(snapshot?.docs?.endpoints ?? {}).length;
  const pricingCount = Object.keys(snapshot?.docs?.pricing ?? {}).length;
  if (apiCount < MIN_API_MODELS) throw new Error(`Zen models API found ${apiCount} models; refusing baseline update`);
  if (endpointCount < MIN_ENDPOINT_MODELS) throw new Error(`Zen docs endpoint parser found ${endpointCount} models; refusing baseline update`);
  if (pricingCount < MIN_PRICING_ROWS) throw new Error(`Zen docs pricing parser found ${pricingCount} rows; refusing baseline update`);
  if (!Object.values(snapshot.models ?? {}).some((model) => model.free)) throw new Error("Zen parser found no free models; refusing baseline update");
  return true;
}

function assertTransition(previous, next) {
  if (!previous) return;
  const checks = [
    [previous.api.modelIds.length, next.api.modelIds.length, "Zen API models"],
    [Object.keys(previous.docs.endpoints).length, Object.keys(next.docs.endpoints).length, "Zen docs endpoints"],
    [Object.keys(previous.docs.pricing).length, Object.keys(next.docs.pricing).length, "Zen pricing rows"],
  ];
  for (const [before, after, label] of checks) {
    if (before >= 10 && after < before * (1 - MAX_SHRINK_FRACTION)) throw new Error(`${label} shrank from ${before} to ${after}; refusing suspicious transition`);
  }
}

function percent(before, after) {
  if (typeof before !== "number" || typeof after !== "number" || !Number.isFinite(before) || !Number.isFinite(after) || before === 0) return null;
  return ((after - before) / before) * 100;
}

function firstDifference(before, after, radius = 120) {
  const a = String(before ?? "");
  const b = String(after ?? "");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const start = Math.max(0, i - radius);
  return { before: a.slice(start, Math.min(a.length, i + radius)) || "", after: b.slice(start, Math.min(b.length, i + radius)) || "" };
}

function diffObjectFields(changes, type, key, before, after, fields) {
  for (const field of fields) {
    if ((before?.[field] ?? null) === (after?.[field] ?? null)) continue;
    changes.push({ type, key, field, before: before?.[field] ?? null, after: after?.[field] ?? null, percent: percent(before?.[field], after?.[field]) });
  }
}

export function diffZenSnapshots(previous, next) {
  const changes = [];
  const beforeIds = new Set(previous.api.modelIds);
  const afterIds = new Set(next.api.modelIds);
  for (const id of next.api.modelIds) {
    if (beforeIds.has(id)) continue;
    const model = next.models[id];
    changes.push({ type: model?.free ? "zen_free_model_added" : "zen_model_added", key: id, after: model });
  }
  for (const id of previous.api.modelIds) {
    if (afterIds.has(id)) continue;
    const model = previous.models[id];
    changes.push({ type: model?.free ? "zen_free_model_removed" : "zen_model_removed", key: id, before: model });
  }
  for (const id of next.api.modelIds) {
    if (!beforeIds.has(id)) continue;
    const before = previous.models[id];
    const after = next.models[id];
    if (Boolean(before?.free) !== Boolean(after?.free)) changes.push({ type: after?.free ? "zen_model_became_free" : "zen_model_no_longer_free", key: id, before, after });
    if ((before?.ownedBy ?? null) !== (after?.ownedBy ?? null)) changes.push({ type: "zen_model_owner_changed", key: id, before: before?.ownedBy ?? null, after: after?.ownedBy ?? null });
  }

  const pricingKeys = new Set([...Object.keys(previous.docs.pricing), ...Object.keys(next.docs.pricing)]);
  for (const key of [...pricingKeys].sort()) {
    const before = previous.docs.pricing[key];
    const after = next.docs.pricing[key];
    if (!before) { changes.push({ type: "zen_pricing_row_added", key, after }); continue; }
    if (!after) { changes.push({ type: "zen_pricing_row_removed", key, before }); continue; }
    diffObjectFields(changes, "zen_price_changed", key, before, after, ["inputPerM", "outputPerM", "cachedReadPerM", "cachedWritePerM"]);
  }

  const endpointIds = new Set([...Object.keys(previous.docs.endpoints), ...Object.keys(next.docs.endpoints)]);
  for (const id of [...endpointIds].sort()) {
    const before = previous.docs.endpoints[id];
    const after = next.docs.endpoints[id];
    if (!before) { changes.push({ type: "zen_endpoint_added", key: id, after }); continue; }
    if (!after) { changes.push({ type: "zen_endpoint_removed", key: id, before }); continue; }
    diffObjectFields(changes, "zen_endpoint_changed", id, before, after, ["name", "endpoint", "sdk"]);
  }

  const deprecatedNames = new Set([...Object.keys(previous.docs.deprecated), ...Object.keys(next.docs.deprecated)]);
  for (const name of [...deprecatedNames].sort()) {
    const before = previous.docs.deprecated[name];
    const after = next.docs.deprecated[name];
    if (before == null) changes.push({ type: "zen_deprecation_added", key: name, after });
    else if (after == null) changes.push({ type: "zen_deprecation_removed", key: name, before });
    else if (before !== after) changes.push({ type: "zen_deprecation_changed", key: name, before, after });
  }

  const noteKeys = new Set([...Object.keys(previous.docs.notes), ...Object.keys(next.docs.notes)]);
  for (const key of [...noteKeys].sort()) {
    const before = previous.docs.notes[key] ?? null;
    const after = next.docs.notes[key] ?? null;
    if (before !== after) changes.push({ type: "zen_note_changed", key, before, after });
  }

  const freeNoteIds = new Set([...Object.keys(previous.docs.freeNotes), ...Object.keys(next.docs.freeNotes)]);
  for (const id of [...freeNoteIds].sort()) {
    const before = previous.docs.freeNotes[id] ?? null;
    const after = next.docs.freeNotes[id] ?? null;
    if (before !== after) changes.push({ type: "zen_free_note_changed", key: id, before, after });
  }

  const beforeOffers = new Set(previous.docs.offers ?? []);
  const afterOffers = new Set(next.docs.offers ?? []);
  for (const offer of [...afterOffers].sort()) if (!beforeOffers.has(offer)) changes.push({ type: "zen_offer_added", key: offer, after: offer });
  for (const offer of [...beforeOffers].sort()) if (!afterOffers.has(offer)) changes.push({ type: "zen_offer_removed", key: offer, before: offer });

  for (const field of ["apiOnly", "docsOnly"]) {
    const before = JSON.stringify(previous.consistency?.[field] ?? []);
    const after = JSON.stringify(next.consistency?.[field] ?? []);
    if (before !== after) changes.push({ type: "zen_consistency_changed", key: field, before: previous.consistency?.[field] ?? [], after: next.consistency?.[field] ?? [] });
  }

  const knownDocs = changes.some((change) => change.type !== "zen_consistency_changed" && !["zen_model_added", "zen_model_removed", "zen_free_model_added", "zen_free_model_removed", "zen_model_owner_changed"].includes(change.type));
  if (!knownDocs && previous.docs.monitorStructure !== next.docs.monitorStructure) {
    changes.push({ type: "zen_unclassified_docs_change", source: "zen_docs", ...firstDifference(previous.docs.monitorStructure, next.docs.monitorStructure) });
  }
  const apiSemanticChanged = changes.some((change) => ["zen_model_added", "zen_model_removed", "zen_free_model_added", "zen_free_model_removed", "zen_model_owner_changed"].includes(change.type));
  if (!apiSemanticChanged && previous.api.monitorStructure !== next.api.monitorStructure) {
    changes.push({ type: "zen_unclassified_api_change", source: "zen_api", ...firstDifference(previous.api.monitorStructure, next.api.monitorStructure) });
  }
  return changes;
}

function sourceHeaders(hot) {
  const headers = { accept: "text/html,application/json;q=0.9,*/*;q=0.8" };
  if (hot?.etag) headers["if-none-match"] = hot.etag;
  else if (hot?.lastModified) headers["if-modified-since"] = hot.lastModified;
  return headers;
}

async function fetchSource(url, hot, fetchImpl) {
  const response = await fetchImpl(url, { headers: sourceHeaders(hot) });
  if (response.status === 304) return { unchanged: true, hot, body: null };
  if (!response.ok) throw new Error(`Zen source ${url} returned HTTP ${response.status}`);
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (hot?.etag && etag && hot.etag === etag) {
    try { await response.body?.cancel(); } catch {}
    return { unchanged: true, hot: { ...hot, etag, lastModified }, body: null };
  }
  return { unchanged: false, hot: { etag, lastModified }, body: await response.text() };
}

async function readJson(env, key) {
  return env.STATE ? env.STATE.get(key, { type: "json" }) : null;
}

async function writeMeta(env, meta) {
  if (env.STATE) await env.STATE.put(META_KEY, JSON.stringify(meta));
}

async function maybeHeartbeat(env, now, previousMeta, extra = {}) {
  const last = Date.parse(previousMeta?.lastSuccessAt ?? "");
  if (Number.isFinite(last) && now.getTime() - last < HEARTBEAT_MS) return previousMeta;
  const meta = { ...(previousMeta ?? {}), ...extra, lastSuccessAt: now.toISOString() };
  await writeMeta(env, meta);
  return meta;
}

function hotRecord(sourceState) {
  return { schema: 1, sourceState };
}

export async function readZenSnapshot(env) {
  return readJson(env, SNAPSHOT_KEY);
}

export async function getZenStatus(env) {
  const [snapshot, meta, error] = await Promise.all([readZenSnapshot(env), readJson(env, META_KEY), readJson(env, ERROR_KEY)]);
  return { ok: Boolean(snapshot) && !error, configured: true, snapshot, meta, error };
}

export async function resetZenBaseline(env) {
  if (!env.STATE) return;
  await Promise.all([env.STATE.delete(SNAPSHOT_KEY), env.STATE.delete(HOT_KEY), env.STATE.delete(ERROR_KEY)]);
}

/** @param {any} env @param {any} error @param {{now?:Date, notify?:(error:any, now:Date)=>Promise<any>}} [options] */
export async function recordZenFailure(env, error, options = {}) {
  const { now = new Date(), notify } = options;
  const message = String(error?.message ?? error);
  const previous = await readJson(env, ERROR_KEY);
  const same = previous?.message === message;
  const lastNotified = Date.parse(previous?.lastNotifiedAt ?? "");
  const shouldNotify = !same || !Number.isFinite(lastNotified) || now.getTime() - lastNotified >= ERROR_REMINDER_MS;
  const state = {
    message,
    firstSeenAt: same ? previous.firstSeenAt : now.toISOString(),
    lastSeenAt: now.toISOString(),
    lastNotifiedAt: shouldNotify ? now.toISOString() : previous?.lastNotifiedAt ?? null,
    count: same ? Number(previous?.count ?? 0) + 1 : 1,
  };
  if (env.STATE) await env.STATE.put(ERROR_KEY, JSON.stringify(state));
  if (shouldNotify && notify) await notify(error, now);
  return { ok: false, notified: shouldNotify, error: state };
}

/** @param {any} env @param {{fetchImpl?:(input:any, init?:any)=>Promise<Response>, now?:Date, notifyChanges?:(changes:any[], snapshot:any, now:Date)=>Promise<any>, notifyBootstrap?:(snapshot:any, now:Date)=>Promise<any>, notifyRecovery?:(error:any, now:Date)=>Promise<any>}} [options] */
export async function runZenWatch(env, options = {}) {
  const { fetchImpl = fetch, now = new Date(), notifyChanges, notifyBootstrap, notifyRecovery } = options;
  if (!env.STATE) throw new Error("STATE KV binding is not configured");
  const docsUrl = env.OPENCODE_ZEN_DOCS_URL || "https://opencode.ai/docs/zen/";
  const apiUrl = env.OPENCODE_ZEN_MODELS_URL || "https://opencode.ai/zen/v1/models";
  const [hot, previousMeta, priorError] = await Promise.all([readJson(env, HOT_KEY), readJson(env, META_KEY), readJson(env, ERROR_KEY)]);
  const [docsFetch, apiFetch] = await Promise.all([
    fetchSource(docsUrl, hot?.sourceState?.docs, fetchImpl),
    fetchSource(apiUrl, hot?.sourceState?.api, fetchImpl),
  ]);

  if (docsFetch.unchanged && apiFetch.unchanged) {
    await maybeHeartbeat(env, now, previousMeta, { optimization: "304" });
    if (priorError) {
      if (notifyRecovery) await notifyRecovery(priorError, now);
      await env.STATE.delete(ERROR_KEY);
    }
    return { status: "unchanged", changes: [], snapshot: null, optimization: "304", recoveredFrom: priorError ?? null };
  }

  let docsPrepared = null;
  let docsFingerprint = hot?.sourceState?.docs?.fingerprint ?? null;
  let docsChanged = !docsFetch.unchanged;
  if (docsChanged) {
    docsPrepared = prepareZenDocsPage(docsFetch.body);
    docsFingerprint = await sha256Text(docsPrepared.fingerprintSource);
    if (docsFingerprint === hot?.sourceState?.docs?.fingerprint) docsChanged = false;
  }

  let apiFingerprint = hot?.sourceState?.api?.fingerprint ?? null;
  let apiChanged = !apiFetch.unchanged;
  if (apiChanged) {
    apiFingerprint = await sha256Text(apiFetch.body);
    if (apiFingerprint === hot?.sourceState?.api?.fingerprint) apiChanged = false;
  }

  const nextHot = hotRecord({
    docs: { ...docsFetch.hot, fingerprint: docsFingerprint },
    api: { ...apiFetch.hot, fingerprint: apiFingerprint },
  });

  if (!docsChanged && !apiChanged) {
    await env.STATE.put(HOT_KEY, JSON.stringify(nextHot));
    await maybeHeartbeat(env, now, previousMeta, { optimization: "fingerprint" });
    if (priorError) {
      if (notifyRecovery) await notifyRecovery(priorError, now);
      await env.STATE.delete(ERROR_KEY);
    }
    return { status: "unchanged", changes: [], snapshot: null, optimization: "fingerprint", recoveredFrom: priorError ?? null };
  }

  const previous = await readZenSnapshot(env);
  let docs = docsChanged ? parsePreparedZenDocs(docsPrepared) : previous?.docs;
  let api = apiChanged ? parseZenModelsApi(apiFetch.body) : previous?.api;
  if (!docs || !api) {
    if (!docsChanged && docsFetch.body == null) throw new Error("Zen docs baseline missing while source reported unchanged");
    if (!apiChanged && apiFetch.body == null) throw new Error("Zen API baseline missing while source reported unchanged");
    if (!docs) docs = parsePreparedZenDocs(docsPrepared ?? prepareZenDocsPage(docsFetch.body));
    if (!api) api = parseZenModelsApi(apiFetch.body);
  }

  const next = buildZenSnapshot(docs, api, now.toISOString());
  validateZenSnapshot(next);
  assertTransition(previous, next);

  if (!previous) {
    if (notifyBootstrap) await notifyBootstrap(next, now);
    await Promise.all([
      env.STATE.put(SNAPSHOT_KEY, JSON.stringify(next)),
      env.STATE.put(HOT_KEY, JSON.stringify(nextHot)),
      writeMeta(env, { lastSuccessAt: now.toISOString(), lastChangeAt: null, lastChangeCount: 0, optimization: "bootstrap" }),
      env.STATE.delete(ERROR_KEY),
    ]);
    return { status: "bootstrapped", changes: [], snapshot: next, optimization: "bootstrap", recoveredFrom: priorError ?? null };
  }

  const changes = diffZenSnapshots(previous, next);
  if (changes.length) {
    if (notifyChanges) await notifyChanges(changes, next, now);
    if (priorError && notifyRecovery) await notifyRecovery(priorError, now);
    await Promise.all([
      env.STATE.put(SNAPSHOT_KEY, JSON.stringify(next)),
      env.STATE.put(HOT_KEY, JSON.stringify(nextHot)),
      writeMeta(env, { lastSuccessAt: now.toISOString(), lastChangeAt: now.toISOString(), lastChangeCount: changes.length, optimization: docsChanged && apiChanged ? "both" : docsChanged ? "docs" : "api" }),
      env.STATE.delete(ERROR_KEY),
    ]);
    return { status: "changed", changes, snapshot: next, optimization: docsChanged && apiChanged ? "both" : docsChanged ? "docs" : "api", recoveredFrom: priorError ?? null };
  }

  await env.STATE.put(HOT_KEY, JSON.stringify(nextHot));
  await maybeHeartbeat(env, now, previousMeta, { optimization: docsChanged && apiChanged ? "both-no-semantic" : docsChanged ? "docs-no-semantic" : "api-no-semantic" });
  if (priorError) {
    if (notifyRecovery) await notifyRecovery(priorError, now);
    await env.STATE.delete(ERROR_KEY);
  }
  return { status: "unchanged", changes: [], snapshot: next, optimization: "semantic-equal", recoveredFrom: priorError ?? null };
}

export const zenKeys = Object.freeze({ snapshot: SNAPSHOT_KEY, hot: HOT_KEY, meta: META_KEY, error: ERROR_KEY });
