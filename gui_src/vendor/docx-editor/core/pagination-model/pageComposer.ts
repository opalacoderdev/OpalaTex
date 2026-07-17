/**
 * The flow — nodes and their metrics in, positioned pages out.
 *
 * This is a fold. The layout cursor (which page, which column, where the pen
 * sits) is a **value** threaded through the placement functions, not an object
 * they mutate: every `place*` takes a cursor and returns the cursor that
 * results. Break rules are pure predicates over that value. The point isn't
 * purity for its own sake — it's that "why did this paragraph land on page 4"
 * is answerable by reading one call chain, instead of by reconstructing the
 * history of a mutable pen.
 *
 * The one thing that *is* accumulated is the page list itself, because a page
 * is genuinely append-only: fragments go on, nothing comes off.
 *
 * @packageDocumentation
 */

import type {
  ContentNode,
  ImageBlock,
  ImageMetrics,
  PageLayout,
  LayoutConfig,
  LayoutMetrics,
  Page,
  ParagraphBlock,
  ParagraphMetrics,
  SectionLayoutConfig,
  TableMetrics,
  TextBoxBlock,
  TextBoxMetrics,
} from './types';
import { assertExhaustiveContentNode } from './types';
import { collectSectionConfigs } from './sectionPlan';
import {
  FIT_TOLERANCE_PX,
  applyKeepNext,
  nextColumn,
  overflow,
  pageIsEmpty,
  currentRegion,
  regionIsEmpty,
  startPage,
  type LayoutCursor,
  type FlowContext,
  type PageDraft,
  type ColumnRegion,
} from './layoutCursor';
import { collapsedGap } from './blockSpacingRules';
import { isFloatingTextBoxBlock } from './textBoxFlow';
import { layoutTable } from './tableLayout';
import { planContinuousSectionBalance } from './columnBalancing';

/** Word's default gap painted between pages, px. */
const DEFAULT_PAGE_GAP_PX = 24;

/**
 * Flow measured nodes onto pages.
 *
 * `nodes` and `metrics` are index-aligned: `metrics[i]` is how tall
 * `nodes[i]` is at the width it will be laid out in. Measurement has already
 * happened — this function never measures anything, which is what lets the
 * whole flow be tested with synthetic metrics and no canvas.
 *
 * @public
 */
export function layOutPages(
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  config: LayoutConfig
): PageLayout {
  const initial: SectionLayoutConfig = {
    pageSize: config.pageSize,
    margins: config.margins,
    columns: config.columns,
    headerFooterRefs: config.finalHeaderFooterRefs,
  };
  const final: SectionLayoutConfig = {
    pageSize: config.finalPageSize ?? config.pageSize,
    margins: config.finalMargins ?? config.margins,
    columns: config.columns,
    startType: config.bodyBreakType,
    headerFooterRefs: config.finalHeaderFooterRefs,
  };

  const schedule = collectSectionConfigs(nodes, initial, final);

  const ctx: FlowContext = {
    nodes,
    metrics,
    config,
    pages: [],
    // The first section's geometry is the *first* schedule entry, which is the
    // one closed by the first break — not `initial`, which is only the
    // inheritance seed. They agree unless the document overrides geometry on
    // its opening section.
    section: schedule.configs[0] ?? initial,
    sectionIndex: 0,
    sectionPageCounts: new Map(),
  };

  // An empty document is still one page. Word shows a blank sheet, not nothing.
  // Document-start paragraphs keep inherited space-before (Word does). Only a
  // standalone hard page break suppresses inherited top spacing on the next page.
  let cursor: LayoutCursor = startPage(ctx);
  let sectionIndex = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeMetrics = metrics[i];

    const balanceBreaks = ctx.pages[cursor.pageIndex]?.columnBalanceBreakBefore;
    if (
      balanceBreaks?.has(i) &&
      (node.kind === 'paragraph' ||
        node.kind === 'table' ||
        node.kind === 'image' ||
        node.kind === 'textBox')
    ) {
      // A balance-forced column start must not inherit the previous column's
      // trailing spacing via collapsedGap — that spacing was already budgeted
      // into the prior column's partition height.
      cursor = { ...nextColumn(ctx, cursor), prev: null };
    }

    switch (node.kind) {
      case 'sectionBreak': {
        sectionIndex++;
        const next = schedule.configs[sectionIndex] ?? ctx.section;
        const sectionEnd = schedule.breakIndices[sectionIndex] ?? nodes.length;
        cursor = crossSectionBoundary(ctx, cursor, next, sectionIndex, i + 1, sectionEnd);
        break;
      }

      case 'pageBreak':
        cursor = {
          ...startPage(ctx, cursor.prev),
          suppressInheritedSpaceBeforeAtTop: true,
        };
        break;

      case 'columnBreak':
        cursor = nextColumn(ctx, cursor);
        break;

      case 'paragraph':
        cursor = placeParagraph(ctx, cursor, node, nodeMetrics as ParagraphMetrics, i);
        break;

      case 'table':
        cursor = layoutTable(ctx, cursor, node, nodeMetrics as TableMetrics, i);
        break;

      case 'image':
        cursor = placeImage(ctx, cursor, node, nodeMetrics as ImageMetrics, i);
        break;

      case 'textBox':
        cursor = placeTextBox(ctx, cursor, node, nodeMetrics as TextBoxMetrics, i);
        break;

      default:
        assertExhaustiveContentNode(node, 'layOutPages');
    }
  }

  // A footnote may continue after the body's final fragment. Reservations for
  // those continuation pages are already part of the fixed-point input, so
  // materialize the pages even though there is no more body node to overflow.
  const minimumPageCount = Math.max(1, config.minimumPageCount ?? 1);
  while (ctx.pages.length < minimumPageCount) {
    cursor = startPage(ctx, cursor.prev);
  }

  return finish(ctx, config);
}

