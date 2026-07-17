/**
 * The vertical gap between two content nodes.
 *
 * OOXML gives a paragraph a `spacing.before` and a `spacing.after`, and says
 * nothing about what happens where one paragraph's `after` meets the next one's
 * `before`. Word **collapses** them — the gap is the larger of the two, not
 * their sum — and that is what the editor's spacing suite pins
 * (`integration/contextual-spacing.test.ts` asserts `max(13, 5) === 13`).
 *
 * This is the single place that rule lives. Pagination reads it, and so does
 * column balancing, so a balanced column and a flowed one measure the same
 * paragraph to the same height.
 *
 * @packageDocumentation
 */

import type { BorderKind, ContentNode, ParagraphBlock, ParagraphBorders } from './types';

/**
 * Space a content node asks for above itself, px.
 */
export function spaceBefore(node: ContentNode): number {
  return node.kind === 'paragraph' ? (node.attrs?.spacing?.before ?? 0) : 0;
}

/**
 * Space a content node asks for below itself, px.
 */
export function spaceAfter(node: ContentNode): number {
  return node.kind === 'paragraph' ? (node.attrs?.spacing?.after ?? 0) : 0;
}

/**
 * The gap Word actually leaves between `prev` and `next`.
 *
 * Two rules, in order:
 *
 *  1. **`w:contextualSpacing` (§17.3.1.9)** — "don't add space between
 *     paragraphs of the same style". It suppresses the gap only when *both*
 *     paragraphs opt in and they share a style: a bullet list closes up
 *     internally, but the space above the first bullet and below the last one
 *     survives, because their neighbours are a different style. A paragraph
 *     with no `styleId` has no style to match, so it never suppresses.
 *  2. **Collapse** — otherwise the gap is `max(prev.after, next.before)`.
 *
 * @param prev - the content node above, or null at the top of the flow
 * @param next - the content node below
 */
export function collapsedGap(prev: ContentNode | null, next: ContentNode): number {
  if (!prev) return spaceBefore(next);

  const spacing = isContextuallySuppressed(prev, next)
    ? 0
    : Math.max(spaceAfter(prev), spaceBefore(next));

  // A paragraph border occupies flow height: Word draws the rule `w:space`
  // points away from the text and the following content starts below the rule,
  // not below the text (§17.3.1.24 — the border is part of the paragraph's
  // extent). Without this, two adjacent boxed callouts paint their borders
  // into the spacing gap and visually touch. Inside a border *group* (identical
  // pBdr) the boundary borders are not drawn, so no extent applies there —
  // mirroring what the painter renders via the same `bordersFormGroup`.
  return spacing + borderGapExtent(prev, next);
}

/**
 * Flow height consumed by the borders drawn at the boundary between `prev`
 * and `next`: `prev`'s bottom rule + its `w:space` inset, and `next`'s top
 * rule + inset. Zero when the two group into one box. Additive on top of the
 * collapsed spacing — exported so the column-balance planner budgets the same
 * gap the composer places.
 */
export function borderGapExtent(prev: ContentNode, next: ContentNode): number {
  const prevBorders = prev.kind === 'paragraph' ? prev.attrs?.borders : undefined;
  const nextBorders = next.kind === 'paragraph' ? next.attrs?.borders : undefined;
  if (!prevBorders?.bottom && !nextBorders?.top) return 0;
  // Inside a group the boundary uses the `between` rule, whose `w:space` "is
  // ignored — this border is always located at the bottom of each paragraph"
  // (§17.3.1.5): it consumes no flow height.
  //
  // Known approximation: pagination groups by FLOW adjacency while the painter
  // groups per page fragment, so at a page/column break a split group draws
  // closing/opening rules pagination did not reserve, and a hard break can
  // carry prev's bottom extent onto the next page's first gap. Both are a
  // few px and only at region boundaries.
  if (bordersFormGroup(prevBorders, nextBorders)) return 0;
  return borderExtent(prevBorders?.bottom) + borderExtent(nextBorders?.top);
}

/** Vertical px a drawn border edge adds to the paragraph: rule width + `w:space` inset. */
function borderExtent(border: BorderKind | undefined): number {
  if (!border) return 0;
  // The painter renders `double` rules at a 3px minimum (borderToCss); reserve
  // the same height or the rule paints beyond the budgeted extent.
  const width = border.style === 'double' ? Math.max(border.width ?? 1, 3) : (border.width ?? 1);
  return width + (border.space ?? 0);
}

/**
 * Check if two individual border definitions are equal. `w:space` is part of
 * the identity: §17.3.1.5's own example splits two otherwise-identical
 * paragraphs into separate boxes because only their space values differ.
 */
function bordersEqual(a?: BorderKind, b?: BorderKind): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.style === b.style &&
    a.width === b.width &&
    a.color === b.color &&
    (a.space ?? 0) === (b.space ?? 0) &&
    (a.shadow ?? false) === (b.shadow ?? false)
  );
}

/**
 * Check if two ParagraphBorders form a group (ECMA-376 §17.3.1.24).
 * Adjacent paragraphs with identical border definitions belong to the same
 * group: one box, with `between` rules at interior boundaries. The painter
 * decides which rules to draw with this same predicate, so pagination and
 * paint agree on where a border consumes flow height.
 */
export function bordersFormGroup(a?: ParagraphBorders, b?: ParagraphBorders): boolean {
  if (!a && !b) return false; // no borders = no group
  if (!a || !b) return false;
  return (
    bordersEqual(a.top, b.top) &&
    bordersEqual(a.bottom, b.bottom) &&
    bordersEqual(a.left, b.left) &&
    bordersEqual(a.right, b.right) &&
    bordersEqual(a.between, b.between) &&
    bordersEqual(a.bar, b.bar)
  );
}

/**
 * True when `w:contextualSpacing` cancels the gap between these two.
 */
function isContextuallySuppressed(prev: ContentNode, next: ContentNode): boolean {
  if (prev.kind !== 'paragraph' || next.kind !== 'paragraph') return false;

  const a = prev as ParagraphBlock;
  const b = next as ParagraphBlock;

  if (!a.attrs?.contextualSpacing || !b.attrs?.contextualSpacing) return false;

  const styleA = a.attrs.styleId;
  const styleB = b.attrs.styleId;
  return styleA != null && styleA === styleB;
}
