import { diffSnapshots } from "./diff.js";
import { sha256Text } from "./fingerprint.js";
import {
  parsePreparedDocsPage,
  parsePreparedGoPage,
  prepareDocsPage,
  prepareGoPage,
} from "./parsers.js";
import {
  buildBootMessage,
  buildChangeMessages,
  buildErrorMessage,
  buildRecoveryMessage,
  sendTelegram,
  telegramConfigured,
} from "./telegram.js";

const SNAPSHOT_KEY = "snapshot:v1";
const META_KEY = "meta:v1";
const ERROR_KEY = "error:v1";
const SNAPSHOT_SCHEMA = 2;
const ERROR_REPEAT_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60 * 60 * 1000;
const MAX_PAGE_BYTES = 5_000_000;

function countKeys(value) {
  return value ? Object.keys(value).length : 0;
}

export function validateSnapshot(snapshot) {
  const errors = [];
  const chartCount = countKeys(snapshot.go?.chart);
  const requestCount = countKeys(snapshot.docs?.requests);
  const pricingCount = countKeys(snapshot.docs?.pricing);
  const profileCount = countKeys(snapshot.docs?.profiles);

  if (chartCount < 5) errors.push(`chart parser found ${chartCount} models; refusing baseline update`);
  if (requestCount < 10) errors.push(`docs request table found ${requestCount} models; refusing baseline update`);
  if (pricingCount < 10) errors.push(`docs pricing table found ${pricingCount} rows; refusing baseline update`);
  if (profileCount < 8) errors.push(`docs request profiles found ${profileCount} models; refusing baseline update`);
  if (countKeys(snapshot.docs?.limits) !== 3) errors.push("docs dollar limits are incomplete");

  for (const [name, row] of Object.entries(snapshot.docs?.requests ?? {})) {
    for (const field of ["requests5h", "requestsWeek", "requestsMonth"]) {
      if (!Number.isSafeInteger(row[field]) || row[field] <= 0) errors.push(`${name}.${field} is invalid`);
    }
    if (row.requestsWeek < row.requests5h) errors.push(`${name}: weekly estimate is below 5-hour estimate`);
    if (row.requestsMonth < row.requestsWeek) errors.push(`${name}: monthly estimate is below weekly estimate`);
  }

  if (errors.length) throw new Error(`Snapshot validation failed: ${errors.join("; ")}`);
}

function validatorHeaders(previousSource) {
  if (!previousSource?.fingerprint) return {};
  if (previousSource.etag) return { "if-none-match": previousSource.etag };
  if (previousSource.lastModified) return { "if-modified-since": previousSource.lastModified };
  return {};
}

async function fetchPage(url, fetchImpl, previousSource) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "opencode-go-watch/1.1 (+https://github.com/thelabcorner/opencode-go-watch)",
      "cache-control": "no-cache",
      pragma: "no-cache",
      ...validatorHeaders(previousSource),
    },
    cf: { cacheTtl: 0, cacheEverything: false },
    signal: AbortSignal.timeout(15_000),
  });

  const etag = response.headers.get("etag") || previousSource?.etag || null;
  const lastModified = etag ? null : response.headers.get("last-modified") || previousSource?.lastModified || null;

  if (response.status === 304) {
    if (!previousSource?.fingerprint) throw new Error(`Fetch ${url} returned 304 without a reusable baseline fingerprint`);
    return { kind: "not-modified", etag, lastModified };
  }
  if (!response.ok) throw new Error(`Fetch ${url} failed with HTTP ${response.status}`);

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    throw new Error(`Fetch ${url} declared ${declared.toLocaleString()} bytes; refusing oversized page`);
  }

  const body = await response.text();
  if (!body.trim()) throw new Error(`Fetch ${url} returned an empty body`);
  if (body.length > MAX_PAGE_BYTES) throw new Error(`Fetch ${url} returned ${body.length.toLocaleString()} bytes; refusing oversized page`);
  return { kind: "body", body, etag, lastModified };
}

function sameSourceState(a, b) {
  return Boolean(a && b)
    && a.fingerprint === b.fingerprint
    && a.etag === b.etag
    && a.lastModified === b.lastModified;
}

async function resolveSource({ response, previousSource, previousSemantic, prepare, parse }) {
  if (response.kind === "not-modified") {
    return {
      semantic: previousSemantic,
      sourceState: {
        fingerprint: previousSource.fingerprint,
        etag: response.etag,
        lastModified: response.lastModified,
      },
      mode: "304",
    };
  }

  const prepared = prepare(response.body);
  const fingerprint = await sha256Text(prepared.fingerprintSource);
  const sourceState = { fingerprint, etag: response.etag, lastModified: response.lastModified };
  if (previousSource?.fingerprint === fingerprint && previousSemantic) {
    return { semantic: previousSemantic, sourceState, mode: "fingerprint" };
  }
  return { semantic: parse(prepared), sourceState, mode: "parsed" };
}

