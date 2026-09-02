import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildGoApiChangeMessages,
  diffGoModelsApi,
  parseGoModelsApi,
  prepareGoModelsApi,
} from "../src/go-api.js";
import { readSnapshot, runWatch } from "../src/watcher.js";

const goHtml = await readFile(new URL("./fixtures/go.html", import.meta.url), "utf8");
const docsHtml = await readFile(new URL("./fixtures/docs.html", import.meta.url), "utf8");
const GO_API_URL = "https://opencode.ai/zen/go/v1/models";

function apiBody(ids, { created = 1, owner = "opencode", extra = null } = {}) {
  return JSON.stringify({
    object: "list",
    data: ids.map((id, index) => ({
      id,
      object: "model",
      created: created + index,
      owned_by: owner,
      ...(extra ? extra(id, index) : {}),
    })),
  });
}

const BASE_IDS = Array.from({ length: 12 }, (_, index) => `model-${String(index + 1).padStart(2, "0")}`);

class FakeKV {
  map = new Map();
  writes = [];
  async get(key, opts) {
    const value = this.map.get(key);
    if (value == null) return null;
    return opts?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.writes.push(key);
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

function env({ api = false } = {}) {
  return {
    STATE: new FakeKV(),
    OPENCODE_GO_URL: "https://opencode.ai/go",
    OPENCODE_DOCS_URL: "https://opencode.ai/docs/go/",
    ...(api ? { OPENCODE_GO_MODELS_URL: GO_API_URL } : {}),
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
    NOTIFY_ON_BOOTSTRAP: "false",
    TIMEZONE: "America/Chicago",
  };
}

function makeFetch({ api = apiBody(BASE_IDS), telegram = [] } = {}) {
  return async (url, init = {}) => {
    if (url === "https://opencode.ai/go") return new Response(goHtml, { status: 200 });
    if (url === "https://opencode.ai/docs/go/") return new Response(docsHtml, { status: 200 });
    if (url === GO_API_URL) return new Response(api, { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).startsWith("https://api.telegram.org/")) {
      if (init.body) telegram.push(JSON.parse(init.body));
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

test("Go API parser canonicalizes order and ignores volatile created timestamps", () => {
  const forward = prepareGoModelsApi(apiBody(BASE_IDS, { created: 100 }));
  const reverse = prepareGoModelsApi(apiBody([...BASE_IDS].reverse(), { created: 9_000 }));
  assert.deepEqual(forward.api.modelIds, [...BASE_IDS].sort());
  assert.deepEqual(reverse.api.modelIds, [...BASE_IDS].sort());
  assert.equal(forward.fingerprintSource, reverse.fingerprintSource);
  assert.doesNotMatch(forward.fingerprintSource, /created/);
});

test("Go API parser rejects malformed and duplicate catalog rows", () => {
  assert.throws(() => parseGoModelsApi('{"object":"list","data":[{"created":1}]}'), /malformed model entry/);
  assert.throws(() => parseGoModelsApi(apiBody(["same", "same"])), /duplicate model IDs/);
});

test("Go API diff classifies additions, removals, metadata, and unknown fields", () => {
  const before = parseGoModelsApi(apiBody(BASE_IDS));
  const added = parseGoModelsApi(apiBody([...BASE_IDS, "new-model"]));
  assert.deepEqual(diffGoModelsApi(before, added), [{
    type: "go_api_model_added",
    key: "new-model",
    after: { id: "new-model", object: "model", ownedBy: "opencode" },
  }]);

  const removed = parseGoModelsApi(apiBody(BASE_IDS.slice(0, -1)));
  assert.equal(diffGoModelsApi(before, removed)[0].type, "go_api_model_removed");

  const ownerChanged = parseGoModelsApi(apiBody(BASE_IDS, { owner: "openai" }));
  assert(diffGoModelsApi(before, ownerChanged).every((change) => change.type === "go_api_model_changed" && change.field === "ownedBy"));

  const unknown = parseGoModelsApi(apiBody(BASE_IDS, { extra: () => ({ context_window: 1_000_000 }) }));
  const unknownChanges = diffGoModelsApi(before, unknown);
  assert.equal(unknownChanges.length, 1);
  assert.equal(unknownChanges[0].type, "go_api_unclassified_change");
  assert.match(unknownChanges[0].after, /context_window/);
});

test("Go API alert renderer produces a dedicated catalog card", () => {
  const after = parseGoModelsApi(apiBody([...BASE_IDS, "new-model"]));
  const messages = buildGoApiChangeMessages([
    { type: "go_api_model_added", key: "new-model", after: { id: "new-model", object: "model", ownedBy: "opencode" } },
  ], { checkedAt: "2026-09-02T17:00:00.000Z", api: after }, "America/Chicago");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /API MODEL ADDED/);
  assert.match(messages[0], /opencode\/new-model/);
  assert.match(messages[0], /Catalog\s+<b>13<\/b> models/);
});

test("enabling the Go API source migrates silently, then real API additions alert", async () => {
  const e = env();
  const noApi = await runWatch(e, {
    fetchImpl: makeFetch(),
    now: new Date("2026-09-02T17:00:00Z"),
  });
  assert.equal(noApi.status, "bootstrapped");
  assert.equal((await readSnapshot(e)).api, undefined);

  e.OPENCODE_GO_MODELS_URL = GO_API_URL;
  const migrationTelegram = [];
  const migrated = await runWatch(e, {
    fetchImpl: makeFetch({ api: apiBody(BASE_IDS, { created: 500 }), telegram: migrationTelegram }),
    now: new Date("2026-09-02T17:01:00Z"),
  });
  assert.equal(migrated.status, "unchanged");
  assert.equal(migrationTelegram.length, 0);
  assert.equal((await readSnapshot(e)).api.modelIds.length, 12);
  assert.equal(migrated.optimization.api, "parsed");

  const writesAfterMigration = e.STATE.writes.length;
  const timestampOnly = await runWatch(e, {
    fetchImpl: makeFetch({ api: apiBody([...BASE_IDS].reverse(), { created: 99_000 }) }),
    now: new Date("2026-09-02T17:02:00Z"),
  });
  assert.equal(timestampOnly.status, "unchanged");
  assert.equal(timestampOnly.optimization.api, "fingerprint");
  assert.equal(e.STATE.writes.length, writesAfterMigration);

  const telegram = [];
  const changed = await runWatch(e, {
    fetchImpl: makeFetch({ api: apiBody([...BASE_IDS, "new-model"], { created: 100_000 }), telegram }),
    now: new Date("2026-09-02T17:03:00Z"),
  });
  assert.equal(changed.status, "changed");
  assert.deepEqual(changed.changes.filter((change) => change.type === "go_api_model_added").map((change) => change.key), ["new-model"]);
  assert.equal(telegram.length, 1);
  assert.match(telegram[0].text, /API MODEL ADDED/);
  assert.equal((await readSnapshot(e)).api.modelIds.includes("new-model"), true);
});

test("catastrophic Go API shrink is rejected without advancing the catalog baseline", async () => {
  const e = env({ api: true });
  await runWatch(e, { fetchImpl: makeFetch(), now: new Date("2026-09-02T17:00:00Z") });
  await assert.rejects(
    runWatch(e, {
      fetchImpl: makeFetch({ api: apiBody(["only-one"]) }),
      now: new Date("2026-09-02T17:01:00Z"),
    }),
    /Go models API found 1 models/,
  );
  assert.equal((await readSnapshot(e)).api.modelIds.length, 12);
});