/**
 * The bottom of everything painted in the page's current column region — the Y
 * the flow must resume at when it leaves that region.
 */
function regionBottomOf(page: PageDraft): number {
  let bottom = page.columnRegionTop ?? page.margins.top;
  for (const fragment of page.fragments) {
    if (fragment.columnIndex === undefined) continue;
    bottom = Math.max(bottom, fragment.y + fragment.height);
  }
  return bottom;
}

/**
 * Apply a section's start type (`w:type`, §17.6.22).
 *
 * `continuous` keeps the pen where it is — the new section's *column* layout
 * takes effect on the same page, which is how a two-column pull-quote sits in
 * the middle of a one-column article. Its page size can't take effect mid-page,
 * and Word doesn't try either.
 *
 * `evenPage`/`oddPage` break until the page number has the right parity, which
 * is how a chapter always opens on a recto. These have no test oracle yet — see
 * `tasks.md` §10.1.
 */
function crossSectionBoundary(
  ctx: FlowContext,
  cursor: LayoutCursor,
  next: SectionLayoutConfig,
  nextSectionIndex: number,
  sectionStart: number,
  sectionEnd: number
): LayoutCursor {
  switch (next.startType) {
    case 'continuous': {
      ctx.section = next;
      ctx.sectionIndex = nextSectionIndex;
      // Re-columnise the current page from the pen down. The page keeps the size
      // it was born with — a page cannot change dimensions halfway. New page
      // size/margins stay pending on `ctx.section` until the next naturally
      // created physical page (`startPage`), matching measureBlocksWithFloats.
      const page = ctx.pages[cursor.pageIndex];

      // The pen is wherever the last column left it, which is somewhere up inside
      // that column. Content after the region has to resume BELOW the whole
      // region — below every column of it — or it paints straight over the text
      // it was supposed to follow. This is the flagship case: a two-column
      // pull-quote in a one-column article, and the article resuming underneath it.
      const resumeY = page.columns ? regionBottomOf(page) : cursor.y;

      page.columns = (next.columns?.count ?? 1) > 1 ? next.columns : undefined;

      // Both of these belong to the region we are *leaving*. A section returning
      // to one column must not inherit the previous section's balanced bottom, or
      // its text would break to a new page a third of the way down.
      page.columnBalanceBottom = undefined;
      page.columnBalanceBreakBefore = undefined;
      page.columnRegionTop = undefined;

      cursor = { ...cursor, y: resumeY, columnIndex: 0 };

      if (page.columns) {
        // The new region starts at the pen, not at the top margin — its columns
        // sit side by side BELOW whatever single-column text precedes them.
        page.columnRegionTop = cursor.y;

        // Only balance non-terminal continuous multi-column sections. A
        // terminal multi-column stretch (no following section break) stays in
        // ordinary sequential column flow — matching Word.
        if (sectionEnd < ctx.nodes.length) {
          const plan = planContinuousSectionBalance(
            ctx.nodes,
            ctx.metrics,
            sectionStart,
            sectionEnd,
            {
              top: cursor.y,
              bottom: page.size.h - page.margins.bottom - (page.footnoteReservedHeight ?? 0),
              columns: page.columns,
            }
          );
          if (plan) {
            page.columnBalanceBottom = cursor.y + plan.height;
            page.columnBalanceBreakBefore = plan.breakBeforeBlocks;
          }
        }
      }

      return cursor;
    }

    case 'nextColumn':
      ctx.section = next;
      ctx.sectionIndex = nextSectionIndex;
      return nextColumn(ctx, cursor);

    case 'evenPage':
    case 'oddPage': {
      // A chapter that must open on a recto. Word inserts blank pages until the
      // parity is right — but only as many as it needs. Starting a page
      // unconditionally would burn one even when the pen is already on an empty
      // page of the correct parity, so the document grows a blank sheet that
      // Word does not have.
      const wantEven = next.startType === 'evenPage';
      const hasParity = (c: LayoutCursor): boolean =>
        (ctx.pages[c.pageIndex].number % 2 === 0) === wantEven;

      let c = cursor;
      if (pageIsEmpty(ctx, c) && hasParity(c)) {
        // The preceding flow already opened the correctly-numbered blank page
        // (for example via an explicit page break). Recreate that empty draft
        // under the new section so its margins, title-page furniture, and
        // section-local page number are all resolved as the opening page.
        ctx.pages.pop();
        const previousCount = ctx.sectionPageCounts.get(ctx.sectionIndex) ?? 1;
        ctx.sectionPageCounts.set(ctx.sectionIndex, Math.max(0, previousCount - 1));
      } else {
        // Any parity page inserted before the opening page belongs to the
        // section being closed. Keep the old section active while creating it;
        // switching first would make the filler page new-section page 1.
        const openingPageNumber = ctx.pages.length + 1;
        const openingHasParity = (openingPageNumber % 2 === 0) === wantEven;
        if (!pageIsEmpty(ctx, c) && !openingHasParity) {
          c = startPage(ctx, cursor.prev);
        }
      }

      ctx.section = next;
      ctx.sectionIndex = nextSectionIndex;
      return startPage(ctx, c.prev);
    }

    case 'nextPage':
    default:
      ctx.section = next;
      ctx.sectionIndex = nextSectionIndex;
      return startPage(ctx, cursor.prev);
  }
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

/**
 * `w:widowControl` (§17.3.1.44) — never strand a single line of a paragraph on
 * either side of a page break. On by default in Word.
 *
 * BEST-EFFORT: this has no test oracle yet and has not been checked against
 * Word (see `tasks.md` §10.1 / §10a.7). It is deliberately conservative — it
 * only ever moves *one* line — so that when it is wrong it is wrong by a line,
 * not by a page.
 */
const MIN_LINES_EITHER_SIDE = 2;

function widowControlEnabled(node: ParagraphBlock): boolean {
  return node.attrs?.widowControl !== false;
}

function placeParagraph(
  ctx: FlowContext,
  cursorIn: LayoutCursor,
  node: ParagraphBlock,
  metrics: ParagraphMetrics,
  index: number
): LayoutCursor {
  // `w:pageBreakBefore` (§17.3.1.23) — start a new page even when this one has
  // room. Unless the page has nothing on it yet: the break has already happened,
  // and honouring it again would emit a blank page.
  let cursor = cursorIn;
  if (node.attrs?.pageBreakBefore && !pageIsEmpty(ctx, cursor)) {
    cursor = startPage(ctx, cursor.prev);
  }

  cursor = applyKeepNext(ctx, cursor, index);

  const lines = metrics.lines;
  if (lines.length === 0) {
    return { ...cursor, prev: node, suppressInheritedSpaceBeforeAtTop: false };
  }

  // `w:keepLines` (§17.3.1.14) — keep the whole paragraph on one page, if it
  // can fit on one at all. Also best-effort; see the note above.
  if (node.attrs?.keepLines) {
    cursor = honourKeepLines(ctx, cursor, node, metrics);
  }

  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const region = currentRegion(ctx, cursor);
    // The gap belongs to the paragraph's FIRST line, wherever that line ends up.
    // Keying it on "have we overflowed yet" instead would silently drop
    // `spacing.before` from every paragraph that widow control moved to the next
    // page — the commonest thing widow control does.
    const isFirstLine = lineIndex === 0;
    const gap = isFirstLine ? placementGap(cursor, node) : 0;
    const top = cursor.y + gap;

    let count = countLinesThatFit(lines, lineIndex, region.bottom - top);

    if (count === 0) {
      // Not even one line fits. Move on — unless we are already at the top of an
      // empty region, in which case the line is taller than the page and moving
      // would loop forever. Overflow it instead.
      // Nothing fits. Move on — but ONLY if there is somewhere to move to.
      //
      // On an empty region there is not: `overflow` preserves `prev`, so the gap
      // is recomputed to the same value on the fresh page, nothing fits there
      // either, and the composer emits pages until the tab dies. (A single line
      // taller than the content box does this, and so does a `w:cantSplit` row
      // taller than a page — both are ordinary malformed-document shapes.)
      // An empty region is where we stop asking and place the thing anyway.
      if (!regionIsEmpty(ctx, cursor)) {
        cursor = overflow(ctx, cursor);
        continue;
      }
      count = 1;
    }

    count = applyWidowControl(node, lines, lineIndex, count, isFirstLine, ctx, cursor);
    if (count === 0) {
      cursor = overflow(ctx, cursor);
      continue;
    }

    const height = sliceHeight(lines, lineIndex, lineIndex + count);
    const endLine = lineIndex + count;

    ctx.pages[cursor.pageIndex].fragments.push({
      kind: 'paragraph',
      nodeId: node.id,
      x: region.left,
      y: top,
      width: region.width,
      height,
      fromLine: lineIndex,
      toLine: endLine,
      columnIndex: cursor.columnIndex,
      ...(lineIndex > 0 ? { continuesFromPrev: true } : {}),
      ...(endLine < lines.length ? { continuesOnNext: true } : {}),
      ...fragmentRange(node, metrics, lineIndex, endLine),
    });

    cursor = {
      ...cursor,
      y: top + height,
      prev: node,
      suppressInheritedSpaceBeforeAtTop: false,
    };
    lineIndex = endLine;

    if (lineIndex < lines.length) {
      cursor = overflow(ctx, cursor);
    }
  }

  return cursor;
}

