// ─────────────────────────────────────────────────────────────────────────────
// textHistory.js
//
// Undo and redo *inside* a text box, which is a different history from the
// deck's and has to be.
//
// The deck's history is a stack of whole decks and one entry per completed
// edit: a box that was typed into is one entry, because §10.3 keeps a live
// edit out of the document until the caret leaves it. That is right for
// everything the canvas does — and it is exactly wrong for the caret, where
// Ctrl+Z has meant "take back the last few words" since before this editor
// existed. Left to the browser, the native `contenteditable` undo stack does
// something close to that, until the first time the marker column is redrawn
// under it — a script mutation is allowed to drop the stack, and this editor
// makes one after every keystroke.
//
// So the box keeps its own, over the only thing that changes while it is open:
// the string, and where the caret was in it. Three properties matter.
//
//   • **Snapshots, not diffs.** A slide's text box holds a paragraph, not a
//     document; a whole copy per entry is a handful of bytes, and it makes
//     restoring a state exactly as cheap and exactly as correct as saving one.
//   • **Typing is grouped, punctuation is not.** An undo that gave back one
//     letter would be useless, and one that gave back the whole box would be
//     worse. Runs of ordinary characters coalesce until the author pauses or
//     reaches a boundary — a space, a line break, an indent, a paste, a
//     deletion — which is where a reader expects a step to end.
//   • **Pure.** Nothing here touches the DOM or React, so what a sequence of
//     keystrokes undoes to is a unit test rather than something you find out
//     about with a slide half typed.
// ─────────────────────────────────────────────────────────────────────────────

// How long a run of typing stays one undo step. Long enough that a fast typist
// gets whole phrases, short enough that a pause is a step: the same order of
// magnitude every editor with a coalescing undo has settled on.
export const COALESCE_MS = 600;

// A slide's box is a paragraph, and the stack costs a copy of it per entry.
// The cap exists so a box that is typed in for an hour cannot grow without
// bound, not because anyone will reach it.
export const HISTORY_LIMIT = 200;

/**
 * A history over `{ text, caret }` snapshots. `current` is the live state;
 * `past` and `future` are what Ctrl+Z and Ctrl+Y move through.
 */
export function createTextHistory(snapshot, { now = Date.now() } = {}) {
  return { past: [], future: [], current: snapshot, at: now, open: false };
}

/**
 * Records the state the box is in *after* an edit.
 *
 * `boundary` says the edit is one the author would expect to undo on its own:
 * anything that is not the plain insertion of a printable character. The
 * caller classifies it, because the caller is the one holding the input event
 * — this module has no opinion about `inputType`, only about grouping.
 */
export function recordText(history, snapshot, { now = Date.now(), boundary = false } = {}) {
  if (!history) return createTextHistory(snapshot, { now });
  if (snapshot.text === history.current.text) {
    // A caret move is not an edit. Keeping it in `current` means an undo comes
    // back to where the author actually is, without spending a step.
    return { ...history, current: snapshot };
  }
  const coalesce = history.open && !boundary && (now - history.at) < COALESCE_MS;
  const past = coalesce ? history.past : [...history.past, history.current].slice(-HISTORY_LIMIT);
  return {
    past,
    future: [],                      // a new edit is what ends a redo chain
    current: snapshot,
    at: now,
    // A boundary edit closes the group it ended, so the next character starts a
    // step of its own rather than joining the line break before it.
    open: !boundary,
  };
}

export function canUndoText(history) {
  return !!history && history.past.length > 0;
}

export function canRedoText(history) {
  return !!history && history.future.length > 0;
}

/**
 * One step back, as `{ history, snapshot }` — or `null` when there is nothing
 * left in the box to undo, which is the caller's signal to hand Ctrl+Z on to
 * the deck's own history rather than swallowing it.
 */
export function undoText(history) {
  if (!canUndoText(history)) return null;
  const past = history.past.slice(0, -1);
  const snapshot = history.past[history.past.length - 1];
  return {
    history: {
      past,
      future: [history.current, ...history.future].slice(0, HISTORY_LIMIT),
      current: snapshot,
      at: 0,             // never coalesce onto a restored state
      open: false,
    },
    snapshot,
  };
}

/** One step forward, with the same contract as `undoText`. */
export function redoText(history) {
  if (!canRedoText(history)) return null;
  const [snapshot, ...future] = history.future;
  return {
    history: {
      past: [...history.past, history.current].slice(-HISTORY_LIMIT),
      future,
      current: snapshot,
      at: 0,
      open: false,
    },
    snapshot,
  };
}

/**
 * Whether an input event is a boundary — the classification `recordText` asks
 * the caller for, kept here so the canvas and the tests use the same rule.
 *
 * Everything that is not one printable character typed in is: a deletion, a
 * paste, a line break, a drop, an undo the browser tried to run itself. A
 * space is deliberately in the list, because "the last word" is the step size
 * a reader expects from Ctrl+Z.
 */
export function isBoundaryInput(inputType, data) {
  if (inputType !== 'insertText') return true;
  return data == null || data.length !== 1 || /\s/.test(data);
}
