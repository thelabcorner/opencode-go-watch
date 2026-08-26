import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/entry.js";

class FakeKV {
  map = new Map();
  async get(key, options) {
    const value = this.map.get(key);
    if (value == null) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

function goSnapshot() {
  return {
    schema: 4,
    checkedAt: "2026-08-26T18:00:00.000Z",
    sources: {},
    sourceState: {},
    go: {
      chart: {
        "Value Model": { requests5h: 1000, bonus: null, unlimited: false },
      },
      promoBanner: null,
    },
    docs: {
      limits: { fiveHourUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
      requests: {
        "Value Model": { requests5h: 1000, requestsWeek: 2500, requestsMonth: 5000, unlimited: false },
      },
      pricing: {
        "Value Model": { inputPerM: 0.2, outputPerM: 0.8, cachedReadPerM: 0.02, cachedWritePerM: null, usageUsd: 60 },
      },
      profiles: {
        "Value Model": { inputTokens: 800, cachedTokens: 60000, outputTokens: 250 },
      },
      notes: {},
      usageText: "",
    },
  };
}

function envWithSnapshot() {
  const STATE = new FakeKV();
  STATE.map.set("snapshot:v1", JSON.stringify(goSnapshot()));
  return { STATE };
}

test("production entry renders exactly one Usage Value V2 section", async () => {
  const response = await worker.fetch(new Request("https://worker.example/"), envWithSnapshot());
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Usage Value V2/);
  assert.equal((body.match(/id="usage-value"/g) ?? []).length, 1);
  assert.equal((body.match(/href="#usage-value"/g) ?? []).length, 1);
});

test("public Go Usage Yield JSON is serializable and omits the internal Map index", async () => {
  const response = await worker.fetch(new Request("https://worker.example/usage-yield"), envWithSnapshot());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.basis, "usage-yield-v2");
  assert.equal(data.paidEntries.length, 1);
  assert.equal(data.paidEntries[0].name, "Value Model");
  assert.equal(data.paidEntries[0].rank, 1);
  assert.equal("byKey" in data, false);
});
