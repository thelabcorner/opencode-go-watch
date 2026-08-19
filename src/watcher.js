import { diffSnapshots } from "./diff.js";
import { parseDocsPage, parseGoPage } from "./parsers.js";
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
const ERROR_REPEAT_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60 * 60 * 1000;
const MAX_PAGE_BYTES = 5_000_000;

export function validateSnapshot(snapshot) {
  const errors = [];
  const chartCount = Object.keys(snapshot.go?.chart ?? {}).length;
  const requestCount = Object.keys(snapshot.docs?.requests ?? {}).length;
  const pricingCount = Object.keys(snapshot.docs?.pricing ?? {}).length;
  const profileCount = Object.keys(snapshot.docs?.profiles ?? {}).length;

  // These are intentionally well below the current counts. They are circuit
  // breakers for a parser/layout failure, not assumptions that block legitimate
  // model removals.
  if (chartCount < 5) errors.push(`chart parser found ${chartCount} models; refusing baseline update`);
  if (requestCount < 10) errors.push(`docs request table found ${requestCount} models; refusing baseline update`);
  if (pricingCount < 10) errors.push(`docs pricing table found ${pricingCount} rows; refusing baseline update`);
  if (profileCount < 8) errors.push(`docs request profiles found ${profileCount} models; refusing baseline update`);
  if (Object.keys(snapshot.docs?.limits ?? {}).length !== 3) errors.push("docs dollar limits are incomplete");

  for (const [name, row] of Object.entries(snapshot.docs?.requests ?? {})) {
    for (const field of ["requests5h", "requestsWeek", "requestsMonth"]) {
      if (!Number.isSafeInteger(row[field]) || row[field] <= 0) errors.push(`${name}.${field} is invalid`);
    }
    if (row.requestsWeek < row.requests5h) errors.push(`${name}: weekly estimate is below 5-hour estimate`);
    if (row.requestsMonth < row.requestsWeek) errors.push(`${name}: monthly estimate is below weekly estimate`);
  }

  if (errors.length) throw new Error(`Snapshot validation failed: ${errors.join("; ")}`);
}

async function fetchPage(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "opencode-go-watch/1.0 (+https://github.com/thelabcorner/opencode-go-watch)",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Fetch ${url} failed with HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error(`Fetch ${url} returned an empty body`);
  if (body.length > MAX_PAGE_BYTES) throw new Error(`Fetch ${url} returned ${body.length.toLocaleString()} bytes; refusing oversized page`);
  return body;
}

export async function collectSnapshot(env, fetchImpl = fetch, now = new Date()) {
  const goUrl = env.OPENCODE_GO_URL || "https://opencode.ai/go";
  const docsUrl = env.OPENCODE_DOCS_URL || "https://opencode.ai/docs/go/";
  const [goHtml, docsHtml] = await Promise.all([
    fetchPage(goUrl, fetchImpl),
    fetchPage(docsUrl, fetchImpl),
  ]);

  const snapshot = {
    schema: 1,
    checkedAt: now.toISOString(),
    sources: { go: goUrl, docs: docsUrl },
    go: parseGoPage(goHtml),
    docs: parseDocsPage(docsHtml),
  };
  validateSnapshot(snapshot);
  return snapshot;
}

export async function readSnapshot(env) {
  return env.STATE.get(SNAPSHOT_KEY, { type: "json" });
}

export function validateTransition(previous, snapshot) {
  if (!previous) return;
  /** @type {Array<[string, number, number, number, number]>} */
  const checks = [
    ["chart", Object.keys(previous.go?.chart ?? {}).length, Object.keys(snapshot.go?.chart ?? {}).length, 0.60, 4],
    ["docs request table", Object.keys(previous.docs?.requests ?? {}).length, Object.keys(snapshot.docs?.requests ?? {}).length, 0.40, 5],
    ["docs pricing table", Object.keys(previous.docs?.pricing ?? {}).length, Object.keys(snapshot.docs?.pricing ?? {}).length, 0.50, 8],
    ["docs request profiles", Object.keys(previous.docs?.profiles ?? {}).length, Object.keys(snapshot.docs?.profiles ?? {}).length, 0.50, 5],
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
  const snapshot = await collectSnapshot(env, fetchImpl, now);
  const [previous, previousError] = await Promise.all([
    readSnapshot(env),
    env.STATE.get(ERROR_KEY, { type: "json" }),
  ]);
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
    return { status: "bootstrapped", changes: [], snapshot };
  }

  validateTransition(previous, snapshot);
  const changes = diffSnapshots(previous, snapshot);
  if (changes.length) {
    const messages = buildChangeMessages(changes, snapshot, timeZone);
    // Baseline is advanced only after every Telegram message succeeds. A network
    // failure therefore retries the exact same semantic change next cron.
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
    await maybeHeartbeat(env, snapshot.checkedAt);
  }

  if (previousError) {
    await sendTelegram(env, buildRecoveryMessage(previousError, snapshot, timeZone), fetchImpl);
    await env.STATE.delete(ERROR_KEY);
  }

  return { status: changes.length ? "changed" : "unchanged", changes, snapshot };
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
