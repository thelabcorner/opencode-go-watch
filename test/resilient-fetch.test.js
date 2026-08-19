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
