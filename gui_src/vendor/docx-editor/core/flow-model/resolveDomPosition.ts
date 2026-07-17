/**
 * Selection mapping against the *painted* DOM.
 *
 * There are two ways to map between document positions and pixels. The layout
 * model knows where every line box is (`selectionGeometry.ts`), and the painted
 * DOM knows where every glyph actually landed. This module is the second one,
 * and it is the one the editor uses, because only the browser knows the truth
 * about a ligature, a bidi run, or a font that fell back.
 *
 * All three entry points share one shape: find the painted span whose
 * `[data-doc-from, data-doc-to)` range covers the position, then use a `Range`
 * inside it to get real glyph geometry. The spans are the index; the `Range` is
 * the ruler.
 *
 * **Coordinates.** Everything returned is relative to the `containerRect` the
 * caller passes — screen-space deltas, not layout pixels. The caller divides by
 * zoom. The one exception is caret `height`, which is divided here, because a
 * caret that scales with zoom is a caret that changes height when you zoom, and
 * that's wrong (#928).
 *
 * @packageDocumentation
 */

import {
  collectBodySpans,
  collectHfSpans,
  findBodyEmptyRuns,
  findBodyPmAnchors,
  isBodyPositionElement,
} from './collectBodySpans';
import { graphemeBoundaries } from './metrics/textMetrics';

/**
 * A highlight rectangle, in coordinates local to the container it was measured
 * against.
 *
 * @public
 */
export interface DomSelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
}

/**
 * A caret rectangle. Zero-width by nature — `height` is what matters, and it
 * tracks the *run* at the cursor, not the line box.
 *
 * @public
 */
export interface DomCaretPosition {
  x: number;
  y: number;
  height: number;
  pageIndex: number;
}

/**
 * Width of the sliver painted for a position that has no glyph to measure — a
 * blank line, an empty paragraph. Zero would be invisible; this is a caret's
 * worth of highlight, which is what Word shows when you select across a blank
 * line.
 */
const CARET_SLIVER_WIDTH = 4;

/** Fallback caret height when the painted run reports none (no layout yet). */
const FALLBACK_CARET_HEIGHT = 16;

/**
 * How far above or below a run a click still counts as "on that line". A click
 * in the leading between two lines has to belong to one of them.
 */
const LINE_BAND_TOLERANCE_PX = 4;

/** A caret API hit in another PM story must not fall through to body proximity. */
const OUTSIDE_POSITION_SCOPE = Symbol('outside-position-scope');

// ---------------------------------------------------------------------------
// Point → position
// ---------------------------------------------------------------------------

/**
 * The document position under a viewport point, or `null` when the point is over
 * no painted body run.
 *
 * Returning `null` is a real answer, not a failure: the caller has a
 * layout-geometry fallback for clicks in the margins and the inter-page gutter,
 * and it needs to know when to use it. In particular a click inside a
 * header/footer must come back `null` here — resolving it against body spans
 * would return a body position for a header click, and the next keystroke would
 * land in the wrong document.
 *
 * @public
 */
export function resolveDomPosition(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  zoom: number
): number | null {
  void zoom; // Rects are already in screen space; nothing to scale.

  const exact = positionFromCaretApi(container, clientX, clientY);
  if (exact === OUTSIDE_POSITION_SCOPE) return null;
  if (exact !== null) return exact;

  return nearestPositionOnLine(container, clientX, clientY);
}

/**
 * Resolve a point inside one exact painted header/footer host to the matching
 * independent HF ProseMirror position space.
 *
 * @public
 */
export function resolveHfDomPosition(
  host: HTMLElement,
  clientX: number,
  clientY: number
): number | null {
  if (!host.matches('.layout-page-header, .layout-page-footer')) return null;
  const exact = positionFromCaretApi(host, clientX, clientY, 'hf');
  if (exact === OUTSIDE_POSITION_SCOPE) return null;
  if (exact !== null) return exact;
  return nearestPositionOnLine(host, clientX, clientY, collectHfSpans(host));
}

/**
 * Ask the browser which character is under the point, then translate its answer
 * into our coordinate system.
 *
 * The browser gets this right in cases we would get wrong: bidirectional text,
 * where visual order and logical order differ; ligatures, where one glyph spans
 * two characters. So we ask it first and only fall back to our own arithmetic.
 */
