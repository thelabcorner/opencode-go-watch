import test from "node:test";
import assert from "node:assert/strict";
import { readTextLimited } from "../src/limited-body.js";

test("bounded reader accepts a body within the byte budget", async () => {
  const response = new Response("hello", { headers: { "content-length": "5" } });
  assert.equal(await readTextLimited(response, 5, "fixture"), "hello");
});

test("bounded reader rejects an oversized declared Content-Length", async () => {
  const response = new Response("small", { headers: { "content-length": "100" } });
  await assert.rejects(readTextLimited(response, 10, "fixture"), /declared 100 bytes; limit is 10/);
});

test("bounded reader rejects a chunked body before unbounded accumulation", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  const response = new Response(stream);
  await assert.rejects(readTextLimited(response, 10, "fixture"), /exceeded 10 bytes/);
});

test("bounded reader measures UTF-8 bytes rather than JavaScript code units", async () => {
  const response = new Response("💥💥");
  await assert.rejects(readTextLimited(response, 7, "fixture"), /exceeded 7 bytes/);
});
