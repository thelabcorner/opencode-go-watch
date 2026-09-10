import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../compose.yml", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("homelab scheduler invokes both Go and Zen watcher namespaces", () => {
  assert.match(compose, /for path in check zen\/check/);
  assert.match(compose, /http:\/\/app:8787\/\$\$path/);
  assert.match(compose, /condition:\s*service_healthy/);
  assert.match(compose, /wrangler dev does not fire the Worker's scheduled\(\) handler/);
});

test("Docker liveness cannot deadlock semantic recovery", () => {
  assert.match(compose, /healthcheck:[\s\S]*http:\/\/127\.0\.0\.1:8787\/live/);
  assert.doesNotMatch(compose, /healthcheck:[\s\S]*http:\/\/127\.0\.0\.1:8787\/health/);
  assert.match(compose, /condition:\s*service_healthy/);
});

test("homelab deployment fails closed when the Zen baseline stays empty", () => {
  assert.match(workflow, /runs-on: \[self-hosted, homelab\]/);
  assert.match(workflow, /docker compose -f .*compose\.yml.* up -d --build/);
  assert.match(workflow, /\/zen\/health/);
  assert.match(workflow, /zen\.modelCount > 0/);
  assert.match(workflow, /Zen never populated a non-zero model baseline/);
});
