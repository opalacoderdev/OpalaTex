/**
 * The layout cursor, and the regions it moves through.
 *
 * The primitives the flow is written in terms of, kept apart from the flow
 * itself so that the page composer and the table composer share one definition
 * of where the pen is and what "out of room" means — rather than each carrying
 * its own, which is how two halves of a layout engine start disagreeing about
 * where a page ends.
 *
 * The cursor is a **value**. Nothing here mutates one: every move returns a new
 * cursor. The page list is the only accumulator, because a page genuinely is
 * append-only — fragments go on, nothing comes off.
 *
 * @packageDocumentation
 */

import type {
  ColumnLayout,
  ContentNode,
  Fragment,
  LayoutConfig,
  LayoutMetrics,
  PageMargins,
  SectionLayoutConfig,
  Size,
} from './types';
import { collapsedGap } from './blockSpacingRules';
import { getMinimumParagraphFragmentLineCount } from './paragraphPagination';

/**
 * Sub-pixel slack when asking "does this fit". Measured heights come from
 * canvas metrics and browser layout, which disagree in the last fraction of a
 * pixel; without slack, a line that fits exactly gets pushed to the next page
 * and the document grows a spurious page.
 */
export const FIT_TOLERANCE_PX = 0.5;

/** Word's default header/footer distance from the page edge, px (0.5in). */
const DEFAULT_HF_DISTANCE_PX = 48;

/**
 * How far a keep-with-next chain is followed. A chain longer than this is
 * almost certainly a document that has set `w:keepNext` on every paragraph, and
 * honouring it would mean trying to fit the whole document on one page. Word
 * gives up too.
 */
const KEEP_CHAIN_LIMIT = 32;

/**
 * The rectangle content flows into: one column of one page's content box.
 */
export interface ColumnRegion {
  left: number;
  width: number;
  top: number;
  bottom: number;
}

/**
 * A page under construction. `fragments` is the append-only part.
 */
export interface PageDraft {
  number: number;
  size: Size;
  margins: PageMargins;
  fragments: Fragment[];
  columns?: ColumnLayout;
  sectionIndex?: number;
  sectionPageNumber?: number;
  headerFooterRefs?: SectionLayoutConfig['headerFooterRefs'];
  footnoteReservedHeight?: number;
  /**
   * A shortened bottom for this page's columns, so a terminal multi-column
   * region comes out balanced. See `columnBalancing.ts`.
   */
  columnBalanceBottom?: number;
  /** Block indexes that must open a new column under the current balance plan. */
  columnBalanceBreakBefore?: Set<number>;
  /**
   * Where this page's column region begins. Defaults to the top margin; a
   * `continuous` section break that opens columns mid-page moves it down to the
   * pen, so every column of that region starts on the same line.
   */
  columnRegionTop?: number;
}

/**
 * Where the pen is. A value: placement functions return a new one rather than
 * writing to this.
 */
export interface LayoutCursor {
  readonly pageIndex: number;
  readonly columnIndex: number;
  /** Page-absolute Y of the pen. */
  readonly y: number;
  /** The content node above the pen, for the spacing-collapse rule. */
  readonly prev: ContentNode | null;
  /** Suppress inherited top spacing after a standalone structural page break. */
  readonly suppressInheritedSpaceBeforeAtTop?: boolean;
}

/** Everything the placement functions need but never change. */
export interface FlowContext {
  nodes: ContentNode[];
  metrics: LayoutMetrics[];
  config: LayoutConfig;
  pages: PageDraft[];
  /** Section geometry in force, replaced when a section break is crossed. */
  section: SectionLayoutConfig;
  /** Zero-based section currently receiving newly-created pages. */
  sectionIndex: number;
  /** Number of pages already created for each section. */
  sectionPageCounts: Map<number, number>;
}

