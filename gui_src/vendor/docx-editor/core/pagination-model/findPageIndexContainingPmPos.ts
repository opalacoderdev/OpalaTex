import type { PageLayout } from './types';

/**
 * Page index (0-based) whose layout fragments cover `pmPos`, or null if none.
 * Used when the painted DOM may not yet have `[data-doc-from]` for this position (virtualization).
 *
 * Range semantics: `[docFrom, docTo)` — half-open, matching ProseMirror's
 * `pos + nodeSize` convention. Boundary positions belong to the next fragment,
 * so when a fragment ends at the same position the next one starts, the next
 * fragment wins (avoids returning the previous page for the start of the
 * next paragraph).
 */
export function findPageIndexContainingPmPos(layout: PageLayout, pmPos: number): number | null {
  for (let pi = 0; pi < layout.pages.length; pi++) {
    for (const frag of layout.pages[pi].fragments) {
      if (frag.docFrom == null) continue;
      const start = frag.docFrom;
      // Default span of 1 only when docTo is missing — matches a caret-only
      // position (cursor between two atoms). Fragments with explicit docTo
      // use it as the exclusive upper bound.
      const end = frag.docTo ?? start + 1;
      if (pmPos >= start && pmPos < end) {
        return pi;
      }
    }
  }
  return null;
}