function placementGap(cursor: LayoutCursor, node: ParagraphBlock): number {
  const spacingBefore = node.attrs?.spacing?.before ?? 0;
  if (
    cursor.suppressInheritedSpaceBeforeAtTop &&
    !node.attrs?.spacingOverrides?.before &&
    spacingBefore > 0
  ) {
    return 0;
  }
  return collapsedGap(cursor.prev, node);
}

/**
 * How many lines starting at `from` fit in `available` px.
 *
 * A line's footprint includes the `floatSkipBefore` it was pushed down by: the
 * gap under a float is space the line occupies, even though no glyph paints in it.
 */
function countLinesThatFit(
  lines: ParagraphMetrics['lines'],
  from: number,
  available: number
): number {
  let used = 0;
  let count = 0;
  for (let i = from; i < lines.length; i++) {
    const h = lines[i].lineHeight + (lines[i].floatSkipBefore ?? 0);
    if (used + h > available + FIT_TOLERANCE_PX) break;
    used += h;
    count++;
  }
  return count;
}

function sliceHeight(lines: ParagraphMetrics['lines'], from: number, to: number): number {
  let h = 0;
  for (let i = from; i < to; i++) {
    h += lines[i].lineHeight + (lines[i].floatSkipBefore ?? 0);
  }
  return h;
}

