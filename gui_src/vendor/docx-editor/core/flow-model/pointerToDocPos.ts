/**
 * Point → document position, from the layout model.
 *
 * The counterpart to `resolveDomPosition.ts`. That one asks the browser where
 * the glyphs are; this one works it out from the measured line boxes. It is the
 * fallback the editor drops to when the DOM has no answer — a click below the
 * last paragraph, in the margin, in the gutter — and it is the only path that
 * can be tested without a browser.
 *
 * Narrowing is: fragment → line → run → character. Each step is a lookup, and
 * the last one is a binary search over cumulative glyph advances, so a click in
 * a long paragraph doesn't walk it.
 *
 * @packageDocumentation
 */

import type {
  ContentNode,
  Fragment,
  LayoutMetrics,
  MeasuredLine,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMetrics,
  Run,
} from '../pagination-model/types';
import type { FragmentTarget, Point, TableCellTarget } from './pointerTargetResolve';
import { charIndexAtX, getXForCharacter, resolveFontStyle } from './metrics/textMetrics';
import { getListMarkerInlineWidth } from './metrics/listMarkerWidth';

/**
 * A resolved position, and how it was reached.
 *
 * @public
 */
export interface PositionResult {
  /** The document position. */
  pos: number;
  /** Index into the paragraph's measured lines. */
  lineIndex: number;
  /** Index into the paragraph's runs. */
  runIndex: number;
  /** Characters into that run. */
  charOffset: number;
}

/**
 * The document position a hit resolves to, or `null` when it resolves to none.
 *
 * @public
 */
export function pointerToDocPos(
  fragmentTarget: FragmentTarget,
  tableCellTarget?: TableCellTarget | null
): number | null {
  if (tableCellTarget) {
    return (
      pointerToDocPosInTableCell(tableCellTarget, {
        x: tableCellTarget.localX,
        y: tableCellTarget.localY,
      })?.pos ?? null
    );
  }

  const { fragment, node, metrics } = fragmentTarget;

  if (fragment.kind === 'paragraph' && node.kind === 'paragraph' && metrics.kind === 'paragraph') {
    const result = pointerToDocPosInParagraph(node, metrics, fragment, {
      x: fragmentTarget.localX,
      y: fragmentTarget.localY,
    });
    return result?.pos ?? null;
  }

  // An image or a text box is an atom: clicking it selects it, and the position
  // that means "this node" is the one just before it. Nearer the right edge means
  // the caret goes after it — which is how you get a caret past a trailing image.
  if (node.docFrom === undefined) return null;
  if (node.docTo !== undefined && fragmentTarget.localX > fragment.width / 2) {
    return node.docTo;
  }
  return node.docFrom;
}

/**
 * The position under a point inside a paragraph fragment.
 *
 * `point` is relative to the fragment's top-left.
 *
 * @public
 */
export function pointerToDocPosInParagraph(
  node: ParagraphBlock,
  metrics: ParagraphMetrics,
  fragment: ParagraphFragment,
  point: Point
): PositionResult | null {
  const lines = metrics.lines;
  if (lines.length === 0) return null;

  const lineIndex = lineAt(lines, fragment, point.y);
  const line = lines[lineIndex];
  if (!line) return null;

  // Text starts inside the line's own indent — and, on the first line of a list
  // item, after the marker, which is painted but is not part of the document.
  const isFirstLine = lineIndex === 0;
  const indent = lineStartOffset(node, isFirstLine) + (line.leftOffset ?? 0);
  const x = point.x - indent;

  return characterAt(node, line, lineIndex, x);
}

/**
 * The position under a point inside a table cell.
 *
 * `point` is relative to the cell's content box.
 *
 * @public
 */
export function pointerToDocPosInTableCell(
  cellTarget: TableCellTarget,
  point: Point
): PositionResult | null {
  // A cell holds a node flow of its own, so walk it the way a page walks its
  // nodes: down, accumulating heights, until the point is inside one. The last
  // node absorbs anything below it, so a click in the cell's bottom padding
  // lands at the end of its text rather than nowhere.
  const nodes = cellTarget.cell.nodes;
  const cellMetrics = cellTarget.metrics.metrics;

  let y = 0;
  let last: PositionResult | null = null;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const metrics = cellMetrics[i];
    const height = blockHeight(metrics);

    const inside = point.y < y + height;

    if (node.kind === 'paragraph' && metrics?.kind === 'paragraph') {
      const local: Point = { x: point.x, y: point.y - y };
      const wholeBlock: ParagraphFragment = {
        kind: 'paragraph',
        nodeId: node.id,
        x: 0,
        y: 0,
        width: cellTarget.contentWidth,
        height,
        fromLine: 0,
        toLine: metrics.lines.length,
      };
      const result = pointerToDocPosInParagraph(node, metrics, wholeBlock, local);
      if (result) {
        if (inside) return result;
        last = result;
      }
    } else if (node.docFrom !== undefined) {
      // A nested table or an image: the caret goes to its front.
      const result: PositionResult = {
        pos: node.docFrom,
        lineIndex: 0,
        runIndex: 0,
        charOffset: 0,
      };
      if (inside) return result;
      last = result;
    }

    y += height;
  }

  return last;
}

