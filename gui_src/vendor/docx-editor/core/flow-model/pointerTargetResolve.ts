/**
 * Hit-testing against the layout model — no DOM required.
 *
 * The painted-DOM path (`resolveDomPosition.ts`) is the one the editor uses for
 * clicks, because only the browser knows where a glyph really landed. This is
 * the other path: the same question answered from the `PageLayout` value alone.
 *
 * It earns its place twice. It is the **fallback** when the DOM can't answer — a
 * click in the page margin, in the gutter between pages, below the last line —
 * where there is no painted run to hit but there is still a right answer. And it
 * is **testable without a browser**, which is what lets the flow's geometry be
 * checked at all.
 *
 * Coordinates are **page-stack space**: the origin is the top-left of page 1,
 * pages are stacked with `pageGap` between them, and everything is in layout px
 * (zoom already divided out).
 *
 * @packageDocumentation
 */

import type {
  ContentNode,
  Fragment,
  PageLayout,
  LayoutMetrics,
  Page,
  TableBlock,
  TableCell,
  TableCellMetrics,
  TableMetrics,
} from '../pagination-model/types';
import { resolveCellGrid } from './tableWidthUtils';

/** Word's default gap painted between pages, px — used when the layout omits one. */
const DEFAULT_PAGE_GAP_PX = 24;

/**
 * A point in page-stack space.
 *
 * @public
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * A page, and where in it the point fell.
 *
 * @public
 */
export interface PageTarget {
  pageIndex: number;
  page: Page;
  /** Y within the page, from its top edge. */
  pageY: number;
}

/**
 * A fragment, the node it paints, and where in it the point fell.
 *
 * @public
 */
export interface FragmentTarget {
  fragment: Fragment;
  node: ContentNode;
  metrics: LayoutMetrics;
  pageIndex: number;
  /** The point, relative to the fragment's top-left. */
  localX: number;
  localY: number;
}

/**
 * A table cell, and where in it the point fell.
 *
 * @public
 */
export interface TableCellTarget {
  rowIndex: number;
  columnIndex: number;
  cell: TableCell;
  /** The cell's measured content, index-aligned with `cell.nodes`. */
  metrics: TableCellMetrics;
  /** The point, relative to the cell's content box (inside its padding). */
  localX: number;
  localY: number;
  /** Width the cell's content was laid out at. */
  contentWidth: number;
}

/**
 * Everything a point resolves to.
 *
 * @public
 */
export interface PointerTargetResult {
  pageTarget: PageTarget;
  fragmentTarget?: FragmentTarget;
  tableCellTarget?: TableCellTarget;
}

/**
 * Resolve a point in page-stack space to whatever it lands on.
 *
 * @public
 */
export function pointerTargetResolve(
  layout: PageLayout,
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  point: Point
): PointerTargetResult | null {
  const pageTarget = locatePageTarget(layout, point);
  if (!pageTarget) return null;

  const pagePoint: Point = { x: point.x, y: pageTarget.pageY };
  const fragmentTarget = resolveFragmentTarget(pageTarget, nodes, metrics, pagePoint);
  if (!fragmentTarget) return { pageTarget };

  const tableCellTarget =
    fragmentTarget.fragment.kind === 'table'
      ? (resolveTableCellTarget(pageTarget, nodes, metrics, pagePoint) ?? undefined)
      : undefined;

  return { pageTarget, fragmentTarget, tableCellTarget };
}

/**
 * Which page a Y falls on.
 *
 * A Y in the *gutter* between two pages belongs to the page above it: the user
 * clicked below the end of that page's content, and the nearest text is its last
 * line. Snapping down to the next page instead would send the caret to the top
 * of the following page, which reads as the click having gone somewhere else
 * entirely.
 *
 * @public
 */
export function locatePageTarget(layout: PageLayout, point: Point): PageTarget | null {
  if (layout.pages.length === 0) return null;

  let top = 0;
  for (let i = 0; i < layout.pages.length; i++) {
    const page = layout.pages[i];
    const bottom = top + page.size.h;

    // Below this page but above the next: still this page.
    if (point.y < bottom + pageGap(layout) || i === layout.pages.length - 1) {
      return {
        pageIndex: i,
        page,
        pageY: clamp(point.y - top, 0, page.size.h),
      };
    }
    top = bottom + pageGap(layout);
  }

  return null;
}

/**
 * The fragment under a page-relative point, or the nearest one.
 *
 * "Nearest" is what makes a click in the margin work. A user who clicks to the
 * right of a short line, or below the last paragraph, means *that* line — so a
 * point that is inside no fragment falls back to the fragment whose box it is
 * closest to, measured vertically first, because a page is read down.
 *
 * @public
 */
