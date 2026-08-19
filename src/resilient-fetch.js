const SOURCE_TIMEOUT_MS = 10_000;
const SOURCE_ATTEMPTS = 2;

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? String(input);
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function timeoutLike(error) {
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? error);
  return name === "TimeoutError" || name === "AbortError" || /tim(?:e|ed)\s*out|aborted due to timeout/i.test(message);
}

function retryableNetworkError(error) {
  if (timeoutLike(error)) return true;
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? error);
  return name === "TypeError" || /fetch failed|network|connection|socket/i.test(message);
}

async function cancelBody(response) {
  try {
    if (response?.body) await response.body.cancel();
  } catch {
    // Best-effort cleanup before retrying a transient HTTP response.
  }
}

/**
 * Retry wrapper for monitored source GETs only.
 *
 * Telegram sends are POSTs and intentionally bypass retries: retrying a POST after
 * an ambiguous network failure could duplicate an alert. Source GETs are idempotent,
 * so one retry is safe and prevents a single transient upstream stall from marking
 * the watcher degraded.
 */
export function makeResilientSourceFetch(fetchImpl = fetch) {
  return async function resilientSourceFetch(input, init = {}) {
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET") return fetchImpl(input, init);

    const url = urlOf(input);
    let lastError = null;

    for (let attempt = 1; attempt <= SOURCE_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(input, {
          ...init,
          // Replace the caller's one-shot timeout signal so every retry gets a
          // fresh budget. The watcher previously reused a signal that was already
          // aborted, which would make a wrapper-level retry useless.
          signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
        });

        if (attempt < SOURCE_ATTEMPTS && retryableStatus(response.status)) {
          await cancelBody(response);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= SOURCE_ATTEMPTS || !retryableNetworkError(error)) break;
      }
    }

    const suffix = timeoutLike(lastError)
      ? `timed out after ${SOURCE_ATTEMPTS} attempts × ${SOURCE_TIMEOUT_MS / 1000}s`
      : `failed after ${SOURCE_ATTEMPTS} attempts: ${String(lastError?.message ?? lastError)}`;
    throw new Error(`Fetch ${url} ${suffix}`, { cause: lastError });
  };
}

export const resilientSourceFetch = makeResilientSourceFetch();
