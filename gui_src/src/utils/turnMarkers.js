// How a turn that did not end with an answer is recognised in the chat.
//
// The backend persists whatever the model had written, followed by a stable,
// unlocalised marker (`agent_stdin.py`: `_persist_unfinished_turn`). These
// strings are therefore kept byte-for-byte in step with the Python constants —
// `tests/test_turn_protocol.py` and `tests/test_turn_failure_persistence.py`
// read this file and fail on drift — and they are never translated: a turn
// recorded in one language would stop matching after the user switched to
// another, and the continue button would silently disappear from turns that
// still need it.
//
// **The marker is a suffix, not the whole message**, and that distinction is
// the reason this module exists. `_persist_unfinished_turn` stores
// `f"{visible}\n\n{marker}"`, so an interruption that caught the agent
// mid-sentence arrives with the partial answer in front of the marker. Matching
// it by equality — which is what the interrupted branch used to do — only ever
// recognised a turn that had produced nothing: stop an agent while it is
// talking and the user got no continue action and the raw English marker
// rendered in the bubble as if the model had written it. The cut-short and
// failed markers were matched with `includes` from the start; this puts all
// three on one rule so they cannot drift apart again.

export const INTERRUPTED_MARKER =
  '[INTERRUPTED] The user interrupted the agent execution.';

export const TURN_CUT_SHORT_MARKER =
  '[TURN-CUT-SHORT] The runaway guardrail stopped this turn before the model ' +
  'gave a final answer. The text above is work in progress, not a reply.';

export const TURN_FAILED_MARKER =
  '[TURN-FAILED] This turn stopped on an error before the model gave a final ' +
  'answer. The text above is work in progress, not a reply.';

export const TURN_MARKERS = [INTERRUPTED_MARKER, TURN_CUT_SHORT_MARKER, TURN_FAILED_MARKER];

// Older turns, recorded before the marker existed, that are still in people's
// chats. They were stored as prose and have no partial answer to preserve.
const LEGACY_INTERRUPTION_PREFIXES = ['Interrupted:', 'Interrompido:'];

/**
 * Describe how an assistant turn ended, and return its text without the markup.
 *
 * `probe` is the content with reasoning blocks removed, used only for the
 * legacy prefixes: a `<think>` block ahead of the prose would otherwise hide
 * them. Everything else is matched on the raw content, because a marker is
 * appended after the whole message and must be found wherever it sits.
 */
export const turnEndFromContent = (content, probe = undefined) => {
  const raw = String(content ?? '');
  const interruptedByMarker = raw.includes(INTERRUPTED_MARKER);
  const cutShort = raw.includes(TURN_CUT_SHORT_MARKER);
  const failed = raw.includes(TURN_FAILED_MARKER);

  const legacyProbe = String(probe ?? raw).trimStart();
  const legacyInterruption = !interruptedByMarker
    && LEGACY_INTERRUPTION_PREFIXES.some(prefix => legacyProbe.startsWith(prefix));

  let text = raw;
  for (const marker of TURN_MARKERS) {
    if (text.includes(marker)) text = text.split(marker).join('');
  }

  return {
    interrupted: interruptedByMarker || legacyInterruption,
    // Only a marked interruption carries work to keep and markup to strip; the
    // legacy shape *is* the notice, so the caller replaces it instead.
    interruptedByMarker,
    legacyInterruption,
    cutShort,
    failed,
    text: text.trimEnd(),
  };
};

/**
 * The message an interrupted turn leaves in the chat, in the shape the backend
 * persists, so the bubble on screen and the one reloaded from history are the
 * same message rather than two different accounts of one event.
 */
export const interruptedTurnContent = (partialText = '') => {
  const visible = String(partialText ?? '').trim();
  return visible ? `${visible}\n\n${INTERRUPTED_MARKER}` : INTERRUPTED_MARKER;
};