export function resolveFragmentTarget(
  pageTarget: PageTarget,
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  point: Point
): FragmentTarget | null {
  const index = nodeIndex(nodes, metrics);

  let best: FragmentTarget | null = null;
  let bestDistance = Infinity;

  for (const fragment of pageTarget.page.fragments) {
    const at = index.get(String(fragment.nodeId));
    if (!at) continue;

    const distance = distanceToBox(point, fragment);
    if (distance >= bestDistance) continue;

    bestDistance = distance;
    best = {
      fragment,
      node: at.node,
      metrics: at.metrics,
      pageIndex: pageTarget.pageIndex,
      localX: point.x - fragment.x,
      localY: point.y - fragment.y,
    };

    if (distance === 0) break; // Inside it — nothing can be nearer.
  }

  return best;
}

/**
 * Same as {@link resolveFragmentTarget}, restricted to image fragments — for
 * picking up an image to drag without the paragraph under it stealing the hit.
 *
 * @public
 */
export function resolveImageFragmentTarget(
  pageTarget: PageTarget,
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  point: Point
): FragmentTarget | null {
  const imagesOnly: PageTarget = {
    ...pageTarget,
    page: {
      ...pageTarget.page,
      fragments: pageTarget.page.fragments.filter((f) => f.kind === 'image'),
    },
  };
  const hit = resolveFragmentTarget(imagesOnly, nodes, metrics, point);
  // Only a *direct* hit counts: an image you didn't click on isn't one you meant
  // to grab.
  return hit && distanceToBox(point, hit.fragment) === 0 ? hit : null;
}

/**
 * The table cell under a page-relative point.
 *
 * Resolves through the shared grid (`resolveCellGrid`), so "which cell covers
 * row 3, column 2" means the same thing here as it does to the measurer and the
 * painter — merged cells included. A hand-rolled row/column walk would disagree
 * with them the moment a `w:vMerge` or a `w:gridSpan` shows up.
 *
 * @public
 */
