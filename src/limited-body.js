const ENCODER = new TextEncoder();

async function cancelBody(response) {
  try {
    if (response?.body) await response.body.cancel();
  } catch {
    // Cleanup is best-effort; the size guard remains authoritative.
  }
}

/**
 * Read a response body without allowing an origin to allocate an arbitrarily large
 * string inside the Worker. Both Content-Length and streamed/chunked bodies are
 * enforced against the same byte budget.
 */
export async function readTextLimited(response, maxBytes, label = "response") {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive safe integer");

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response);
    throw new Error(`${label} declared ${declared.toLocaleString()} bytes; limit is ${maxBytes.toLocaleString()}`);
  }

  if (!response.body) {
    const text = await response.text();
    const size = ENCODER.encode(text).byteLength;
    if (size > maxBytes) throw new Error(`${label} exceeded ${maxBytes.toLocaleString()} bytes`);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`${label} exceeded ${maxBytes.toLocaleString()} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
