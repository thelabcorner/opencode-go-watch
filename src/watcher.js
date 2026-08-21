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
const HOT_KEY = "hot:v1";
const META_KEY = "meta:v1";
const ERROR_KEY = "error:v1";
const SNAPSHOT_SCHEMA = 4;
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
    if (row.unlimited === true) {
      for (const field of ["requests5h", "requestsWeek", "requestsMonth"]) {
        if (row[field] != null) errors.push(`${name}.${field} must be null for an unlimited/quota-exempt model`);
      }
      continue;
    }
    for (const field of ["requests5h", "requestsWeek", "requestsMonth"]) {
      if (!Number.isSafeInteger(row[field]) || row[field] <= 0) errors.push(`${name}.${field} is invalid`);
    }
    if (row.requestsWeek < row.requests5h) errors.push(`${name}: weekly estimate is below 5-hour estimate`);
    if (row.requestsMonth < row.requestsWeek) errors.push(`${name}: monthly estimate is below weekly estimate`);
  }

  for (const [name, row] of Object.entries(snapshot.go?.chart ?? {})) {
    if (row.unlimited === true) {
      if (row.requests5h != null) errors.push(`${name}.requests5h must be null for an infinite Go-chart entry`);
    } else if (!Number.isSafeInteger(row.requests5h) || row.requests5h <= 0) {
      errors.push(`${name}.requests5h is invalid`);
    }
  }

  if (errors.length) throw new Error(`Snapshot validation failed: ${errors.join("; ")}`);
}

function hotFromSnapshot(snapshot) {
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || !snapshot.sourceState?.go || !snapshot.sourceState?.docs) return null;
  return { schema: SNAPSHOT_SCHEMA, sourceState: snapshot.sourceState };
}

async function readHot(env) {
  return env.STATE.get(HOT_KEY, { type: "json" });
}

async function writeHot(env, hot) {
  await env.STATE.put(HOT_KEY, JSON.stringify(hot));
}

function validatorHeaders(previousSource) {
  if (!previousSource?.fingerprint) return {};
  if (previousSource.etag) return { "if-none-match": previousSource.etag };
  if (previousSource.lastModified) return { "if-modified-since": previousSource.lastModified };
  return {};
}

async function cancelBody(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    // The body is an optimization detail. A cancellation failure does not make the
    // validator unusable and should not turn a healthy watch into an outage.
  }
}

async function fetchPage(url, fetchImpl, previousSource) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "opencode-go-watch/1.2 (+https://github.com/thelabcorner/opencode-go-watch)",
      "cache-control": "no-cache",
      pragma: "no-cache",
      ...validatorHeaders(previousSource),
    },
    cf: { cacheTtl: 0, cacheEverything: false },
    signal: AbortSignal.timeout(15_000),
  });

  const responseEtag = response.headers.get("etag");
  const responseLastModified = response.headers.get("last-modified");
  const etag = responseEtag || previousSource?.etag || null;
  const lastModified = etag ? null : responseLastModified || previousSource?.lastModified || null;

  if (response.status === 304) {
    if (!previousSource?.fingerprint) throw new Error(`Fetch ${url} returned 304 without a reusable baseline fingerprint`);
    return { kind: "not-modified", mode: "304", etag, lastModified };
  }
  if (!response.ok) throw new Error(`Fetch ${url} failed with HTTP ${response.status}`);

  // Some CDNs return 200 even when a conditional request names the representation
  // they serve. An identical ETag is authoritative for representation identity, so
  // do not decode/allocate a body just to prove the same thing again.
  if (previousSource?.etag && responseEtag && responseEtag === previousSource.etag) {
    await cancelBody(response);
    return { kind: "not-modified", mode: "etag", etag: responseEtag, lastModified: null };
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    await cancelBody(response);
    throw new Error(`Fetch ${url} declared ${declared.toLocaleString()} bytes; refusing oversized page`);
  }

  const body = await response.text();
  if (!body.trim()) throw new Error(`Fetch ${url} returned an empty body`);
  if (body.length > MAX_PAGE_BYTES) throw new Error(`Fetch ${url} returned ${body.length.toLocaleString()} bytes; refusing oversized page`);
  return { kind: "body", body, etag, lastModified };
}

async function inspectSource({ response, previousSource, prepare }) {
  if (response.kind === "not-modified") {
    return {
      prepared: null,
      changed: false,
      mode: response.mode,
      sourceState: {
        fingerprint: previousSource.fingerprint,
        etag: response.etag,
        lastModified: response.lastModified,
      },
    };
  }

  const prepared = prepare(response.body);
  const fingerprint = await sha256Text(prepared.fingerprintSource);
  const sourceState = { fingerprint, etag: response.etag, lastModified: response.lastModified };
  if (previousSource?.fingerprint === fingerprint) {
    return { prepared: null, changed: false, mode: "fingerprint", sourceState };
  }
  return { prepared, changed: true, mode: "parsed", sourceState };
}