/**
 * Trim the fitted line count so neither side of the break is left with a single
 * stranded line. Returns 0 to mean "move the whole thing to the next region".
 */
function applyWidowControl(
  node: ParagraphBlock,
  lines: ParagraphMetrics['lines'],
  from: number,
  count: number,
  isFirstFragment: boolean,
  ctx: FlowContext,
  cursor: LayoutCursor
): number {
  if (!widowControlEnabled(node)) return count;

  const remaining = lines.length - from;
  if (count >= remaining) return count; // No break here — nothing to strand.
  if (remaining < MIN_LINES_EITHER_SIDE * 2) {
    // Too short to satisfy both sides. Keeping it whole is the lesser evil, and
    // only if that's actually possible.
    if (isFirstFragment && !regionIsEmpty(ctx, cursor) && count < remaining) return 0;
    return count;
  }

  // An orphan: one line of this paragraph alone at the foot of the page.
  if (count < MIN_LINES_EITHER_SIDE) {
    if (isFirstFragment && !regionIsEmpty(ctx, cursor)) return 0;
    return count;
  }

  // A widow: one line alone at the head of the next page. Pull a line down to
  // join it — but not if that would strand this side instead.
  const carried = remaining - count;
  if (carried < MIN_LINES_EITHER_SIDE && count - 1 >= MIN_LINES_EITHER_SIDE) {
    return count - 1;
  }

  return count;
}