function positionFromCaretApi(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  scope: 'body' | 'hf' = 'body'
): number | typeof OUTSIDE_POSITION_SCOPE | null {
  const doc = container.ownerDocument;
  const hit = caretNodeAtPoint(doc, clientX, clientY);
  if (!hit) return null;

  const span = enclosingPaintedSpan(hit.node, container, scope);
  if (span === OUTSIDE_POSITION_SCOPE) return OUTSIDE_POSITION_SCOPE;
  if (!span) {
    // Empty paragraphs paint a `.layout-empty-run` with no `data-doc-from` of
    // its own — the range lives on the paragraph. Without this, a click in an
    // empty table cell (or blank line) returns null and the editor parks the
    // caret at end-of-document.
    return positionFromEmptyRunHit(hit.node, container, scope);
  }

  const docFrom = numberAttr(span, 'docFrom');
  const docTo = numberAttr(span, 'docTo');
  if (docFrom === null || docTo === null) return null;

  const offset = textOffsetWithin(span, hit.node, hit.offset);
  if (offset === null) return null;

  // A span's range is authoritative; a text offset that runs past it means the
  // painter split the run and we're looking at a slice.
  return Math.min(docFrom + offset, docTo);
}

/**
 * Map a caret hit inside `.layout-empty-run` to the enclosing paragraph's
 * content position (`docFrom + 1` when the range has room).
 */
function positionFromEmptyRunHit(
  node: Node,
  container: HTMLElement,
  scope: 'body' | 'hf'
): number | typeof OUTSIDE_POSITION_SCOPE | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const emptyRun = el?.closest<HTMLElement>('.layout-empty-run');
  if (!emptyRun) return null;

  const para = emptyRun.closest<HTMLElement>('.layout-paragraph[data-doc-from][data-doc-to]');
  if (!para) return null;

  if (scope === 'body' && (!para.closest('.layout-page-content') || !isBodyPositionElement(para))) {
    return OUTSIDE_POSITION_SCOPE;
  }
  if (scope === 'hf' && !para.closest('.layout-page-header, .layout-page-footer')) {
    return OUTSIDE_POSITION_SCOPE;
  }
  if (!container.contains(para)) return OUTSIDE_POSITION_SCOPE;

  const docFrom = numberAttr(para, 'docFrom');
  const docTo = numberAttr(para, 'docTo');
  if (docFrom === null || docTo === null) return null;

  // Empty paragraph ranges are typically `[docFrom, docFrom+2)` (open + close).
  // The caret belongs in the content gap: `docFrom + 1`.
  if (docTo > docFrom + 1) return docFrom + 1;
  return docFrom;
}

