export const FAILURE_REMINDER_MS = 6 * 60 * 60 * 1000;
export const FAILURE_RETRY_MS = 60 * 60 * 1000;

function errorMessage(error) {
  return String(error?.message ?? error).slice(0, 500);
}

function timeOf(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Bounds persistent failure-state churn during a sustained outage.
 *
 * A new/different error is recorded immediately. Once an error is known, a
 * successful notification is persisted at most once per reminder window. If no
 * successful notification timestamp exists (for example Telegram is unavailable),
 * persistence/notification attempts are throttled to once per retry window.
 *
 * The caller deliberately does not update lastSeenAt while suppressed. That makes
 * the persisted timestamp double as the retry clock and prevents a five-minute cron
 * from turning one upstream outage into hundreds of KV writes per day.
 */
export function shouldRecordFailure(previous, error, now = new Date()) {
  if (!previous || previous.message !== errorMessage(error)) return true;

  const nowMs = now.getTime();
  const lastNotified = timeOf(previous.lastNotifiedAt);
  if (lastNotified != null) return nowMs - lastNotified >= FAILURE_REMINDER_MS;

  const lastAttempt = timeOf(previous.lastSeenAt) ?? timeOf(previous.firstSeenAt);
  if (lastAttempt == null) return true;
  return nowMs - lastAttempt >= FAILURE_RETRY_MS;
}
