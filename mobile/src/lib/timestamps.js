/**
 * Timestamps in the exact text the desktop writes.
 *
 * Python's `datetime.now(timezone.utc).isoformat()` gives
 * `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`. Rows are ordered by comparing these
 * strings, so the phone must write the same form: `toISOString()` (three
 * digits and `Z`) sorts wrongly against it (docs/specs/chats_export.md §2.1).
 *
 * Values are strictly increasing within the app. A turn writes the question,
 * its reasoning and the answer in that order, often within one millisecond,
 * and the desktop pairs reasoning with an answer by comparing timestamps.
 */

let lastMicros = 0;

export function nowIso() {
  const micros = Math.max(Date.now() * 1000, lastMicros + 1);
  lastMicros = micros;
  const whole = new Date(Math.floor(micros / 1000)).toISOString().slice(0, 19);
  const fraction = String(micros % 1000000).padStart(6, '0');
  return `${whole}.${fraction}+00:00`;
}
