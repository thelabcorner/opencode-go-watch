import { sha256Text } from "./fingerprint.js";
import { buildStandardWorkloadCorpus } from "./usage-yield.js";

export const USAGE_CALIBRATION_KEY = "usage-calibration:v2";

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

export async function readUsageCalibration(env) {
  if (!env?.STATE) return null;
  return env.STATE.get(USAGE_CALIBRATION_KEY, { type: "json" });
}

/**
 * Persist the tiny shared Go workload calibration only when its workload shape
 * changes. Go remains the sole writer; Zen consumes the last known-good corpus.
 */
export async function syncUsageCalibration(env, snapshot) {
  if (!env?.STATE) return null;
  const next = await buildUsageCalibration(snapshot);
  if (!next) return null;
  const current = await readUsageCalibration(env);
  if (current?.fingerprint === next.fingerprint) return current;
  await env.STATE.put(USAGE_CALIBRATION_KEY, JSON.stringify(next));
  return next;
}
