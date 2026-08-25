const SOURCE_TIMEOUT_MS = 4_000;
const SOURCE_ATTEMPTS = 3;

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

function throwIfCallerAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function attemptSignal(callerSignal) {
  const timeoutSignal = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  if (!callerSignal) return { signal: timeoutSignal, cleanup() {} };

  const controller = new AbortController();
  const abortFrom = (source) => () => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onCallerAbort = abortFrom(callerSignal);
  const onTimeoutAbort = abortFrom(timeoutSignal);

  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  timeoutSignal.addEventListener("abort", onTimeoutAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup() {
      callerSignal.removeEventListener("abort", onCallerAbort);
      timeoutSignal.removeEventListener("abort", onTimeoutAbort);
    },
  };
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
 * so three total attempts (the initial request plus two retries) can absorb brief
 * upstream stalls while still fitting inside the watcher's 15-second source budget.
 */
export function makeResilientSourceFetch(fetchImpl = fetch) {
  return async function resilientSourceFetch(input, init = {}) {
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET") return fetchImpl(input, init);

    const url = urlOf(input);
    let lastError = null;

    for (let attempt = 1; attempt <= SOURCE_ATTEMPTS; attempt++) {
      throwIfCallerAborted(init.signal);
      const attemptAbort = attemptSignal(init.signal);
      try {
        const response = await fetchImpl(input, {
          ...init,
          // Keep caller cancellation semantics while giving every retry a fresh
          // per-attempt timeout budget.
          signal: attemptAbort.signal,
        });

        if (attempt < SOURCE_ATTEMPTS && retryableStatus(response.status)) {
          await cancelBody(response);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        // External cancellation is a control-flow decision, not a transient source
        // failure. Do not turn it into a retry or wrap it as an upstream failure.
        if (init.signal?.aborted) throw error;
        if (attempt >= SOURCE_ATTEMPTS || !retryableNetworkError(error)) break;
      } finally {
        attemptAbort.cleanup();
      }
    }

    const suffix = timeoutLike(lastError)
      ? `timed out after ${SOURCE_ATTEMPTS} attempts × ${SOURCE_TIMEOUT_MS / 1000}s`
      : `failed after ${SOURCE_ATTEMPTS} attempts: ${String(lastError?.message ?? lastError)}`;
    throw new Error(`Fetch ${url} ${suffix}`, { cause: lastError });
  };
}

export const resilientSourceFetch = makeResilientSourceFetch();
