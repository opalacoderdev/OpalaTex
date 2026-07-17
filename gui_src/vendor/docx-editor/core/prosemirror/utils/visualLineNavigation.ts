/**
 * Visual line navigation helpers — implements Word/Google-Docs-style
 * ArrowUp / ArrowDown with sticky X across visual lines (not just
 * paragraphs). Lifted from packages/react/src/paged-editor/
 * useVisualLineNavigation.ts so both adapters share the algorithm.
 *
 * Frontend-agnostic: takes a `getContainer: () => HTMLElement | null`
 * callback and a mutable sticky-state object, returns the same
 * function quartet React's hook returns.
 *
 * @remarks
 * Tagged `@internal` post-1.0 cut. Both adapters re-export this through
 * their own composables (`useVisualLineNavigation`); consumers should
 * prefer those. The subpath stays in `package.json` `exports` for
 * back-compat; expect it to move behind a public surface in a future
 * major.
 *
 * @packageDocumentation
 * @internal
 */
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { nextGraphemeBoundary, snapToGrapheme } from '../../flow-model/metrics/textMetrics';
import { findVerticalScrollParent } from '../../utils/findVerticalScrollParent';

const CONTENT_LINE_SELECTOR = '.layout-page-content .layout-line';

/** Leaf/atom placeholder so inline nodes contribute one UTF-16 unit to textBetween. */
const INLINE_ATOM_PLACEHOLDER = '\ufffc';

/** @internal */
export interface VisualLineState {
  stickyX: number | null;
  lastVisualLineIndex: number;
}

/** @internal */
export function createVisualLineState(): VisualLineState {
  return { stickyX: null, lastVisualLineIndex: -1 };
}

function scrollIntoViewIfNeeded(el: HTMLElement): void {
  const container = findVerticalScrollParent(el);
  if (!container) return;
  const elRect = el.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const margin = 40;
  if (elRect.bottom > containerRect.bottom - margin) {
    container.scrollTop += elRect.bottom - containerRect.bottom + margin;
  } else if (elRect.top < containerRect.top + margin) {
    container.scrollTop -= containerRect.top - elRect.top + margin;
  }
}

/** @internal */
export function getCaretClientX(container: HTMLElement, pmPos: number): number | null {
  const spans = container.querySelectorAll('span[data-doc-from][data-doc-to]');
  for (const span of Array.from(spans)) {
    const spanEl = span as HTMLElement;
    const docFrom = Number(spanEl.dataset.docFrom);
    const docTo = Number(spanEl.dataset.docTo);
    if (spanEl.classList.contains('layout-run-tab')) {
      if (pmPos >= docFrom && pmPos < docTo) return spanEl.getBoundingClientRect().left;
      continue;
    }
    if (pmPos >= docFrom && pmPos <= docTo && span.firstChild?.nodeType === Node.TEXT_NODE) {
      const textNode = span.firstChild as Text;
      const charIndex = Math.min(pmPos - docFrom, textNode.length);
      const ownerDoc = spanEl.ownerDocument;
      if (!ownerDoc) continue;
      const range = ownerDoc.createRange();
      range.setStart(textNode, charIndex);
      range.setEnd(textNode, charIndex);
      return range.getBoundingClientRect().left;
    }
  }
  const emptyRuns = container.querySelectorAll('.layout-empty-run');
  for (const emptyRun of Array.from(emptyRuns)) {
    const paragraph = emptyRun.closest('.layout-paragraph') as HTMLElement;
    if (!paragraph) continue;
    const docFrom = Number(paragraph.dataset.docFrom);
    const docTo = Number(paragraph.dataset.docTo);
    if (pmPos >= docFrom && pmPos <= docTo) return emptyRun.getBoundingClientRect().left;
  }
  return null;
}

/** @internal */
export function findLineElementAtPosition(
  container: HTMLElement,
  pmPos: number
): HTMLElement | null {
  const allLines = container.querySelectorAll(CONTENT_LINE_SELECTOR);
  for (const line of Array.from(allLines)) {
    const lineEl = line as HTMLElement;
    const spans = lineEl.querySelectorAll('span[data-doc-from][data-doc-to]');
    for (const span of Array.from(spans)) {
      const s = span as HTMLElement;
      const start = Number(s.dataset.docFrom);
      const end = Number(s.dataset.docTo);
      if (pmPos >= start && pmPos <= end) return lineEl;
    }
  }
  for (const line of Array.from(allLines)) {
    const lineEl = line as HTMLElement;
    const paragraph = lineEl.closest('.layout-paragraph') as HTMLElement;
    if (!paragraph) continue;
    const pStart = Number(paragraph.dataset.docFrom);
    const pEnd = Number(paragraph.dataset.docTo);
    if (pmPos >= pStart && pmPos <= pEnd) {
      const firstLineOfParagraph = paragraph.querySelector('.layout-line');
      if (firstLineOfParagraph === lineEl) return lineEl;
    }
  }
  return null;
}