interface InternalLayoutConfig extends LayoutConfig {
  resolvePageMargins?: (args: {
    base: PageMargins;
    pageNumber: number;
    sectionIndex: number;
    sectionPageNumber: number;
  }) => PageMargins;
  onPageStart?: (args: {
    pageNumber: number;
    sectionIndex: number;
    sectionPageNumber: number;
    margins: PageMargins;
  }) => void;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The header and footer live *inside* the top and bottom margins, at their
 * `w:header`/`w:footer` distance from the page edge (§17.6.11). They only push
 * the body inward when their painted band outgrows the margin that contains it.
 *
 * This is the corrected reading. Subtracting a flat header reserve from the
 * content box — the obvious-looking alternative — shrinks every page by a band
 * the margin already paid for, and the document grows pages Word doesn't have.
 */
export function effectiveMargins(
  base: PageMargins,
  pageNumber: number,
  config: LayoutConfig
): PageMargins {
  const headerHeight = bandHeight(config.headerContentHeights, pageNumber);
  const footerHeight = bandHeight(config.footerContentHeights, pageNumber);
  if (headerHeight === 0 && footerHeight === 0) return base;

  const headerBand = (base.header ?? DEFAULT_HF_DISTANCE_PX) + headerHeight;
  const footerBand = (base.footer ?? DEFAULT_HF_DISTANCE_PX) + footerHeight;

  return {
    ...base,
    top: headerHeight > 0 ? Math.max(base.top, headerBand) : base.top,
    bottom: footerHeight > 0 ? Math.max(base.bottom, footerBand) : base.bottom,
  };
}

/** Which header/footer variant a page shows (`w:titlePg`, even/odd). */
export function bandHeight(
  heights: { default?: number; first?: number; even?: number } | undefined,
  pageNumber: number
): number {
  if (!heights) return 0;
  if (pageNumber === 1 && heights.first != null) return heights.first;
  if (pageNumber % 2 === 0 && heights.even != null) return heights.even;
  return heights.default ?? 0;
}

/**
 * The content rectangle of one column on one page.
 *
 * Width and left edge come from the SAME source, which is the only subtle part.
 * A section with `w:equalWidth="0"` gives each column its own `w:w`, and a left
 * edge derived from the equal-width formula would place a correctly-*sized*
 * column at the wrong X — columns overlapping each other, text on text. So the
 * left edge is the prefix sum of the widths that precede it.
 */
export function regionFor(page: PageDraft, columnIndex: number): ColumnRegion {
  const contentWidth = page.size.w - page.margins.left - page.margins.right;
  const count = Math.max(1, page.columns?.count ?? 1);
  const gap = page.columns?.gap ?? 0;

  const equalWidth = Math.floor((contentWidth - (count - 1) * gap) / count);
  const widthOf = (i: number): number =>
    count > 1 ? (page.columns?.widths?.[i] ?? equalWidth) : contentWidth;

  let left = page.margins.left;
  for (let i = 0; i < columnIndex; i++) {
    left += widthOf(i) + gap;
  }

  const bottom = page.size.h - page.margins.bottom - (page.footnoteReservedHeight ?? 0);

  return {
    left,
    width: widthOf(columnIndex),
    // A multi-column region that opened mid-page (a `continuous` section break)
    // starts where the pen was, not at the top margin — its columns sit BESIDE
    // each other in the space below the single-column text above them. Taking
    // the top margin here would start column 2 at the top of the page, painting
    // it straight over that text.
    top: page.columnRegionTop ?? page.margins.top,
    // The balanced bottom only applies to the columns it was computed for.
    bottom: page.columns ? Math.min(bottom, page.columnBalanceBottom ?? Infinity) : bottom,
  };
}

export function currentRegion(ctx: FlowContext, cursor: LayoutCursor): ColumnRegion {
  return regionFor(ctx.pages[cursor.pageIndex], cursor.columnIndex);
}

export function columnCount(page: PageDraft): number {
  return page.columns?.count ?? 1;
}

// ---------------------------------------------------------------------------
// Moving the cursor
// ---------------------------------------------------------------------------

/** Append a fresh page and put the pen at the top of its first column. */
export function startPage(ctx: FlowContext, prev: ContentNode | null = null): LayoutCursor {
  const number = ctx.pages.length + 1;
  const sectionPageNumber = (ctx.sectionPageCounts.get(ctx.sectionIndex) ?? 0) + 1;
  ctx.sectionPageCounts.set(ctx.sectionIndex, sectionPageNumber);
  const internalConfig = ctx.config as InternalLayoutConfig;
  const margins =
    internalConfig.resolvePageMargins?.({
      base: ctx.section.margins,
      pageNumber: number,
      sectionIndex: ctx.sectionIndex,
      sectionPageNumber,
    }) ?? effectiveMargins(ctx.section.margins, number, ctx.config);
  const page: PageDraft = {
    number,
    size: ctx.section.pageSize,
    margins,
    fragments: [],
    columns: (ctx.section.columns?.count ?? 1) > 1 ? ctx.section.columns : undefined,
    sectionIndex: ctx.sectionIndex,
    sectionPageNumber,
    headerFooterRefs: ctx.section.headerFooterRefs,
    footnoteReservedHeight: ctx.config.footnoteReservedHeights?.get(number),
  };
  ctx.pages.push(page);
  internalConfig.onPageStart?.({
    pageNumber: number,
    sectionIndex: ctx.sectionIndex,
    sectionPageNumber,
    margins,
  });

  return {
    pageIndex: ctx.pages.length - 1,
    columnIndex: 0,
    y: regionFor(page, 0).top,
    prev,
  };
}

/** Next column, or the next page when this was the last one. */
export function nextColumn(ctx: FlowContext, cursor: LayoutCursor): LayoutCursor {
  const page = ctx.pages[cursor.pageIndex];
  if (cursor.columnIndex + 1 < columnCount(page)) {
    return {
      ...cursor,
      columnIndex: cursor.columnIndex + 1,
      y: regionFor(page, cursor.columnIndex + 1).top,
    };
  }
  return startPage(ctx, cursor.prev);
}

/**
 * Out of room in this region — move to wherever the next one is.
 *
 * In a multi-column section that's the next column, and only the last column
 * spills onto a new page. That is the whole of column flow: fill one, then the
 * next, then break.
 */
export function overflow(ctx: FlowContext, cursor: LayoutCursor): LayoutCursor {
  return nextColumn(ctx, cursor);
}

/** True when nothing has been placed in the region the pen is in. */
export function regionIsEmpty(ctx: FlowContext, cursor: LayoutCursor): boolean {
  return cursor.y <= currentRegion(ctx, cursor).top + FIT_TOLERANCE_PX;
}

/** True when nothing has been placed anywhere on the pen's page. */
export function pageIsEmpty(ctx: FlowContext, cursor: LayoutCursor): boolean {
  return ctx.pages[cursor.pageIndex].fragments.length === 0;
}

// ---------------------------------------------------------------------------
// Keep-with-next
// ---------------------------------------------------------------------------

/**
 * How much room the keep-with-next chain starting at `index` needs before its
 * promise can be kept: every chained node in full, plus enough of the node
 * that ends the chain to get its first line (or first row) onto the same page.
 *
 * Returns 0 when `index` doesn't start a chain.
 */
export function keepNextChainHeight(ctx: FlowContext, cursor: LayoutCursor, index: number): number {
  const first = ctx.nodes[index];
  if (!hasKeepNext(first)) return 0;

  let need = 0;
  let prev = cursor.prev;

  for (let i = index; i < ctx.nodes.length && i - index < KEEP_CHAIN_LIMIT; i++) {
    const node = ctx.nodes[i];
    const metrics = ctx.metrics[i];
    if (!isContent(node)) break;

    need += collapsedGap(prev, node);

    if (!hasKeepNext(node)) {
      // The chain ends here: budget the minimum legal first fragment.
      need += leadingAnchorHeight(node, metrics);
      return need;
    }

    need += fullHeight(metrics);
    prev = node;
  }

  return need;
}

function hasKeepNext(node: ContentNode): boolean {
  return node.kind === 'paragraph' && node.attrs?.keepNext === true;
}

/** Content nodes that actually occupy vertical space. */
function isContent(node: ContentNode): boolean {
  return (
    node.kind === 'paragraph' ||
    node.kind === 'table' ||
    node.kind === 'image' ||
    node.kind === 'textBox'
  );
}

function fullHeight(metrics: LayoutMetrics | undefined): number {
  if (!metrics) return 0;
  switch (metrics.kind) {
    case 'paragraph':
      return metrics.lines.reduce((h, l) => h + l.lineHeight + (l.floatSkipBefore ?? 0), 0);
    case 'table':
      return metrics.totalHeight;
    case 'image':
    case 'textBox':
      return metrics.height;
    default:
      return 0;
  }
}

/** The smallest slice of a node that still counts as "it started on this page". */
function leadingUnitHeight(metrics: LayoutMetrics | undefined): number {
  if (!metrics) return 0;
  switch (metrics.kind) {
    case 'paragraph': {
      const line = metrics.lines[0];
      return line ? line.lineHeight + (line.floatSkipBefore ?? 0) : 0;
    }
    case 'table':
      return metrics.rows[0]?.height ?? 0;
    case 'image':
    case 'textBox':
      // Neither splits, so "starting" means "fitting".
      return metrics.height;
    default:
      return 0;
  }
}
function leadingAnchorHeight(node: ContentNode, metrics: LayoutMetrics | undefined): number {
  if (!metrics) return 0;
  if (node.kind === 'paragraph' && metrics.kind === 'paragraph') {
    const lineCount = metrics.lines.length;
    if (lineCount === 0) return 0;
    const allHeight = metrics.lines.reduce(
      (h, line) => h + line.lineHeight + (line.floatSkipBefore ?? 0),
      0
    );
    if (node.attrs?.keepLines) return allHeight;
    const minLines = getMinimumParagraphFragmentLineCount(node, lineCount);
    let height = 0;
    for (let i = 0; i < Math.min(minLines, metrics.lines.length); i++) {
      const line = metrics.lines[i];
      height += line.lineHeight + (line.floatSkipBefore ?? 0);
    }
    return height;
  }
  return leadingUnitHeight(metrics);
}

/**
 * Break the page ahead of `index` if the keep-with-next chain it starts can't be
 * honoured where the pen is.
 *
 * A chain taller than a whole region can never be honoured, and forcing a break
 * for it would only push it to an equally short page — an infinite regress that
 * shows up as a run of near-empty pages. Word abandons `w:keepNext` in exactly
 * that case, and so do we.
 */
export function applyKeepNext(ctx: FlowContext, cursor: LayoutCursor, index: number): LayoutCursor {
  const region = currentRegion(ctx, cursor);
  const need = keepNextChainHeight(ctx, cursor, index);
  if (need === 0) return cursor;

  const regionHeight = region.bottom - region.top;
  if (need > regionHeight + FIT_TOLERANCE_PX) return cursor; // Unsatisfiable — ignore it.

  if (need <= region.bottom - cursor.y + FIT_TOLERANCE_PX) return cursor; // It fits.
  if (regionIsEmpty(ctx, cursor)) return cursor; // Already at the top; moving won't help.

  return overflow(ctx, cursor);
}