/** Move a `w:keepLines` paragraph whole, when a fresh region could hold it. */
function honourKeepLines(
  ctx: FlowContext,
  cursor: LayoutCursor,
  node: ParagraphBlock,
  metrics: ParagraphMetrics
): LayoutCursor {
  const region = currentRegion(ctx, cursor);
  const total = sliceHeight(metrics.lines, 0, metrics.lines.length);
  const leadingGap = placementGap(cursor, node);
  const effectiveTotal = leadingGap + total;

  if (effectiveTotal > region.bottom - region.top + FIT_TOLERANCE_PX) return cursor; // Never fits.
  if (effectiveTotal <= region.bottom - cursor.y + FIT_TOLERANCE_PX) return cursor; // Fits here.
  if (regionIsEmpty(ctx, cursor)) return cursor;

  return overflow(ctx, cursor);
}

/**
 * The document-position range of a paragraph slice.
 *
 * The paragraph's own `docFrom`/`docTo` bracket the whole node, including its
 * boundary tokens. A slice that starts at line 0 owns the opening boundary, and
 * one that ends at the last line owns the closing one — so those ends take the
 * node's range. Every interior edge is derived from the line's run/char
 * address instead, which is what makes a continuation fragment's range cover
 * exactly the text it paints and nothing else.
 */
function fragmentRange(
  node: ParagraphBlock,
  metrics: ParagraphMetrics,
  fromLine: number,
  toLine: number
): { docFrom?: number; docTo?: number } {
  const lines = metrics.lines;

  const docFrom =
    fromLine === 0
      ? node.docFrom
      : runPosition(node, lines[fromLine]?.fromRun, lines[fromLine]?.fromChar);

  const last = lines[toLine - 1];
  const docTo = toLine >= lines.length ? node.docTo : runPosition(node, last?.toRun, last?.toChar);

  const range: { docFrom?: number; docTo?: number } = {};
  if (docFrom !== undefined) range.docFrom = docFrom;
  if (docTo !== undefined) range.docTo = docTo;
  return range;
}

/** Document position of a `(run, char)` address inside a paragraph. */
function runPosition(
  node: ParagraphBlock,
  runIndex: number | undefined,
  charOffset: number | undefined
): number | undefined {
  if (runIndex === undefined || charOffset === undefined) return undefined;
  const run = node.runs[runIndex];
  if (!run || run.docFrom === undefined) return undefined;
  return run.docFrom + charOffset;
}

// ---------------------------------------------------------------------------
// Images and text boxes
// ---------------------------------------------------------------------------