export async function collectSnapshot(env, fetchImpl = fetch, now = new Date(), previous = null) {
  const goUrl = env.OPENCODE_GO_URL || "https://opencode.ai/go";
  const docsUrl = env.OPENCODE_DOCS_URL || "https://opencode.ai/docs/go/";
  const reusable = previous?.schema === SNAPSHOT_SCHEMA && previous?.go && previous?.docs;
  const previousGoSource = reusable ? previous.sourceState?.go ?? null : null;
  const previousDocsSource = reusable ? previous.sourceState?.docs ?? null : null;

  const [goResponse, docsResponse] = await Promise.all([
    fetchPage(goUrl, fetchImpl, previousGoSource),
    fetchPage(docsUrl, fetchImpl, previousDocsSource),
  ]);

  const [goResolved, docsResolved] = await Promise.all([
    resolveSource({
      response: goResponse,
      previousSource: previousGoSource,
      previousSemantic: reusable ? previous.go : null,
      prepare: prepareGoPage,
      parse: parsePreparedGoPage,
    }),
    resolveSource({
      response: docsResponse,
      previousSource: previousDocsSource,
      previousSemantic: reusable ? previous.docs : null,
      prepare: prepareDocsPage,
      parse: parsePreparedDocsPage,
    }),
  ]);

  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    checkedAt: now.toISOString(),
    sources: { go: goUrl, docs: docsUrl },
    sourceState: { go: goResolved.sourceState, docs: docsResolved.sourceState },
    go: goResolved.semantic,
    docs: docsResolved.semantic,
  };
  validateSnapshot(snapshot);

  return {
    snapshot,
    optimization: { go: goResolved.mode, docs: docsResolved.mode },
    semanticDirty: !previous || goResolved.mode === "parsed" || docsResolved.mode === "parsed" || previous.schema !== SNAPSHOT_SCHEMA,
    sourceStateDirty: !previous
      || !sameSourceState(previous.sourceState?.go, goResolved.sourceState)
      || !sameSourceState(previous.sourceState?.docs, docsResolved.sourceState),
  };
}

export async function readSnapshot(env) {
  return env.STATE.get(SNAPSHOT_KEY, { type: "json" });
}

export function validateTransition(previous, snapshot) {
  if (!previous) return;
  /** @type {Array<[string, number, number, number, number]>} */
  const checks = [
    ["chart", countKeys(previous.go?.chart), countKeys(snapshot.go?.chart), 0.60, 4],
    ["docs request table", countKeys(previous.docs?.requests), countKeys(snapshot.docs?.requests), 0.40, 5],
    ["docs pricing table", countKeys(previous.docs?.pricing), countKeys(snapshot.docs?.pricing), 0.50, 8],
    ["docs request profiles", countKeys(previous.docs?.profiles), countKeys(snapshot.docs?.profiles), 0.50, 5],
  ];

  for (const [label, before, after, maxDropFraction, minDrop] of checks) {
    if (!before || after >= before) continue;
    const drop = before - after;
    const fraction = drop / before;
    if (drop >= minDrop && fraction > maxDropFraction) {
      throw new Error(`Suspicious ${label} shrink: ${before} → ${after} (${Math.round(fraction * 100)}% removed); refusing baseline update`);
    }
  }
}

export async function resetBaseline(env) {
  await Promise.all([
    env.STATE.delete(SNAPSHOT_KEY),
    env.STATE.delete(ERROR_KEY),
  ]);
  await writeMeta(env, {
    baselineResetAt: new Date().toISOString(),
    lastChangeCount: 0,
  });
}

async function readMeta(env) {
  return (await env.STATE.get(META_KEY, { type: "json" })) ?? {};
}

async function writeMeta(env, patch) {
  const current = await readMeta(env);
  await env.STATE.put(META_KEY, JSON.stringify({ ...current, ...patch }));
}

async function maybeHeartbeat(env, checkedAt) {
  const meta = await readMeta(env);
  const last = new Date(meta.lastHeartbeatAt ?? 0).getTime();
  const now = new Date(checkedAt).getTime();
  if (Number.isFinite(last) && now - last < HEARTBEAT_MS) return;
  await env.STATE.put(META_KEY, JSON.stringify({ ...meta, lastSuccessAt: checkedAt, lastHeartbeatAt: checkedAt }));
}