/** @internal */
export function findPositionOnLineAtClientX(lineEl: HTMLElement, clientX: number): number | null {
  const spans = lineEl.querySelectorAll('span[data-doc-from][data-doc-to]');
  if (spans.length === 0) {
    const paragraph = lineEl.closest('.layout-paragraph') as HTMLElement;
    if (paragraph?.dataset.docFrom) return Number(paragraph.dataset.docFrom) + 1;
    return null;
  }
  for (const span of Array.from(spans)) {
    const spanEl = span as HTMLElement;
    const rect = spanEl.getBoundingClientRect();
    const docFrom = Number(spanEl.dataset.docFrom);
    const docTo = Number(spanEl.dataset.docTo);
    if (spanEl.classList.contains('layout-run-tab')) {
      if (clientX >= rect.left && clientX <= rect.right) {
        const mid = (rect.left + rect.right) / 2;
        return clientX < mid ? docFrom : docTo;
      }
      continue;
    }
    if (clientX >= rect.left && clientX <= rect.right) {
      const textNode = spanEl.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return docFrom;
      const text = textNode as Text;
      const ownerDoc = spanEl.ownerDocument;
      if (!ownerDoc) return docFrom;
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const r = ownerDoc.createRange();
        r.setStart(text, mid);
        r.setEnd(text, mid);
        if (clientX < r.getBoundingClientRect().left) hi = mid;
        else lo = mid + 1;
      }
      if (lo > 0 && lo <= text.length) {
        const r = ownerDoc.createRange();
        r.setStart(text, lo - 1);
        r.setEnd(text, lo - 1);
        const leftX = r.getBoundingClientRect().left;
        r.setStart(text, Math.min(lo, text.length));
        r.setEnd(text, Math.min(lo, text.length));
        const rightX = r.getBoundingClientRect().left;
        if (Math.abs(clientX - leftX) < Math.abs(clientX - rightX)) {
          return docFrom + (lo - 1);
        }
      }
      return docFrom + Math.min(lo, docTo - docFrom);
    }
  }
  let closestSpan: HTMLElement | null = null;
  let closestDist = Infinity;
  for (const span of Array.from(spans)) {
    const spanEl = span as HTMLElement;
    const rect = spanEl.getBoundingClientRect();
    const dist = clientX < rect.left ? rect.left - clientX : clientX - rect.right;
    if (dist < closestDist) {
      closestDist = dist;
      closestSpan = spanEl;
    }
  }
  if (!closestSpan) return null;
  const rect = closestSpan.getBoundingClientRect();
  return clientX < rect.left
    ? Number(closestSpan.dataset.docFrom)
    : Number(closestSpan.dataset.docTo);
}

/**
 * UTF-16 delta for one caret-safe grapheme (or one atomic inline) in `dir`
 * within the current textblock. Returns null at the parent edge so the
 * caller can cross the block boundary via `Selection.findFrom`.
 *
 * Operates on the full parent string so a caret already inside a cluster
 * (illegal mid-surrogate) snaps to the cluster edge instead of walking
 * one broken code unit at a time.
 *
 * Uses `Intl.Segmenter` when available (via `nextGraphemeBoundary` /
 * `snapToGrapheme`); otherwise the shared fallback that covers combining
 * marks, emoji modifiers, flags, and ZWJ sequences.
 */
function graphemeOffsetDelta($pos: ResolvedPos, dir: 1 | -1): number | null {
  const parent = $pos.parent;
  const offset = $pos.parentOffset;
  if (dir > 0) {
    if (offset >= parent.content.size) return null;
  } else if (offset <= 0) {
    return null;
  }

  const full = parent.textBetween(0, parent.content.size, undefined, INLINE_ATOM_PLACEHOLDER);
  if (dir > 0) {
    const next = nextGraphemeBoundary(full, offset);
    return next > offset ? next - offset : null;
  }

  const prev = snapToGrapheme(full, offset - 1);
  return offset > prev ? offset - prev : null;
}

/**
 * Next caret position for a collapsed horizontal arrow move.
 *
 * Advances by a full grapheme cluster inside the current textblock so the
 * caret never lands inside a surrogate pair or combining sequence. At the
 * textblock edge, uses ProseMirror's `Selection.findFrom` (same as before)
 * so table-cell / cross-paragraph behaviour is unchanged.
 */
function computeHorizontalArrowTarget(doc: PMNode, head: number, dir: 1 | -1): number | null {
  const $head = doc.resolve(head);
  const delta = graphemeOffsetDelta($head, dir);
  if (delta != null) return head + dir * delta;

  const side = dir > 0 ? $head.after() : $head.before();
  const found = Selection.findFrom(doc.resolve(side), dir, true);
  return found ? found.head : null;
}

