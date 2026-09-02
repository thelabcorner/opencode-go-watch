import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wrangler = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const skill = await readFile(new URL("../.opencode/skills/semantic-source-review/SKILL.md", import.meta.url), "utf8");
const sourceMap = await readFile(new URL("../.opencode/skills/semantic-source-review/references/source-map.md", import.meta.url), "utf8");
const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");

test("semantic source review skill is valid and discoverable", () => {
  assert.ok(skill.startsWith("---\nname: semantic-source-review\n"));
  assert.match(skill, /\n---\n\n# Semantic Source Review Protocol\n/);
  assert.match(skill, /description: .+unclassified watcher alert/i);
  assert.match(skill, /references\/source-map\.md/);
  assert.match(skill, /sibling positive/i);
  assert.match(skill, /negative control/i);
  assert.match(skill, /Keep the residual fallback alive/i);
  assert.match(agents, /\.opencode\/skills\/semantic-source-review\/SKILL\.md/);
});

test("every configured OpenCode scrape URL is represented in the source-review map", () => {
  const configured = [...wrangler.matchAll(/^\s*(OPENCODE_[A-Z0-9_]+_URL)\s*=\s*"([^"]+)"\s*$/gm)];
  assert.ok(configured.length >= 5, "expected the configured Go/Zen scrape URL inventory, including the Go models API");
  for (const [, variable, url] of configured) {
    assert.match(sourceMap, new RegExp(variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(sourceMap.includes(url), `${variable} (${url}) must be documented in the semantic source map`);
  }
});

test("source map keeps monitored Go/Zen namespaces explicit", () => {
  assert.match(sourceMap, /OPENCODE_GO_MODELS_URL/);
  assert.match(sourceMap, /https:\/\/opencode\.ai\/zen\/go\/v1\/models/);
  assert.doesNotMatch(sourceMap, /currently \*reviewed\*, not polled/i);
  assert.match(sourceMap, /primary public availability surface for Go model IDs/i);
  assert.match(sourceMap, /chart membership, docs membership, and API availability are separate dimensions/i);
  assert.match(sourceMap, /same model name does not imply same model ID/i);
  assert.match(sourceMap, /free.*unlimited.*different dimensions/is);
  assert.match(sourceMap, /anomalyco\/opencode:packages\/console\/app\/src\/routes\/go\/index\.tsx/);
  assert.match(sourceMap, /anomalyco\/opencode:packages\/console\/app\/src\/routes\/zen\/go\/v1\/models\.tsx/);
  assert.match(sourceMap, /anomalyco\/opencode:packages\/console\/app\/src\/routes\/zen\/util\/modelsHandler\.tsx/);
  assert.match(sourceMap, /anomalyco\/opencode:packages\/web\/src\/content\/docs\/go\.mdx/);
  assert.match(sourceMap, /anomalyco\/opencode:packages\/web\/src\/content\/docs\/zen\.mdx/);
});