function placeImage(
  ctx: FlowContext,
  cursorIn: LayoutCursor,
  node: ImageBlock,
  metrics: ImageMetrics,
  index: number
): LayoutCursor {
  let cursor = applyKeepNext(ctx, cursorIn, index);

  const anchored = node.anchor?.isAnchored === true;
  let region = currentRegion(ctx, cursor);
  let gap = collapsedGap(cursor.prev, node);

  if (!anchored && !fits(metrics.height, cursor.y + gap, region) && !regionIsEmpty(ctx, cursor)) {
    cursor = overflow(ctx, cursor);
    region = currentRegion(ctx, cursor);
    gap = 0;
  }

  const y = anchored ? region.top + (node.anchor?.offsetV ?? 0) : cursor.y + gap;

  ctx.pages[cursor.pageIndex].fragments.push({
    kind: 'image',
    nodeId: node.id,
    x: region.left + (anchored ? (node.anchor?.offsetH ?? 0) : 0),
    y,
    width: metrics.width,
    height: metrics.height,
    columnIndex: cursor.columnIndex,
    ...(anchored ? { isAnchored: true } : {}),
    ...(node.anchor?.behindDoc ? { zIndex: -1 } : {}),
    ...(node.docFrom !== undefined ? { docFrom: node.docFrom } : {}),
    ...(node.docTo !== undefined ? { docTo: node.docTo } : {}),
  });

  // An anchored image is painted out of flow — it never moves the pen.
  return anchored ? { ...cursor, prev: node } : { ...cursor, y: y + metrics.height, prev: node };
}

function placeTextBox(
  ctx: FlowContext,
  cursorIn: LayoutCursor,
  node: TextBoxBlock,
  metrics: TextBoxMetrics,
  index: number
): LayoutCursor {
  const floating = isFloatingTextBoxBlock(node);
  let cursor = floating ? cursorIn : applyKeepNext(ctx, cursorIn, index);

  let region = currentRegion(ctx, cursor);
  let gap = floating ? 0 : collapsedGap(cursor.prev, node);

  if (!floating && !fits(metrics.height, cursor.y + gap, region) && !regionIsEmpty(ctx, cursor)) {
    cursor = overflow(ctx, cursor);
    region = currentRegion(ctx, cursor);
    gap = 0;
  }

  const y = cursor.y + gap;

  ctx.pages[cursor.pageIndex].fragments.push({
    kind: 'textBox',
    nodeId: node.id,
    x: region.left,
    y,
    width: metrics.width,
    height: metrics.height,
    columnIndex: cursor.columnIndex,
    ...(floating ? { isFloating: true, zIndex: textBoxZIndex(node) } : {}),
    ...(node.docFrom !== undefined ? { docFrom: node.docFrom } : {}),
    ...(node.docTo !== undefined ? { docTo: node.docTo } : {}),
  });

  // A floating box is placed by its own anchor (the painter resolves that) and
  // never advances the body pen — that is what makes text flow past it.
  return floating ? { ...cursor, prev: node } : { ...cursor, y: y + metrics.height, prev: node };
}

/**
 * Stacking order for an anchored text box.
 *
 * `wp:wrapNone` splits into two: `behind` paints *under* the text (a watermark,
 * a letterhead panel) and `inFront` paints over it. Everything else sits just
 * above the body — high enough that the box isn't buried by the text it displaces,
 * low enough to stay under the editor's own overlays.
 */
function textBoxZIndex(node: TextBoxBlock): number {
  if (node.wrapType === 'behind') return -1;
  if (node.wrapType === 'inFront') return 2;
  return 1;
}

function fits(height: number, top: number, region: ColumnRegion): boolean {
  return top + height <= region.bottom + FIT_TOLERANCE_PX;
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

function finish(ctx: FlowContext, config: LayoutConfig): PageLayout {
  const pageGap = config.pageGap ?? DEFAULT_PAGE_GAP_PX;

  const pages: Page[] = ctx.pages.map((draft) => ({
    number: draft.number,
    size: draft.size,
    margins: draft.margins,
    fragments: draft.fragments,
    ...(draft.columns ? { columns: draft.columns } : {}),
    ...(draft.sectionIndex != null ? { sectionIndex: draft.sectionIndex } : {}),
    ...(draft.sectionPageNumber != null ? { sectionPageNumber: draft.sectionPageNumber } : {}),
    ...(draft.headerFooterRefs ? { headerFooterRefs: draft.headerFooterRefs } : {}),
    ...(draft.footnoteReservedHeight
      ? { footnoteReservedHeight: draft.footnoteReservedHeight }
      : {}),
  }));

  const totalHeight =
    pages.reduce((h, page) => h + page.size.h, 0) + Math.max(0, pages.length - 1) * pageGap;

  return {
    pages,
    pageSize: config.pageSize,
    pageGap,
    totalHeight,
  };
}

export type { ColumnRegion };
