/**
 * Body-scoped lookups into the painted DOM.
 *
 * Every one of these exists for a single reason: **the body and each
 * header/footer are separate ProseMirror documents, and their integer positions
 * collide.** Position 12 in the body and position 12 in the header are both
 * real, both painted, and completely unrelated. A query that reaches for
 * `[data-doc-from="12"]` across the whole page finds whichever the painter
 * happened to emit first, and the caret lands in the header while the user types
 * into the body.
 *
 * So there is no such thing as an unscoped position lookup here. Every query
 * below is anchored to `.layout-page-content`, the body's subtree, and the
 * header/footer hosts are structurally excluded. The header/footer side has its
 * own mirror of this in `headerFooterLayout.ts`, scoped the other way.
 *
 * Centralising the prefix is the point: a call site that assembled the selector
 * itself would eventually forget it, and the resulting bug looks like "the
 * cursor jumps to the header sometimes".
 *
 * @packageDocumentation
 */

/** The body's painted subtree. Everything here is scoped inside it. */
const BODY_SCOPE = '.layout-page-content';

/** Painted run spans: the elements a document position resolves *into*. */
const RUN_SPAN = 'span[data-doc-from][data-doc-to]';

/** Anything carrying a position range — spans, paragraphs, images, table cells. */
const POSITIONED = '[data-doc-from][data-doc-to]';

/**
 * Footnotes are painted inside the page-content box for layout purposes, but
 * each footnote body has its own ProseMirror document and position space.
 */
const NON_BODY_STORY = '.layout-footnote-area';

/**
 * A paragraph with no text still paints a run, so it still has a caret. That run
 * carries no position of its own (there's no character to address), so callers
 * fall back to the enclosing paragraph's range — this is how they find it.
 */
const EMPTY_RUN = '.layout-empty-run';

/**
 * Every painted body run span, in document order.
 *
 * @public
 */
export function collectBodySpans(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`${BODY_SCOPE} ${RUN_SPAN}`)).filter(
    isBodyPositionElement
  );
}

/**
 * Every painted body run that has no text in it — the empty-paragraph markers.
 *
 * @public
 */
export function findBodyEmptyRuns(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`${BODY_SCOPE} ${EMPTY_RUN}`)).filter(
    isBodyPositionElement
  );
}

/**
 * Every painted body element carrying a position range.
 *
 * Wider than {@link collectBodySpans}: table cells and images are `div`s and
 * `img`s, not spans, and a position inside one still has to resolve.
 *
 * @public
 */
export function findBodyPmAnchors(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`${BODY_SCOPE} ${POSITIONED}`)).filter(
    isBodyPositionElement
  );
}

/**
 * The body element that *starts* exactly at `pmPos`, if the painter emitted one.
 *
 * This is an exact-start lookup, not a containment test — it answers "is there
 * an element anchored here", which is the fast path. Callers that need "which
 * element contains this position" scan {@link collectBodySpans} ranges instead,
 * and use this first because it's a single indexed selector.
 *
 * @public
 */
export function findBodyPmAnchor(root: ParentNode, pmPos: number): HTMLElement | null {
  // The position is interpolated into a selector, so it must be a number and
  // nothing else. It always is — it comes from ProseMirror — but a selector
  // built from an unvalidated value is the kind of thing that stops being true
  // later.
  if (!Number.isInteger(pmPos)) return null;

  return (
    Array.from(root.querySelectorAll<HTMLElement>(`${BODY_SCOPE} [data-doc-from="${pmPos}"]`)).find(
      isBodyPositionElement
    ) ?? null
  );
}

/** Whether a positioned element belongs to the body PM rather than a nested story. */
export function isBodyPositionElement(el: HTMLElement): boolean {
  return el.closest(NON_BODY_STORY) === null;
}

/**
 * Painted run spans inside one exact header/footer host. Callers pass the host
 * that was clicked, so repeated stories on other pages and colliding body PM
 * positions are structurally unreachable.
 *
 * @public
 */
export function collectHfSpans(host: HTMLElement): HTMLElement[] {
  if (!host.matches('.layout-page-header, .layout-page-footer')) return [];
  return Array.from(host.querySelectorAll<HTMLElement>(RUN_SPAN));
}

/** @public */
export function findHfEmptyRuns(host: HTMLElement): HTMLElement[] {
  if (!host.matches('.layout-page-header, .layout-page-footer')) return [];
  return Array.from(host.querySelectorAll<HTMLElement>(EMPTY_RUN));
}

/** @public */
export function findHfPmAnchors(host: HTMLElement): HTMLElement[] {
  if (!host.matches('.layout-page-header, .layout-page-footer')) return [];
  return Array.from(host.querySelectorAll<HTMLElement>(POSITIONED));
}

/** @public */
export function findHfPmAnchor(host: HTMLElement, pmPos: number): HTMLElement | null {
  if (!Number.isInteger(pmPos)) return null;
  if (!host.matches('.layout-page-header, .layout-page-footer')) return null;
  return host.querySelector<HTMLElement>(`[data-doc-from="${pmPos}"]`);
}