/** `caretPositionFromPoint` is the standard; WebKit still ships the old one. */
function caretNodeAtPoint(
  doc: Document,
  x: number,
  y: number
): { node: Node; offset: number } | null {
  const std = (
    doc as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number
      ) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint;
  if (typeof std === 'function') {
    const pos = std.call(doc, x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }

  const legacy = (
    doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint;
  if (typeof legacy === 'function') {
    const range = legacy.call(doc, x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  return null;
}

/**
 * The body run span containing `node` — and *only* if it is a body one. A node
 * inside a header/footer walks up to no body span and resolves to null, which is
 * exactly what we want.
 */
function enclosingPaintedSpan(
  node: Node,
  container: HTMLElement,
  scope: 'body' | 'hf'
): HTMLElement | typeof OUTSIDE_POSITION_SCOPE | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const span = el?.closest<HTMLElement>('span[data-doc-from][data-doc-to]');
  if (!span) return null;
  if (scope === 'body' && (!span.closest('.layout-page-content') || !isBodyPositionElement(span))) {
    return OUTSIDE_POSITION_SCOPE;
  }
  if (scope === 'hf' && !span.closest('.layout-page-header, .layout-page-footer')) {
    return OUTSIDE_POSITION_SCOPE;
  }
  if (!container.contains(span)) return OUTSIDE_POSITION_SCOPE;
  return span;
}

/** Characters before `(node, offset)` within `root`. */
function textOffsetWithin(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let text = walker.nextNode() as Text | null;

  while (text) {
    if (text === node) return seen + offset;
    seen += text.data.length;
    text = walker.nextNode() as Text | null;
  }

  // The point landed on the span itself rather than in its text — treat an
  // element offset as "before" or "after" all of it.
  return offset === 0 ? 0 : seen;
}

/**
 * Nearest position on the line the point is on.
 *
 * This is the answer for a click past the end of a line, in the right margin, or
 * in the gap between two runs. Word puts the caret at the nearest character
 * boundary on that line rather than doing nothing, and so do we — a click that
 * moves no caret reads as a broken editor.
 */
function nearestPositionOnLine(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  spans: HTMLElement[] = collectBodySpans(container)
): number | null {
  let best: { pos: number; distance: number } | null = null;

  for (const span of spans) {
    const rect = span.getBoundingClientRect();
    if (clientY < rect.top - LINE_BAND_TOLERANCE_PX) continue;
    if (clientY > rect.bottom + LINE_BAND_TOLERANCE_PX) continue;

    const docFrom = numberAttr(span, 'docFrom');
    const docTo = numberAttr(span, 'docTo');
    if (docFrom === null || docTo === null) continue;

    let pos: number;
    let distance: number;

    if (clientX < rect.left) {
      pos = docFrom;
      distance = rect.left - clientX;
    } else if (clientX > rect.right) {
      pos = docTo;
      distance = clientX - rect.right;
    } else {
      const ratio = (clientX - rect.left) / Math.max(1, rect.width);
      pos = docFrom + proportionalTextOffset(span, ratio, docTo - docFrom);
      distance = 0;
    }

    if (!best || distance < best.distance) best = { pos, distance };
  }

  // Empty paragraphs/cells paint only a 1-glyph nbsp run with no position of
  // its own. Fall back to the full paragraph/line box so a click in the wide
  // empty area of a table cell still lands inside that cell.
  if (!best) {
    const emptyPos = nearestEmptyParagraphOnLine(container, clientX, clientY);
    if (emptyPos !== null) return emptyPos;
  }

  return best?.pos ?? null;
}

/** Nearest empty-paragraph content position on the clicked line band. */
function nearestEmptyParagraphOnLine(
  container: HTMLElement,
  clientX: number,
  clientY: number
): number | null {
  let best: { pos: number; distance: number } | null = null;

  // Body queries must stay scoped (footnote collision); HF hosts pass themselves.
  const runs = container.matches('.layout-page-header, .layout-page-footer')
    ? Array.from(container.querySelectorAll<HTMLElement>('.layout-empty-run'))
    : findBodyEmptyRuns(container);

  for (const run of runs) {
    const para = run.closest<HTMLElement>('.layout-paragraph[data-doc-from][data-doc-to]');
    if (!para || !container.contains(para)) continue;

    // Prefer the line/paragraph box (full cell width) over the tiny nbsp glyph.
    const boxEl =
      (run.closest('.layout-line') as HTMLElement | null) ??
      (para.getBoundingClientRect().width > 0 ? para : run);
    const rect = boxEl.getBoundingClientRect();
    if (clientY < rect.top - LINE_BAND_TOLERANCE_PX) continue;
    if (clientY > rect.bottom + LINE_BAND_TOLERANCE_PX) continue;

    const docFrom = numberAttr(para, 'docFrom');
    const docTo = numberAttr(para, 'docTo');
    if (docFrom === null || docTo === null) continue;

    const pos = docTo > docFrom + 1 ? docFrom + 1 : docFrom;
    let distance = 0;
    if (clientX < rect.left) distance = rect.left - clientX;
    else if (clientX > rect.right) distance = clientX - rect.right;

    if (!best || distance < best.distance) best = { pos, distance };
  }

  return best?.pos ?? null;
}

/**
 * Convert a horizontal box ratio to a PM offset without splitting a grapheme.
 *
 * Position ranges and text lengths normally share UTF-16 addressing. Painted
 * atoms and transformed fallback text can differ, so only apply text boundaries
 * when that invariant holds; their authored one-position ranges remain intact.
 */
function proportionalTextOffset(span: HTMLElement, ratio: number, rangeLength: number): number {
  const clampedLength = Math.max(0, rangeLength);
  const raw = Math.max(0, Math.min(clampedLength, Math.round(ratio * clampedLength)));
  const text = span.textContent ?? '';
  if (text.length !== clampedLength) return raw;

  let nearest = 0;
  let nearestDistance = Infinity;
  for (const boundary of graphemeBoundaries(text)) {
    const distance = Math.abs(boundary - raw);
    if (distance < nearestDistance) {
      nearest = boundary;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// ---------------------------------------------------------------------------
// Position → caret
// ---------------------------------------------------------------------------

/**
 * The caret rectangle for a document position, measured off the painted DOM.
 *
 * `null` when the position isn't painted — a virtualized page, or a position in
 * a header/footer. The caller falls back to layout geometry.
 *
 * @public
 */
export function getCaretPositionFromDom(
  container: HTMLElement,
  pmPos: number,
  containerRect: DOMRect,
  zoom: number
): DomCaretPosition | null {
  const rect = caretRectFor(container, pmPos);
  if (!rect) return null;

  return {
    x: rect.left - containerRect.left,
    y: rect.top - containerRect.top,
    // Height is the one thing the caller does NOT scale: a caret must be the
    // height of the text it sits in, at whatever zoom (#928).
    height: (rect.height || FALLBACK_CARET_HEIGHT) / zoom,
    pageIndex: pageIndexOf(rect.element),
  };
}

interface CaretRect {
  left: number;
  top: number;
  height: number;
  element: HTMLElement;
}

function caretRectFor(container: HTMLElement, pmPos: number): CaretRect | null {
  // 1. Inside a painted run: measure the glyph boundary with a Range. This is
  //    the case that has to be exact, because it's where the caret spends its
  //    life, and it's what makes the caret track the *run*'s height rather than
  //    the line's — a 9pt footnote reference in a 24pt heading gets a short
  //    caret, like Word.
  for (const span of collectBodySpans(container)) {
    const docFrom = numberAttr(span, 'docFrom');
    const docTo = numberAttr(span, 'docTo');
    if (docFrom === null || docTo === null) continue;
    if (pmPos < docFrom || pmPos > docTo) continue;

    const rect = glyphBoundaryRect(span, pmPos - docFrom);
    if (rect) {
      const visible = clipRectToTableWindow(rect, span);
      if (visible) {
        return {
          left: visible.left,
          top: visible.top,
          height: visible.height,
          element: span,
        };
      }
      continue;
    }

    // The span is painted but has no measurable text (an image run, a widget).
    // Interpolate across its box.
    const box = span.getBoundingClientRect();
    const visibleBox = clipRectToTableWindow(box, span);
    if (!visibleBox) continue;
    const ratio = (pmPos - docFrom) / Math.max(1, docTo - docFrom);
    return {
      left: visibleBox.left + visibleBox.width * ratio,
      top: visibleBox.top,
      height: visibleBox.height,
      element: span,
    };
  }

  // 2. An empty paragraph. Its run carries no position — the paragraph does.
  const empty = emptyParagraphRectAt(container, pmPos);
  if (empty) return empty;

  // 3. A position with no run of its own: the end of a paragraph, a boundary
  //    between nodes. Take the tightest painted range that brackets it, and put
  //    the caret at whichever edge the position is nearer.
  const bracketing = tightestRangeContaining(container, pmPos);
  if (bracketing) {
    const atEnd = pmPos >= bracketing.docTo;
    return {
      left: atEnd ? bracketing.rect.right : bracketing.rect.left,
      top: bracketing.rect.top,
      height: bracketing.rect.height,
      element: bracketing.el,
    };
  }

  return null;
}

/** The rect of the character boundary `offset` characters into `span`. */
function glyphBoundaryRect(span: HTMLElement, offset: number): DOMRect | null {
  const doc = span.ownerDocument;
  const walker = doc.createTreeWalker(span, NodeFilter.SHOW_TEXT);

  let remaining = offset;
  let text = walker.nextNode() as Text | null;

  while (text) {
    if (remaining <= text.data.length) {
      try {
        const range = doc.createRange();
        range.setStart(text, remaining);
        range.setEnd(text, remaining);
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        if (rect && rect.height > 0) return rect;
      } catch {
        // A detached or re-rendered node. Fall through to the box estimate.
      }
      return null;
    }
    remaining -= text.data.length;
    text = walker.nextNode() as Text | null;
  }

  return null;
}

/**
 * The caret box for an empty paragraph at `pmPos`.
 *
 * An empty paragraph paints a run with no text and no position of its own, so
 * the position lives on the paragraph wrapper. Without this the caret vanishes
 * the moment you press Enter, and only reappears once you type.
 */
function emptyParagraphRectAt(container: HTMLElement, pmPos: number): CaretRect | null {
  for (const run of findBodyEmptyRuns(container)) {
    const para = run.closest<HTMLElement>('.layout-paragraph[data-doc-from][data-doc-to]');
    if (!para) continue;

    const docFrom = numberAttr(para, 'docFrom');
    const docTo = numberAttr(para, 'docTo');
    if (docFrom === null || docTo === null) continue;
    if (pmPos < docFrom || pmPos > docTo) continue;

    const box = (run.getBoundingClientRect().height > 0 ? run : para).getBoundingClientRect();
    const visible = clipRectToTableWindow(box, para);
    if (!visible) continue;
    return { left: visible.left, top: visible.top, height: visible.height, element: para };
  }
  return null;
}

/** The smallest painted range that brackets `pmPos`. */
function tightestRangeContaining(
  container: HTMLElement,
  pmPos: number
): { el: HTMLElement; docFrom: number; docTo: number; rect: DOMRect } | null {
  let best: { el: HTMLElement; docFrom: number; docTo: number; rect: DOMRect } | null = null;

  for (const el of findBodyPmAnchors(container)) {
    const docFrom = numberAttr(el, 'docFrom');
    const docTo = numberAttr(el, 'docTo');
    if (docFrom === null || docTo === null) continue;
    if (pmPos < docFrom || pmPos > docTo) continue;
    const rect = clipRectToTableWindow(el.getBoundingClientRect(), el);
    if (!rect) continue;

    if (!best || docTo - docFrom < best.docTo - best.docFrom) {
      best = { el, docFrom, docTo, rect };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Range → highlight rectangles
// ---------------------------------------------------------------------------

/**
 * Highlight rectangles for `[from, to)`, measured off the painted DOM.
 *
 * One rectangle per painted line the range covers — a `Range` spanning wrapped
 * text reports one client rect per visual line, which is exactly the partition
 * we want, and is why this doesn't have to know anything about line breaking.
 *
 * Empty when no painted body span overlaps the range; the caller falls back to
 * layout geometry.
 *
 * @public
 */
export function readSelectionGeometry(
  container: HTMLElement,
  from: number,
  to: number,
  containerRect: DOMRect
): DomSelectionBox[] {
  const boxes: DomSelectionBox[] = [];

  for (const span of collectBodySpans(container)) {
    const docFrom = numberAttr(span, 'docFrom');
    const docTo = numberAttr(span, 'docTo');
    if (docFrom === null || docTo === null) continue;
    if (!overlaps(docFrom, docTo, from, to)) continue;

    // A zero-width span is a blank line's marker. There is no text to measure,
    // but the line IS selected, and a selection that skips it looks broken —
    // Word paints a sliver there. Must be checked before the text path: the
    // marker does have a (zero-width) character in it.
    if (docTo === docFrom) {
      const clipped = clipRectToTableWindow(span.getBoundingClientRect(), span);
      if (clipped) pushRect(boxes, clipped, span, containerRect, CARET_SLIVER_WIDTH);
      continue;
    }

    // A tab has no glyphs to measure a sub-range against — highlight all of it.
    if (span.classList.contains('layout-run-tab')) {
      const clipped = clipRectToTableWindow(span.getBoundingClientRect(), span);
      if (clipped) pushRect(boxes, clipped, span, containerRect);
      continue;
    }

    const text = firstTextNode(span);
    if (!text) continue;

    const startChar = Math.max(0, from - docFrom);
    const endChar = Math.min(text.data.length, to - docFrom);
    if (startChar >= endChar) continue;

    const range = span.ownerDocument.createRange();
    range.setStart(text, startChar);
    range.setEnd(text, endChar);

    for (const rect of Array.from(range.getClientRects())) {
      const clipped = clipRectToTableWindow(rect, span);
      if (clipped) pushRect(boxes, clipped, span, containerRect);
    }
  }

  // An empty paragraph inside the range gets a sliver too — same reason as the
  // blank-line marker, different DOM shape.
  for (const run of findBodyEmptyRuns(container)) {
    const para = run.closest<HTMLElement>('.layout-paragraph[data-doc-from][data-doc-to]');
    if (!para) continue;

    const docFrom = numberAttr(para, 'docFrom');
    const docTo = numberAttr(para, 'docTo');
    if (docFrom === null || docTo === null) continue;
    if (!overlaps(docFrom, docTo, from, to)) continue;

    const source = run.getBoundingClientRect().height > 0 ? run : para;
    const clipped = clipRectToTableWindow(source.getBoundingClientRect(), para);
    if (clipped) pushRect(boxes, clipped, para, containerRect, CARET_SLIVER_WIDTH);
  }

  return boxes;
}

/**
 * Clip a rect to every visible window of the split table it's in.
 *
 * A table fragment that broke mid-row paints the *whole* row and relies on
 * `overflow: hidden` to hide the part that belongs to another page. The browser
 * still reports client rects for that hidden text, so a selection crossing the
 * break would paint a highlight through the page margin and over the next
 * fragment. Usually the table element's own box is the window. A continuation
 * fragment with repeated headers has a narrower body window below those headers,
 * stamped with `data-table-body-clip`; body content must also intersect that
 * window while repeated-header content (its sibling) remains selectable.
 *
 * Returns `null` when the rect is entirely outside the window.
 *
 * @public
 */
export function clipRectToTableWindow(rect: DOMRect, el: HTMLElement): DOMRect | null {
  const table = el.closest<HTMLElement>('.layout-table');
  if (!table) return rect;

  const bodyWindow = el.closest<HTMLElement>('[data-table-body-clip]');
  const windows = bodyWindow ? [table, bodyWindow] : [table];
  let top = rect.top;
  let bottom = rect.bottom;
  for (const windowEl of windows) {
    const windowRect = windowEl.getBoundingClientRect();
    top = Math.max(top, windowRect.top);
    bottom = Math.min(bottom, windowRect.bottom);
  }
  if (bottom <= top) return null;

  if (top === rect.top && bottom === rect.bottom) return rect;
  return new DOMRect(rect.left, top, rect.width, bottom - top);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function pushRect(
  out: DomSelectionBox[],
  rect: { left: number; top: number; width: number; height: number },
  element: HTMLElement,
  containerRect: DOMRect,
  forcedWidth?: number
): void {
  out.push({
    x: rect.left - containerRect.left,
    y: rect.top - containerRect.top,
    width: forcedWidth ?? rect.width,
    height: rect.height,
    pageIndex: pageIndexOf(element),
  });
}

/**
 * Half-open overlap of `[aFrom, aTo)` and `[bFrom, bTo)`.
 *
 * A zero-width range (`aFrom === aTo`) — a blank line's marker — still overlaps
 * a selection that strictly contains its position, which is the behaviour that
 * makes selecting across a blank line paint something.
 */
function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && aTo > bFrom;
}

function numberAttr(el: HTMLElement, key: 'docFrom' | 'docTo'): number | null {
  const raw = el.dataset[key];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The text node a run's characters live in. Usually the span's own first child;
 * a hyperlink run wraps it in an `<a>`.
 */
function firstTextNode(span: HTMLElement): Text | null {
  const walker = span.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

/**
 * Which page an element is painted on, 0-based. Read from the page's stamped
 * number rather than counted, so it's right even when the element's container is
 * a single page rather than the whole stack.
 */
function pageIndexOf(el: HTMLElement): number {
  const page = el.closest<HTMLElement>('.layout-page');
  const number = page ? Number(page.dataset.pageNumber) : NaN;
  return Number.isFinite(number) && number >= 1 ? number - 1 : 0;
}
