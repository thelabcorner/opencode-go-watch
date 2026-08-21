import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wrangler = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

test("Wrangler config stays deployable on Workers Free", () => {
  // Cloudflare's versions API rejects runtime limit configuration for this Free
  // account with API error 100328. Do not emit any [limits] block at all; rely on
  // the platform defaults (10 ms CPU / 50 external subrequests).
  assert.doesNotMatch(wrangler, /^\s*\[limits\]\s*$/m);
  assert.doesNotMatch(wrangler, /^\s*cpu_ms\s*=/m);
  assert.doesNotMatch(wrangler, /^\s*subrequests\s*=/m);
});