function sameSourceState(a, b) {
  return Boolean(a && b)
    && a.fingerprint === b.fingerprint
    && a.etag === b.etag
    && a.lastModified === b.lastModified;
}

function sameHot(a, b) {
  return Boolean(a && b)
    && a.schema === b.schema
    && sameSourceState(a.sourceState?.go, b.sourceState?.go)
    && sameSourceState(a.sourceState?.docs, b.sourceState?.docs);
}

async function inspectSources(env, fetchImpl, hot) {
  const goUrl = env.OPENCODE_GO_URL || "https://opencode.ai/go";
  const docsUrl = env.OPENCODE_DOCS_URL || "https://opencode.ai/docs/go/";
  const previousGoSource = hot?.sourceState?.go ?? null;
  const previousDocsSource = hot?.sourceState?.docs ?? null;

  const [goResponse, docsResponse] = await Promise.all([
    fetchPage(goUrl, fetchImpl, previousGoSource),
    fetchPage(docsUrl, fetchImpl, previousDocsSource),
  ]);
  const [go, docs] = await Promise.all([
    inspectSource({ response: goResponse, previousSource: previousGoSource, prepare: prepareGoPage }),
    inspectSource({ response: docsResponse, previousSource: previousDocsSource, prepare: prepareDocsPage }),
  ]);

  return {
    goUrl,
    docsUrl,
    go,
    docs,
    hot: { schema: SNAPSHOT_SCHEMA, sourceState: { go: go.sourceState, docs: docs.sourceState } },
    optimization: { go: go.mode, docs: docs.mode },
  };
}

function buildCandidate(previous, inspected, now) {
  const go = inspected.go.changed
    ? parsePreparedGoPage(inspected.go.prepared)
    : previous?.go;
  const docs = inspected.docs.changed
    ? parsePreparedDocsPage(inspected.docs.prepared)
    : previous?.docs;
  if (!go || !docs) throw new Error("A semantic baseline is required to reuse an unchanged source");

  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    checkedAt: now.toISOString(),
    sources: { go: inspected.goUrl, docs: inspected.docsUrl },
    sourceState: inspected.hot.sourceState,
    go,
    docs,
  };
  validateSnapshot(snapshot);
  return snapshot;
}

/**
 * Standalone collection helper used by tests/tools. runWatch uses a still cheaper
 * hot-state path which avoids loading the 10KB-ish semantic snapshot at all when
 * both sources are unchanged.
 */
