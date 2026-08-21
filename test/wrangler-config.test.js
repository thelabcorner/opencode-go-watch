import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wrangler = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

test("Wrangler config stays deployable on Workers Free", () => {
  // Cloudflare Free already enforces the 10 ms CPU ceiling and rejects an
  // explicit limits.cpu_ms at deploy time with API error 100328.
  assert.doesNotMatch(wrangler, /^\s*cpu_ms\s*=/m);

  const subrequests = /^\s*subrequests\s*=\s*(\d+)\s*$/m.exec(wrangler);
  assert.ok(subrequests, "expected an explicit subrequest safety ceiling");
  assert.ok(Number(subrequests[1]) <= 50, "Free plan external subrequest ceiling cannot exceed 50");
});
