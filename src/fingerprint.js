const ENCODER = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * Native SHA-256 is used as a no-false-negative gate before the expensive semantic
 * parsers. The monitored regions are small, and crypto.subtle runs in native code.
 */
export async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(String(value ?? "")));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}
