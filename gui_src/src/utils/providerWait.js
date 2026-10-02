// The `provider_wait` event: the model's provider has sent nothing for a while.
//
// The backend reports the silence once, when it crosses the threshold, and
// again when it ends (`waiting: false`). The elapsed time shown in between is
// counted here, from the moment the silence began, so the notice keeps moving
// without the backend sending an event every second.
//
// It is information only. Reported from a real session: a request sat on a dead
// connection for the whole 600 s HTTP timeout while the chat showed nothing but
// "Analyzing the obtained result...", and nobody could know that stopping and
// pressing Continue would have recovered it in seconds.

/**
 * Turn a `provider_wait` payload into panel state, or null when the wait ended.
 * `now` is the receipt time in milliseconds.
 */
export const providerWaitFromEvent = (data, now = Date.now()) => {
  if (!data || !data.waiting) return null;
  const elapsed = Number(data.elapsed_seconds);
  return {
    phase: data.phase === 'stream' ? 'stream' : 'first_response',
    agent: String(data.agent || ''),
    since: now - (Number.isFinite(elapsed) && elapsed > 0 ? elapsed * 1000 : 0),
  };
};

/** Seconds of silence at `now`, never negative. */
export const providerWaitSeconds = (wait, now = Date.now()) => (
  wait ? Math.max(0, Math.floor((now - wait.since) / 1000)) : 0
);

/** "45 s", "1 min 05 s", "12 min 00 s". */
export const formatWaitDuration = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, '0');
  return `${minutes} min ${rest} s`;
};
