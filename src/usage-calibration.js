import { sha256Text } from "./fingerprint.js";
import { buildStandardWorkloadCorpus } from "./usage-yield.js";

const GO_SNAPSHOT_KEY = "snapshot:v1";

export async function buildUsageCalibration(snapshot) {
  const corpus = buildStandardWorkloadCorpus(snapshot?.docs?.profiles ?? {});
  if (!corpus.workloads.length) return null;
  const fingerprintSource = JSON.stringify({
    schema: corpus.schema,
    workloads: corpus.workloads.map(({ models: _models, ...workload }) => workload),
  });
  const fingerprint = await sha256Text(fingerprintSource);
  return {
    ...corpus,
    fingerprint,
    checkedAt: snapshot?.checkedAt ?? new Date().toISOString(),
  };
}

/**
 * Zen reads the last accepted Go semantic baseline and derives the calibration from
 * it. This costs one small KV read per Zen check but avoids another persistent key,
 * keeps Go as the sole authority for its observed profiles, and makes recalibration
 * atomic with the same baseline that already passed Go validation/Telegram delivery.
 */
export async function readUsageCalibration(env) {
  if (!env?.STATE) return null;
  const goSnapshot = await env.STATE.get(GO_SNAPSHOT_KEY, { type: "json" });
  return buildUsageCalibration(goSnapshot);
}
