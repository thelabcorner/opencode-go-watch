import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/entry.js";
import { usageValuePresentationScore, usageValueRankScript } from "../src/usage-value-rank.js";

test("dashboard presentation ordering follows the V2 semantic hierarchy", () => {
  const quota = usageValuePresentationScore({ quotaExempt: true });
  const free = usageValuePresentationScore({ free: true });
  const rank1 = usageValuePresentationScore({ rank: 1 });
  const rank2 = usageValuePresentationScore({ rank: 2 });
  const unranked = usageValuePresentationScore({});

  assert.ok(quota > free);
  assert.ok(free > rank1);
  assert.ok(rank1 > rank2);
  assert.ok(rank2 > unranked);
});

test("rank enhancer reuses the rendered V2 leaderboard instead of recalculating economics", () => {
  assert.match(usageValueRankScript, /#usage-value tbody tr/);
  assert.match(usageValueRankScript, /paidRanks/);
  assert.match(usageValueRankScript, /#models #rows/);
  assert.match(usageValueRankScript, /#chart \.bars/);
  assert.match(usageValueRankScript, /Usage value V2 rank/);
  assert.doesNotMatch(usageValueRankScript, /inputPerM|outputPerM|cachedReadPerM/);
});

test("production entry serves the rank enhancer as a cacheable same-origin script", async () => {
  const response = await worker.fetch(new Request("https://worker.example/usage-value-rank.js"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/javascript/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.match(await response.text(), /Usage value V2 rank/);
});
