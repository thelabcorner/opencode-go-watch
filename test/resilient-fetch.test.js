import test from "node:test";
import assert from "node:assert/strict";
import { makeResilientSourceFetch } from "../src/resilient-fetch.js";

test("source GET survives two transient timeouts before succeeding", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response("ok", { status: 200 });
  };
  const resilient = makeResilientSourceFetch(fetchImpl);
  const response = await resilient("https://opencode.ai/go", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test("source GET survives two transient 5xx responses before succeeding", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3 ? new Response("temporary", { status: 503 }) : new Response("ok", { status: 200 });
  };
  const resilient = makeResilientSourceFetch(fetchImpl);
  const response = await resilient("https://opencode.ai/docs/go/", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test("source GET surfaces a timeout only after all three attempts fail", async () => {
  let calls = 0;
  const resilient = makeResilientSourceFetch(async () => {
    calls++;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  await assert.rejects(
    resilient("https://opencode.ai/go", { method: "GET" }),
    /timed out after 3 attempts × 4s/,
  );
  assert.equal(calls, 3);
});

test("caller abort cancels an in-flight GET without retrying", async () => {
  let calls = 0;
  const controller = new AbortController();
  const fetchImpl = async (_input, init) => {
    calls++;
    controller.abort(new DOMException("cancelled by caller", "AbortError"));
    if (init.signal.aborted) throw init.signal.reason;
    await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const resilient = makeResilientSourceFetch(fetchImpl);

  await assert.rejects(
    resilient("https://opencode.ai/go", { method: "GET", signal: controller.signal }),
    (error) => error?.name === "AbortError" && /cancelled by caller/.test(error.message),
  );
  assert.equal(calls, 1);
});

test("pre-aborted caller signal prevents the GET from starting", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new DOMException("already cancelled", "AbortError"));
  const resilient = makeResilientSourceFetch(async () => {
    calls++;
    return new Response("unexpected", { status: 200 });
  });

  await assert.rejects(
    resilient("https://opencode.ai/go", { method: "GET", signal: controller.signal }),
    (error) => error?.name === "AbortError" && /already cancelled/.test(error.message),
  );
  assert.equal(calls, 0);
});

test("POST requests are never retried to avoid duplicate Telegram sends", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const resilient = makeResilientSourceFetch(fetchImpl);
  await assert.rejects(
    resilient("https://api.telegram.org/botTOKEN/sendMessage", { method: "POST" }),
    /timeout/i,
  );
  assert.equal(calls, 1);
});
