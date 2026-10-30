// Reads a newline-delimited stream (the agent run's JSON events) and hands its
// lines to `onLine` in batches, at most once per frame.
//
// The backend writes one event per streamed token. Handling each one as it was
// read committed one React render of the whole application per token, editor
// and PDF viewer included. The lines are still handled in order, by the same
// callback, and every state update of one batch lands in one render; what
// changes is only that a line may wait for the next frame.
//
// `requestAnimationFrame` does not fire in a hidden window, so a timeout runs
// the batch when no frame comes. Whatever is still waiting when the stream ends
// or fails is handled before this returns or throws, so a caller's code after
// the read loop sees every event, exactly as it did when lines were handled as
// they arrived.

const FRAME_FALLBACK_MS = 100;

export const scheduleFrame = (callback) => {
  let settled = false;
  let frame = null;
  let timer = null;
  const cancel = () => {
    settled = true;
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
  const run = () => {
    if (settled) return;
    cancel();
    callback();
  };
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run);
  timer = setTimeout(run, FRAME_FALLBACK_MS);
  return { cancel };
};

export const consumeLinesByFrame = async (reader, onLine, { schedule = scheduleFrame } = {}) => {
  const decoder = new TextDecoder();
  let buffer = '';
  let pending = [];
  let scheduled = null;
  const flush = () => {
    scheduled = null;
    const batch = pending;
    pending = [];
    for (const line of batch) onLine(line);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) pending.push(line);
      }
      if (pending.length && !scheduled) scheduled = schedule(flush);
    }
  } finally {
    if (scheduled) scheduled.cancel();
    flush();
  }
  if (buffer.trim()) onLine(buffer);
};
