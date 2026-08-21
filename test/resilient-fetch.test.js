import test from "node:test";
import assert from "node:assert/strict";
import { makeResilientSourceFetch } from "../src/resilient-fetch.js";

test("source GET retries one transient timeout", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response("ok", { status: 200 });
  };
  const resilient = makeResilientSourceFetch(fetchImpl);
  const response = await resilient("https://opencode.ai/go", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("source GET retries a transient 5xx response", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? new Response("temporary", { status: 503 }) : new Response("ok", { status: 200 });
  };
  const resilient = makeResilientSourceFetch(fetchImpl);
  const response = await resilient("https://opencode.ai/docs/go/", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
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