/** Vertical footprint of one node inside a cell. */
function blockHeight(metrics: LayoutMetrics | undefined): number {
  if (!metrics) return 0;
  switch (metrics.kind) {
    case 'paragraph':
    case 'table':
      return metrics.totalHeight;
    case 'image':
    case 'textBox':
      return metrics.height;
    default:
      return 0;
  }
}

/**
 * X of a document position within its line, px from the fragment's left edge.
 * The inverse of {@link pointerToDocPosInParagraph}.
 *
 * @public
 */
export function positionToX(
  node: ParagraphBlock,
  metrics: ParagraphMetrics,
  line: MeasuredLine,
  pmPos: number
): number {
  const lineIndex = metrics.lines.indexOf(line);
  const indent = lineStartOffset(node, lineIndex === 0) + (line.leftOffset ?? 0);

  let x = indent;

  for (let runIndex = line.fromRun; runIndex <= line.toRun; runIndex++) {
    const run = node.runs[runIndex];
    if (!run) continue;

    const from = runIndex === line.fromRun ? line.fromChar : 0;
    const to = runIndex === line.toRun ? line.toChar : runLength(run);

    const runStart = run.docFrom;
    if (runStart !== undefined && pmPos >= runStart + from && pmPos <= runStart + to) {
      return x + advanceWithin(node, line, runIndex, run, from, pmPos - runStart);
    }

    x += advanceWithin(node, line, runIndex, run, from, to);
  }

  return x;
}

/**
 * The box of a document position within a fragment, in page-absolute
 * coordinates — the primitive the caret and selection rects are built from.
 *
 * @public
 */