/**
 * Move the caret (or extend the selection) one position left/right via an
 * explicit PM transaction.
 *
 * The hidden off-screen EditorView relies on the browser's native
 * contenteditable caret for ArrowLeft/Right — but DOM selection and PM
 * state drift apart there (DOM offset advances while `selection.from`
 * stalls). Dispatching the move ourselves keeps them in lockstep.
 *
 * Ctrl/Meta/Alt (word/line jumps) and CellSelection/NodeSelection are
 * left to other handlers.
 */
function handleHorizontalArrow(view: EditorView, event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;

  const dir = event.key === 'ArrowRight' ? 1 : -1;
  const { state } = view;
  const sel = state.selection;

  if (sel instanceof NodeSelection) return false;
  // Duck-type CellSelection without importing prosemirror-tables here.
  if ('$anchorCell' in sel) return false;

  if (!sel.empty && !event.shiftKey) {
    const pos = dir > 0 ? sel.to : sel.from;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    return true;
  }

  const target = computeHorizontalArrowTarget(state.doc, sel.head, dir);
  if (target == null) return false;

  try {
    const newSel = event.shiftKey
      ? TextSelection.create(state.doc, sel.anchor, target)
      : TextSelection.create(state.doc, target);
    view.dispatch(state.tr.setSelection(newSel));
  } catch {
    const near = TextSelection.near(state.doc.resolve(target), dir);
    const newSel = event.shiftKey ? TextSelection.create(state.doc, sel.anchor, near.head) : near;
    view.dispatch(state.tr.setSelection(newSel));
  }
  return true;
}

/**
 * Handle PM ArrowUp / ArrowDown with visual-line awareness + sticky
 * X. Returns true if the event was handled and PM should not run
 * its default behaviour. Mutates `state` so consecutive presses
 * keep the same sticky X.
 */
/** @internal */
export function handleVisualLineKeyDown(
  state: VisualLineState,
  view: EditorView,
  event: KeyboardEvent,
  container: HTMLElement | null
): boolean {
  // Home/End: always move within the current textblock. Relying solely on
  // prosemirror-commands' baseKeymap is flaky when Dom focus races with
  // painter/layout re-renders after typing in a table cell.
  if (
    (event.key === 'Home' || event.key === 'End') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    state.stickyX = null;
    state.lastVisualLineIndex = -1;
    const $head = view.state.selection.$head;
    const pos = event.key === 'Home' ? $head.start() : $head.end();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    return true;
  }

  // ArrowLeft/Right: see handleHorizontalArrow — must not rely on native
  // caret movement in the off-screen PM.
  if (
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    state.stickyX = null;
    state.lastVisualLineIndex = -1;
    return handleHorizontalArrow(view, event);
  }

  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      state.stickyX = null;
      state.lastVisualLineIndex = -1;
    }
    return false;
  }
  if (event.ctrlKey || event.metaKey) {
    state.stickyX = null;
    state.lastVisualLineIndex = -1;
    return false;
  }
  if (!container) return false;

  const allLines = Array.from(container.querySelectorAll(CONTENT_LINE_SELECTOR));
  if (allLines.length === 0) return false;

  const { from, anchor } = view.state.selection;

  if (state.stickyX === null) {
    const clientX = getCaretClientX(container, from);
    if (clientX === null) return false;
    state.stickyX = clientX;
  }

  let currentIndex: number;
  if (state.lastVisualLineIndex >= 0 && state.lastVisualLineIndex < allLines.length) {
    currentIndex = state.lastVisualLineIndex;
  } else {
    const currentLine = findLineElementAtPosition(container, from);
    if (!currentLine) return false;
    currentIndex = allLines.indexOf(currentLine);
    if (currentIndex === -1) return false;
  }

  const targetIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= allLines.length) {
    state.lastVisualLineIndex = -1;
    return false;
  }

  const targetLine = allLines[targetIndex] as HTMLElement;
  const newPos = findPositionOnLineAtClientX(targetLine, state.stickyX);
  if (newPos === null) return false;

  state.lastVisualLineIndex = targetIndex;

  const { state: pmState, dispatch } = view;
  const clampedPos = Math.max(0, Math.min(newPos, pmState.doc.content.size));

  try {
    const sel = event.shiftKey
      ? TextSelection.create(pmState.doc, anchor, clampedPos)
      : TextSelection.create(pmState.doc, clampedPos);
    dispatch(pmState.tr.setSelection(sel));
  } catch {
    const $newPos = pmState.doc.resolve(clampedPos);
    const sel = event.shiftKey
      ? TextSelection.between(pmState.doc.resolve(anchor), $newPos)
      : TextSelection.near($newPos);
    dispatch(pmState.tr.setSelection(sel));
  }

  scrollIntoViewIfNeeded(targetLine);
  return true;
}