export async function runWatch(env, { fetchImpl = fetch, now = new Date(), forceNotify = false } = {}) {
  // Read the existing baseline before network fetches so HTTP validators can turn
  // the steady-state path into two 304 responses and zero HTML parsing.
  const [previous, previousError] = await Promise.all([
    readSnapshot(env),
    env.STATE.get(ERROR_KEY, { type: "json" }),
  ]);
  const collected = await collectSnapshot(env, fetchImpl, now, previous);
  const { snapshot, optimization } = collected;
  const timeZone = env.TIMEZONE || "America/Chicago";

  if (!previous) {
    const notifyBootstrap = String(env.NOTIFY_ON_BOOTSTRAP ?? "true").toLowerCase() !== "false";
    if (notifyBootstrap || forceNotify) await sendTelegram(env, buildBootMessage(snapshot, timeZone), fetchImpl);
    await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    await writeMeta(env, {
      lastSuccessAt: snapshot.checkedAt,
      lastHeartbeatAt: snapshot.checkedAt,
      lastChangeAt: null,
      lastChangeCount: 0,
      bootstrappedAt: snapshot.checkedAt,
    });
    if (previousError) await env.STATE.delete(ERROR_KEY);
    return { status: "bootstrapped", changes: [], snapshot, optimization };
  }

  let changes = [];
  if (collected.semanticDirty) {
    validateTransition(previous, snapshot);
    changes = diffSnapshots(previous, snapshot);
  }

  if (changes.length) {
    const messages = buildChangeMessages(changes, snapshot, timeZone);
    for (const message of messages) await sendTelegram(env, message, fetchImpl);
    await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    await writeMeta(env, {
      lastSuccessAt: snapshot.checkedAt,
      lastHeartbeatAt: snapshot.checkedAt,
      lastChangeAt: snapshot.checkedAt,
      lastChangeCount: changes.length,
    });
  } else {
    if (forceNotify) {
      const manual = buildBootMessage(snapshot, timeZone)
        .replace("OPENCODE GO WATCH · ARMED", "OPENCODE GO WATCH · MANUAL CHECK")
        .replace("Baseline captured. Semantic monitoring is live.", "No semantic changes detected. Current pages parse cleanly.");
      await sendTelegram(env, manual, fetchImpl);
    }

    // Persist new validators/fingerprints only if they actually changed. Normal
    // five-minute checks therefore perform no snapshot KV write.
    if (collected.sourceStateDirty) await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    await maybeHeartbeat(env, snapshot.checkedAt);
  }

  if (previousError) {
    await sendTelegram(env, buildRecoveryMessage(previousError, snapshot, timeZone), fetchImpl);
    await env.STATE.delete(ERROR_KEY);
  }

  return { status: changes.length ? "changed" : "unchanged", changes, snapshot, optimization };
}

function fingerprintError(error) {
  return String(error?.message ?? error).slice(0, 500);
}

export async function recordFailure(env, error, { fetchImpl = fetch, now = new Date() } = {}) {
  const checkedAt = now.toISOString();
  const message = fingerprintError(error);
  const prior = await env.STATE.get(ERROR_KEY, { type: "json" });
  const sameError = prior?.message === message;
  const lastNotified = new Date(prior?.lastNotifiedAt ?? 0).getTime();
  const shouldNotify = !sameError || !Number.isFinite(lastNotified) || now.getTime() - lastNotified >= ERROR_REPEAT_MS;

  let record = {
    message,
    firstSeenAt: sameError ? prior.firstSeenAt : checkedAt,
    lastSeenAt: checkedAt,
    lastNotifiedAt: sameError ? prior?.lastNotifiedAt ?? null : null,
  };
  await env.STATE.put(ERROR_KEY, JSON.stringify(record));
  await writeMeta(env, { lastFailureAt: checkedAt, lastFailure: message });

  let notificationError = null;
  let notified = false;
  if (shouldNotify) {
    try {
      const sent = await sendTelegram(env, buildErrorMessage(error, checkedAt, env.TIMEZONE || "America/Chicago"), fetchImpl);
      notified = !sent.skipped;
      if (notified) {
        record = { ...record, lastNotifiedAt: checkedAt };
        await env.STATE.put(ERROR_KEY, JSON.stringify(record));
      }
    } catch (sendError) {
      notificationError = String(sendError?.message ?? sendError);
    }
  }

  return { status: "error", notified, error: message, ...(notificationError ? { notificationError } : {}) };
}

export async function getStatus(env) {
  const [meta, snapshot, error] = await Promise.all([
    env.STATE.get(META_KEY, { type: "json" }),
    env.STATE.get(SNAPSHOT_KEY, { type: "json" }),
    env.STATE.get(ERROR_KEY, { type: "json" }),
  ]);
  return {
    ok: !error,
    configured: await telegramConfigured(env),
    meta: meta ?? null,
    error: error ?? null,
    snapshot: snapshot ?? null,
  };
}