export function getPositionRect(
  node: ContentNode,
  metrics: LayoutMetrics,
  fragment: Fragment,
  pmPos: number
): { x: number; y: number; width: number; height: number } | null {
  if (fragment.kind !== 'paragraph' || node.kind !== 'paragraph' || metrics.kind !== 'paragraph') {
    // A non-paragraph fragment has no interior — its box IS its position.
    return { x: fragment.x, y: fragment.y, width: fragment.width, height: fragment.height };
  }

  const lines = metrics.lines;
  let y = fragment.y;

  for (let i = fragment.fromLine; i < fragment.toLine && i < lines.length; i++) {
    const line = lines[i];
    y += line.floatSkipBefore ?? 0;

    if (containsPosition(node, line, pmPos)) {
      return {
        x: fragment.x + positionToX(node, metrics, line, pmPos),
        y,
        width: 0,
        height: line.lineHeight,
      };
    }

    y += line.lineHeight;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/**
 * The line a Y falls on, within the slice the fragment paints.
 *
 * Clamped to the fragment: a click below its last line means that last line, not
 * nothing. That clamp is what makes clicking in the whitespace under a paragraph
 * put the caret at its end rather than doing nothing at all.
 */
function lineAt(lines: MeasuredLine[], fragment: ParagraphFragment, localY: number): number {
  let y = 0;

  for (let i = fragment.fromLine; i < fragment.toLine && i < lines.length; i++) {
    const line = lines[i];
    y += line.floatSkipBefore ?? 0;
    const bottom = y + line.lineHeight;
    if (localY < bottom) return i;
    y = bottom;
  }

  return Math.max(fragment.fromLine, Math.min(fragment.toLine, lines.length) - 1);
}

/** The character boundary nearest `x` on a line. */
function characterAt(
  node: ParagraphBlock,
  line: MeasuredLine,
  lineIndex: number,
  x: number
): PositionResult | null {
  let penX = 0;
  let sawRun = false;

  for (let runIndex = line.fromRun; runIndex <= line.toRun; runIndex++) {
    const run = node.runs[runIndex];
    if (!run) continue;
    sawRun = true;

    const from = runIndex === line.fromRun ? line.fromChar : 0;
    const to = runIndex === line.toRun ? line.toChar : runLength(run);
    const width = advanceWithin(node, line, runIndex, run, from, to);

    if (x <= penX + width || runIndex === line.toRun) {
      const within = Math.max(0, x - penX);
      const charOffset = charOffsetAt(node, line, runIndex, run, from, to, within);
      const runStart = run.docFrom;

      return {
        pos: runStart !== undefined ? runStart + charOffset : 0,
        lineIndex,
        runIndex,
        charOffset,
      };
    }

    penX += width;
  }

  // Empty paragraph / blank line: no painted runs, but the cell or paragraph
  // still has a content position the caret must land in.
  if (!sawRun && node.docFrom !== undefined) {
    const pos =
      node.docTo !== undefined && node.docTo > node.docFrom + 1 ? node.docFrom + 1 : node.docFrom;
    return { pos, lineIndex, runIndex: 0, charOffset: 0 };
  }

  return null;
}

/** Characters into `run` (from its start) at `x` px into the `[from, to)` slice. */
function charOffsetAt(
  node: ParagraphBlock,
  line: MeasuredLine,
  runIndex: number,
  run: Run,
  from: number,
  to: number,
  x: number
): number {
  if (run.kind !== 'text') {
    // An atom — a tab, an image, a field. The caret goes before it or after it,
    // never inside.
    return x > advanceWithin(node, line, runIndex, run, from, to) / 2 ? to : from;
  }

  const slice = run.text.slice(from, to);
  const style = resolveFontStyle(run, documentDefaults(node));
  return from + charIndexAtX(slice, style, x);
}

/**
 * Painted width of `run[from..to)` on `line`.
 *
 * A **tab** and an over-wide **image** are the two runs whose painted width is
 * not a function of the run: a tab's advance depends on where the pen was, and
 * an image wider than its column is painted scaled. The line breaker resolved
 * both and recorded them on the line (`MeasuredLine.advances`) — read them back
 * rather than re-deriving, so this walk reproduces the breaker's pen exactly.
 *
 * Getting this wrong is not subtle: a tab is often several hundred pixels, and
 * treating it as zero shifts every position after it by that much. That is every
 * table-of-contents entry and every right-tabbed header.
 */
function advanceWithin(
  node: ParagraphBlock,
  line: MeasuredLine,
  runIndex: number,
  run: Run,
  from: number,
  to: number
): number {
  const recorded = line.atomAdvances?.[runIndex];
  if (recorded !== undefined) return recorded;

  if (run.kind === 'lineBreak') return 0;
  if (run.kind === 'image') return run.width;

  if (run.kind === 'text') {
    const style = resolveFontStyle(run, documentDefaults(node));
    return getXForCharacter(run.text.slice(from, to), style, to - from);
  }

  if (run.kind === 'field') {
    const style = resolveFontStyle(run, documentDefaults(node));
    return getXForCharacter(run.fallback, style, run.fallback.length);
  }

  // A tab the breaker didn't record (a synthetic line, a hand-built fixture).
  // Zero is the only honest answer, and it is bounded by the run.
  return 0;
}

/** Characters in a run, as the line addressing counts them. */
function runLength(run: Run): number {
  // Non-text runs are single nodes: one position wide, whatever they paint.
  return run.kind === 'text' ? run.text.length : 1;
}

function containsPosition(node: ParagraphBlock, line: MeasuredLine, pmPos: number): boolean {
  const first = node.runs[line.fromRun];
  const last = node.runs[line.toRun];
  if (!first || !last || first.docFrom === undefined || last.docFrom === undefined) return false;

  return pmPos >= first.docFrom + line.fromChar && pmPos <= last.docFrom + line.toChar;
}

/**
 * Where a line's text begins: the paragraph's indents, plus — on the first line
 * of a list item — the marker, which occupies width but holds no document
 * position.
 */
function lineStartOffset(node: ParagraphBlock, isFirstLine: boolean): number {
  const indent = node.attrs?.indent;
  const left = indent?.left ?? 0;
  if (!isFirstLine) return left;

  const firstLine = indent?.firstLine ?? 0;
  const hanging = indent?.hanging ?? 0;
  return left + firstLine - hanging + getListMarkerInlineWidth(node);
}

function documentDefaults(node: ParagraphBlock): { fontFamily?: string; fontSize?: number } {
  return {
    fontFamily: node.attrs?.defaultFontFamily,
    fontSize: node.attrs?.defaultFontSize,
  };
}
