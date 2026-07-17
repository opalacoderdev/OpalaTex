import type { FootnoteFragment, Page } from '../pagination-model/types';

export interface FootnotePaginationPlan {
  /** Reservations fed back into body composition (may include conservative floors). */
  reservedHeights: Map<number, number>;
  /** Actual painted footnote-area heights, without body-reflow floors. */
  areaHeights: Map<number, number>;
  fragmentsByPage: Map<number, FootnoteFragment[]>;
  footnoteIdsByPage: Map<number, number[]>;
  /** Starts that could not fit on their reference page. */
  deferredStartIdsByPage: Map<number, number[]>;
  minimumPageCount: number;
}

interface FootnoteRefLocationLike {
  footnoteId: number;
  pmPos: number;
  tableNodeId?: string | number;
  rowIndex?: number;
}

export function footnoteReservedHeightsEqual(
  a: Map<number, number>,
  b: Map<number, number>
): boolean {
  if (a.size !== b.size) return false;
  for (const [pageNumber, height] of a) {
    if (b.get(pageNumber) !== height) return false;
  }
  return true;
}

export function footnoteReservedHeightsCover(
  reserved: Map<number, number>,
  required: Map<number, number>
): boolean {
  for (const [pageNumber, height] of required) {
    if ((reserved.get(pageNumber) ?? 0) < height) return false;
  }
  return true;
}

export function mergeFootnoteReservedHeights(
  a: Map<number, number>,
  b: Map<number, number>
): Map<number, number> {
  const merged = new Map(a);
  for (const [pageNumber, height] of b) {
    merged.set(pageNumber, Math.max(merged.get(pageNumber) ?? 0, height));
  }
  return merged;
}

export function footnotePlansEqual(a: FootnotePaginationPlan, b: FootnotePaginationPlan): boolean {
  if (!footnoteReservedHeightsEqual(a.reservedHeights, b.reservedHeights)) return false;
  if (!footnoteReservedHeightsEqual(a.areaHeights, b.areaHeights)) return false;
  if (a.minimumPageCount !== b.minimumPageCount) return false;
  if (a.deferredStartIdsByPage.size !== b.deferredStartIdsByPage.size) return false;
  for (const [pageNumber, ids] of a.deferredStartIdsByPage) {
    const other = b.deferredStartIdsByPage.get(pageNumber);
    if (!other || other.length !== ids.length || ids.some((id, index) => id !== other[index])) {
      return false;
    }
  }
  if (a.fragmentsByPage.size !== b.fragmentsByPage.size) return false;
  for (const [pageNumber, fragments] of a.fragmentsByPage) {
    const other = b.fragmentsByPage.get(pageNumber);
    if (!other || other.length !== fragments.length) return false;
    for (let i = 0; i < fragments.length; i++) {
      const left = fragments[i];
      const right = other[i];
      if (
        left.footnoteId !== right.footnoteId ||
        left.height !== right.height ||
        left.continuesFromPrev !== right.continuesFromPrev ||
        left.continuesOnNext !== right.continuesOnNext ||
        left.columnIndex !== right.columnIndex ||
        left.nodes.length !== right.nodes.length
      ) {
        return false;
      }
      for (let j = 0; j < left.nodes.length; j++) {
        if (JSON.stringify(left.nodes[j]) !== JSON.stringify(right.nodes[j])) return false;
      }
    }
  }
  return true;
}

export function addDeferredStartReservationFloors(
  plan: FootnotePaginationPlan,
  pages: Page[],
  footnoteRefs: FootnoteRefLocationLike[],
  floors: Map<number, number>
): FootnotePaginationPlan {
  for (const [pageNumber, deferredIds] of plan.deferredStartIdsByPage) {
    const page = pages[pageNumber - 1];
    if (!page) continue;
    let firstDeferredY = Number.POSITIVE_INFINITY;

    for (const ref of footnoteRefs) {
      if (!deferredIds.includes(ref.footnoteId)) continue;
      const fragment = page.fragments.find((candidate) => {
        if (ref.tableNodeId != null && ref.rowIndex != null) {
          return (
            candidate.kind === 'table' &&
            String(candidate.nodeId) === String(ref.tableNodeId) &&
            ref.rowIndex >= candidate.fromRow &&
            ref.rowIndex < candidate.toRow
          );
        }
        return (
          candidate.docFrom != null &&
          candidate.docTo != null &&
          ref.pmPos >= candidate.docFrom &&
          ref.pmPos < candidate.docTo
        );
      });
      if (fragment) firstDeferredY = Math.min(firstDeferredY, fragment.y);
    }

    const contentHeight = page.size.h - page.margins.top - page.margins.bottom;
    const bodyBottom = page.size.h - page.margins.bottom;
    // End the body region immediately before the first fragment whose note
    // could not start. The normal composer then carries that reference-bearing
    // content forward on the next pass. If no precise fragment is available,
    // reserve the whole content box; the composer still guarantees progress by
    // placing one leading unit on an otherwise empty page.
    const required =
      firstDeferredY < Number.POSITIVE_INFINITY
        ? Math.max(0, Math.min(contentHeight, bodyBottom - firstDeferredY))
        : contentHeight;
    floors.set(pageNumber, Math.max(floors.get(pageNumber) ?? 0, required));
  }

  return {
    ...plan,
    reservedHeights: mergeFootnoteReservedHeights(plan.reservedHeights, floors),
  };
}