export function resolveTableCellTarget(
  pageTarget: PageTarget,
  nodes: ContentNode[],
  allMetrics: LayoutMetrics[],
  point: Point
): TableCellTarget | null {
  const hit = resolveFragmentTarget(pageTarget, nodes, allMetrics, point);
  if (!hit || hit.fragment.kind !== 'table') return null;
  if (hit.node.kind !== 'table' || hit.metrics.kind !== 'table') return null;

  const node = hit.node as TableBlock;
  const tableMetrics = hit.metrics as TableMetrics;
  const fragment = hit.fragment;

  // The fragment paints rows [fromRow, toRow), with the first one clipped by
  // `topClip` when it began on the previous page. Local Y is measured from the
  // fragment's top, so the clipped part has to be added back to land in the
  // table's own coordinate space.
  const tableY = hit.localY + rowTop(tableMetrics, fragment.fromRow) + (fragment.topClip ?? 0);
  const tableX = hit.localX;

  const rowIndex = rowAt(tableMetrics, tableY, fragment.fromRow, fragment.toRow);
  if (rowIndex === null) return null;

  const columnIndex = columnAt(tableMetrics, tableX);
  if (columnIndex === null) return null;

  // The grid tells us which authored cell actually *covers* this (row, column) —
  // which is not the cell at that index when anything above it is merged down.
  const covering = resolveCellGrid(node).find(
    (g) =>
      g.columnIndex <= columnIndex &&
      columnIndex < g.columnIndex + (g.colSpan ?? 1) &&
      g.rowIndex <= rowIndex &&
      rowIndex < g.rowIndex + (g.rowSpan ?? 1)
  );
  if (!covering) return null;

  const cell = node.rows[covering.rowIndex]?.cells?.[covering.cellIndex];
  const cellMetrics = tableMetrics.rows[covering.rowIndex]?.cells?.[covering.cellIndex];
  if (!cell || !cellMetrics) return null;

  const padLeft = cell.padding?.left ?? 0;
  const padTop = cell.padding?.top ?? 0;
  const cellWidth = columnWidth(tableMetrics, covering.columnIndex, covering.colSpan ?? 1);

  return {
    rowIndex: covering.rowIndex,
    columnIndex: covering.columnIndex,
    cell,
    metrics: cellMetrics,
    localX: tableX - columnLeft(tableMetrics, covering.columnIndex) - padLeft,
    localY: tableY - rowTop(tableMetrics, covering.rowIndex) - padTop,
    contentWidth: Math.max(0, cellWidth - padLeft - (cell.padding?.right ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Page-stack arithmetic
// ---------------------------------------------------------------------------

/**
 * Y of a page's top edge in the page stack. Page 0 is at 0.
 *
 * @public
 */
export function pageTopOffset(layout: PageLayout, pageIndex: number): number {
  const gap = pageGap(layout);
  let y = 0;
  for (let i = 0; i < pageIndex && i < layout.pages.length; i++) {
    y += layout.pages[i].size.h + gap;
  }
  return y;
}

/**
 * Which page a Y in the page stack is on. Clamped to a real page.
 *
 * @public
 */
export function pageIndexForY(layout: PageLayout, y: number): number {
  const gap = pageGap(layout);
  let top = 0;
  for (let i = 0; i < layout.pages.length; i++) {
    const bottom = top + layout.pages[i].size.h;
    if (y < bottom + gap) return i;
    top = bottom + gap;
  }
  return Math.max(0, layout.pages.length - 1);
}

/**
 * Height of the whole page stack, gaps included.
 *
 * @public
 */
export function getTotalDocumentHeight(layout: PageLayout): number {
  const gap = pageGap(layout);
  const pages = layout.pages.reduce((h, page) => h + page.size.h, 0);
  return pages + Math.max(0, layout.pages.length - 1) * gap;
}

/**
 * Scroll offset that brings a page's top edge into view.
 *
 * @public
 */
export function getScrollYForPage(layout: PageLayout, pageIndex: number): number {
  return pageTopOffset(layout, clamp(pageIndex, 0, layout.pages.length - 1));
}

/**
 * A page's box in page-stack space.
 *
 * @public
 */
export function getPageBounds(
  layout: PageLayout,
  pageIndex: number
): {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
} | null {
  const page = layout.pages[pageIndex];
  if (!page) return null;

  const top = pageTopOffset(layout, pageIndex);
  return {
    top,
    bottom: top + page.size.h,
    left: 0,
    right: page.size.w,
    width: page.size.w,
    height: page.size.h,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pageGap(layout: PageLayout): number {
  return layout.pageGap ?? DEFAULT_PAGE_GAP_PX;
}

/**
 * How far a point is from a box: 0 inside it, otherwise the distance to it.
 *
 * Vertical distance is weighted far more heavily than horizontal, because a page
 * is read down: a click level with a short line but far to its right means that
 * line, not the one below it that happens to be longer.
 */
const VERTICAL_WEIGHT = 8;

function distanceToBox(
  point: Point,
  box: { x: number; y: number; width: number; height: number }
): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return dx + dy * VERTICAL_WEIGHT;
}

/**
 * `node.id → (node, metrics)`, so a fragment can find what it paints.
 *
 * A fragment carries a `nodeId`, not an index, because a paragraph that split
 * across three pages produces three fragments that all point at the same node.
 */
function nodeIndex(
  nodes: ContentNode[],
  allMetrics: LayoutMetrics[]
): Map<string, { node: ContentNode; metrics: LayoutMetrics }> {
  const map = new Map<string, { node: ContentNode; metrics: LayoutMetrics }>();
  for (let i = 0; i < nodes.length; i++) {
    const metrics = allMetrics[i];
    if (metrics) map.set(String(nodes[i].id), { node: nodes[i], metrics });
  }
  return map;
}

function rowTop(metrics: TableMetrics, rowIndex: number): number {
  let y = 0;
  for (let i = 0; i < rowIndex && i < metrics.rows.length; i++) {
    y += metrics.rows[i].height;
  }
  return y;
}

function rowAt(metrics: TableMetrics, y: number, fromRow: number, toRow: number): number | null {
  if (metrics.rows.length === 0) return null;

  let top = rowTop(metrics, fromRow);
  for (let i = fromRow; i < Math.min(toRow, metrics.rows.length); i++) {
    const bottom = top + metrics.rows[i].height;
    if (y < bottom) return i;
    top = bottom;
  }
  return Math.min(toRow, metrics.rows.length) - 1;
}

function columnLeft(metrics: TableMetrics, columnIndex: number): number {
  let x = 0;
  for (let i = 0; i < columnIndex && i < metrics.columnWidths.length; i++) {
    x += metrics.columnWidths[i];
  }
  return x;
}

function columnWidth(metrics: TableMetrics, columnIndex: number, span: number): number {
  let w = 0;
  for (let i = columnIndex; i < columnIndex + span && i < metrics.columnWidths.length; i++) {
    w += metrics.columnWidths[i];
  }
  return w;
}

function columnAt(metrics: TableMetrics, x: number): number | null {
  if (metrics.columnWidths.length === 0) return null;

  let left = 0;
  for (let i = 0; i < metrics.columnWidths.length; i++) {
    const right = left + metrics.columnWidths[i];
    if (x < right) return i;
    left = right;
  }
  return metrics.columnWidths.length - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