export async function collectSnapshot(env, fetchImpl = fetch, now = new Date(), previous = null) {
  const hot = hotFromSnapshot(previous);
  const inspected = await inspectSources(env, fetchImpl, hot);
  const snapshot = buildCandidate(previous, inspected, now);
  return {
    snapshot,
    optimization: inspected.optimization,
    semanticDirty: !previous || inspected.go.changed || inspected.docs.changed || previous.schema !== SNAPSHOT_SCHEMA,
    sourceStateDirty: !hot || !sameHot(hot, inspected.hot),
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
    env.STATE.delete(HOT_KEY),
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
  const now = new Date(checkedAt);
  // Cron is exactly every five minutes; the scheduled event time passed by index.js
  // makes :00 deterministic. This removes eleven of twelve steady-state META reads.
  if (now.getUTCMinutes() !== 0) return;
  const meta = await readMeta(env);
  const last = new Date(meta.lastHeartbeatAt ?? 0).getTime();
  if (Number.isFinite(last) && now.getTime() - last < HEARTBEAT_MS) return;
  await env.STATE.put(META_KEY, JSON.stringify({ ...meta, lastSuccessAt: checkedAt, lastHeartbeatAt: checkedAt }));
}

async function loadSnapshotIfNeeded(env, existing) {
  return existing ?? readSnapshot(env);
}

export async function runWatch(env, { fetchImpl = fetch, now = new Date(), forceNotify = false } = {}) {
  // HOT_KEY is a few hundred bytes and contains only validators/fingerprints. The
  // large semantic snapshot is deliberately absent from the common 5-minute path.
  let [hot, previousError] = await Promise.all([
    readHot(env),
    env.STATE.get(ERROR_KEY, { type: "json" }),
  ]);
  let previous = null;

  // One-time migration / recovery path for deployments created before HOT_KEY.
  if (!hot || hot.schema !== SNAPSHOT_SCHEMA) {
    previous = await readSnapshot(env);
    hot = hotFromSnapshot(previous);
  }

  const inspected = await inspectSources(env, fetchImpl, hot);
  const optimization = inspected.optimization;
  const sourceStateDirty = !hot || !sameHot(hot, inspected.hot);
  const semanticDirty = !hot || inspected.go.changed || inspected.docs.changed;
  const checkedAt = now.toISOString();
  const timeZone = env.TIMEZONE || "America/Chicago";

  // Absolute hot path: both upstream semantic regions are proven identical. No
  // 10KB semantic snapshot read, no HTML parser, no validation walk, no diff engine.
  if (!semanticDirty && previous?.schema !== 1) {
    if (sourceStateDirty) await writeHot(env, inspected.hot);

    if (forceNotify || previousError) previous = await loadSnapshotIfNeeded(env, previous);
    if (forceNotify && previous) {
      const current = { ...previous, checkedAt, sourceState: inspected.hot.sourceState };
      const manual = buildBootMessage(current, timeZone)
        .replace("OPENCODE GO WATCH · ARMED", "OPENCODE GO WATCH · MANUAL CHECK")
        .replace("Baseline captured. Semantic monitoring is live.", "No semantic changes detected. Current pages parse cleanly.");
      await sendTelegram(env, manual, fetchImpl);
    }
    await maybeHeartbeat(env, checkedAt);

    if (previousError && previous) {
      const current = { ...previous, checkedAt, sourceState: inspected.hot.sourceState };
      await sendTelegram(env, buildRecoveryMessage(previousError, current, timeZone), fetchImpl);
      await env.STATE.delete(ERROR_KEY);
      await writeMeta(env, { lastSuccessAt: checkedAt, lastRecoveryAt: checkedAt });
    }

    return { status: "unchanged", changes: [], snapshot: previous, optimization };
  }

  previous = await loadSnapshotIfNeeded(env, previous);
  const snapshot = buildCandidate(previous, inspected, now);

  if (!previous) {
    const notifyBootstrap = String(env.NOTIFY_ON_BOOTSTRAP ?? "true").toLowerCase() !== "false";
    if (notifyBootstrap || forceNotify) await sendTelegram(env, buildBootMessage(snapshot, timeZone), fetchImpl);
    // Full baseline first, hot pointer second. If the second write ever fails, the
    // next invocation reconstructs HOT_KEY from the authoritative full baseline.
    await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    await writeHot(env, inspected.hot);
    await writeMeta(env, {
      lastSuccessAt: checkedAt,
      lastHeartbeatAt: checkedAt,
      lastChangeAt: null,
      lastChangeCount: 0,
      bootstrappedAt: checkedAt,
    });
    if (previousError) await env.STATE.delete(ERROR_KEY);
    return { status: "bootstrapped", changes: [], snapshot, optimization };
  }

  validateTransition(previous, snapshot);
  const changes = diffSnapshots(previous, snapshot);
  const needsSchemaUpgrade = previous.schema !== SNAPSHOT_SCHEMA;

  if (changes.length) {
    const messages = buildChangeMessages(changes, snapshot, timeZone);
    // Advance persistence only after every Telegram card succeeds; failed delivery
    // therefore retries the same semantic diff on the next cron invocation.
    for (const message of messages) await sendTelegram(env, message, fetchImpl);
    await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    await writeHot(env, inspected.hot);
    await writeMeta(env, {
      lastSuccessAt: checkedAt,
      lastHeartbeatAt: checkedAt,
      lastChangeAt: checkedAt,
      lastChangeCount: changes.length,
    });
  } else {
    // A deployment can alter markup inside the watched region while leaving the
    // semantic data identical. Persist just the tiny hot state; the large baseline
    // is rewritten only for the one-time schema upgrade.
    if (needsSchemaUpgrade) await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    if (sourceStateDirty || needsSchemaUpgrade) await writeHot(env, inspected.hot);
    if (forceNotify) {
      const manual = buildBootMessage(snapshot, timeZone)
        .replace("OPENCODE GO WATCH · ARMED", "OPENCODE GO WATCH · MANUAL CHECK")
        .replace("Baseline captured. Semantic monitoring is live.", "No semantic changes detected. Current pages parse cleanly.");
      await sendTelegram(env, manual, fetchImpl);
    }
    await maybeHeartbeat(env, checkedAt);
  }

  if (previousError) {
    await sendTelegram(env, buildRecoveryMessage(previousError, snapshot, timeZone), fetchImpl);
    await env.STATE.delete(ERROR_KEY);
    await writeMeta(env, { lastSuccessAt: checkedAt, lastRecoveryAt: checkedAt });
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
