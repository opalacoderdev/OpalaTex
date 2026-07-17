/**
 * Selection rectangles from the layout model.
 *
 * The layout-math half of selection mapping. The painted DOM is the primary
 * source (see `resolveDomPosition.ts`) — it knows about ligatures and bidi and
 * fallback fonts, and this doesn't. But it can only answer for what is actually
 * painted, and two things routinely aren't: a page that virtualization hasn't
 * rendered, and the frame *before* a repaint lands. Falling back to layout math
 * there is the difference between a caret that blinks steadily and one that
 * disappears every time you type.
 *
 * **Coordinates are page-stack space**: origin at the top-left of page 1, pages
 * stacked with `pageGap` between them, layout px. The caller offsets that into
 * its overlay's space.
 *
 * @packageDocumentation
 */

import type {
  ContentNode,
  PageLayout,
  LayoutMetrics,
  MeasuredLine,
  Page,
  ParagraphBlock,
  ParagraphMetrics,
  TableBlock,
  TableFragment,
  TableMetrics,
} from '../pagination-model/types';
import { layoutCellContent } from './cellBlockLayout';
import { pageTopOffset } from './pointerTargetResolve';
import { getPositionRect, positionToX } from './pointerToDocPos';
import { resolveCellGrid } from './tableWidthUtils';

/**
 * A highlight rectangle in page-stack space.
 *
 * @public
 */
export interface SelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
}

/**
 * A caret in page-stack space. Zero-width; the height is what matters.
 *
 * @public
 */
export interface CaretPosition {
  x: number;
  y: number;
  height: number;
  pageIndex: number;
}

/**
 * The caret for a document position, or `null` when the layout can't place it.
 *
 * Table fragments keep the whole table's position range, so table positions are
 * narrowed through the authored cell grid and the shared cell-line layout.
 * This matters for virtualized pages, where no painted DOM exists to provide
 * the primary caret geometry.
 *
 * `pageHint` starts the page scan at a page instead of at zero. Positions are
 * usually queried in ascending document order (the comment sidebar does exactly
 * that, once per anchor), and a page never moves backwards between them — so
 * feeding the last answer back turns an O(anchors × pages) pass into
 * O(anchors + pages). On a long review document that is the difference between a
 * visible stall and no stall.
 *
 * @public
 */
export function getCaretPosition(
  layout: PageLayout,
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  pmPos: number,
  pageHint = 0
): CaretPosition | null {
  const index = nodeIndex(nodes, metrics);

  for (let pi = Math.max(0, pageHint); pi < layout.pages.length; pi++) {
    const page = layout.pages[pi];

    for (const fragment of page.fragments) {
      if (!coversPosition(fragment, pmPos)) continue;

      const entry = index.get(String(fragment.nodeId));
      if (!entry) continue;

      if (
        fragment.kind === 'table' &&
        entry.block.kind === 'table' &&
        entry.measure.kind === 'table'
      ) {
        const rect = tableCaretRect(entry.block, entry.measure, fragment, pmPos);
        if (!rect) continue;
        return {
          x: rect.x,
          y: rect.y + pageTopOffset(layout, pi),
          height: rect.height,
          pageIndex: pi,
        };
      }

      const rect = getPositionRect(entry.block, entry.measure, fragment, pmPos);
      if (!rect) continue;

      return {
        x: rect.x,
        y: rect.y + pageTopOffset(layout, pi),
        height: rect.height,
        pageIndex: pi,
      };
    }
  }

  return null;
}

/**
 * Highlight rectangles for `[from, to)` — one per painted line the range covers.
 *
 * A range that crosses a page boundary partitions naturally: each page's
 * fragments contribute their own rectangles, each tagged with the page it's on.
 * There is no cross-page rectangle, because there is no such thing on screen.
 *
 * @public
 */
export function rectsForSelection(
  layout: PageLayout,
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  from: number,
  to: number
): SelectionBox[] {
  if (to <= from) return [];

  const index = nodeIndex(nodes, metrics);
  const boxes: SelectionBox[] = [];

  for (let pi = 0; pi < layout.pages.length; pi++) {
    const page = layout.pages[pi];
    const pageTop = pageTopOffset(layout, pi);

    for (const fragment of page.fragments) {
      const entry = index.get(String(fragment.nodeId));
      if (!entry) continue;

      const fragFrom = fragment.docFrom;
      const fragTo = fragment.docTo;
      if (fragFrom === undefined || fragTo === undefined) continue;
      if (fragTo <= from || fragFrom >= to) continue;

      if (
        fragment.kind === 'table' &&
        entry.block.kind === 'table' &&
        entry.measure.kind === 'table'
      ) {
        boxes.push(
          ...tableSelectionRects(entry.block, entry.measure, fragment, from, to, pi, pageTop)
        );
        continue;
      }

      if (
        fragment.kind !== 'paragraph' ||
        entry.block.kind !== 'paragraph' ||
        entry.measure.kind !== 'paragraph'
      ) {
        // A table, image, or text box inside the range highlights whole — there
        // are no interior line boxes to clip to.
        boxes.push({
          x: fragment.x,
          y: fragment.y + pageTop,
          width: fragment.width,
          height: fragment.height,
          pageIndex: pi,
        });
        continue;
      }

      const block = entry.block;
      const measure = entry.measure;
      const lines = measure.lines;

      let y = fragment.y;

      for (let li = fragment.fromLine; li < fragment.toLine && li < lines.length; li++) {
        const line = lines[li];
        y += line.floatSkipBefore ?? 0;

        const lineFrom = linePosition(block, line.fromRun, line.fromChar);
        const lineTo = linePosition(block, line.toRun, line.toChar);

        if (lineFrom !== null && lineTo !== null && lineTo > from && lineFrom < to) {
          // Clip the highlight to the selected part of the line — a selection
          // that starts mid-line must not paint from the margin.
          const startPos = Math.max(from, lineFrom);
          const endPos = Math.min(to, lineTo);

          const x1 = fragment.x + positionToX(block, measure, line, startPos);
          const x2 = fragment.x + positionToX(block, measure, line, endPos);

          boxes.push({
            x: Math.min(x1, x2),
            y: y + pageTop,
            width: Math.max(Math.abs(x2 - x1), 0),
            height: line.lineHeight,
            pageIndex: pi,
          });
        }

        y += line.lineHeight;
      }
    }
  }

  return boxes;
}

/**
 * True when a selection reaches across a page boundary.
 *
 * @public
 */
export function isMultiPageSelection(boxes: SelectionBox[]): boolean {
  if (boxes.length === 0) return false;
  const first = boxes[0].pageIndex;
  return boxes.some((box) => box.pageIndex !== first);
}

/**
 * Group rectangles by the page they're painted on, so an overlay can render one
 * layer per page.
 *
 * @public
 */
export function groupBoxesByPage(boxes: SelectionBox[]): Map<number, SelectionBox[]> {
  const byPage = new Map<number, SelectionBox[]>();
  for (const box of boxes) {
    const list = byPage.get(box.pageIndex);
    if (list) list.push(box);
    else byPage.set(box.pageIndex, [box]);
  }
  return byPage;
}

// ---------------------------------------------------------------------------
// Table geometry
// ---------------------------------------------------------------------------

interface TableLinePlacement {
  block: ParagraphBlock;
  measure: ParagraphMetrics;
  line: MeasuredLine;
  x: number;
  y: number;
  height: number;
}

interface TableCellPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  contentX: number;
  docFrom?: number;
  docTo?: number;
}

interface TablePlacements {
  lines: TableLinePlacement[];
  cells: TableCellPlacement[];
}

const DEFAULT_CELL_PADDING_X = 7;
const DEFAULT_CELL_PADDING_Y = 0;
const TABLE_BOUNDARY_CARET_HEIGHT = 16;

function tableCaretRect(
  block: TableBlock,
  measure: TableMetrics,
  fragment: TableFragment,
  pmPos: number
): { x: number; y: number; height: number } | null {
  const placements = tablePlacements(block, measure, fragment);

  for (const placement of placements.lines) {
    const from = linePosition(placement.block, placement.line.fromRun, placement.line.fromChar);
    const to = linePosition(placement.block, placement.line.toRun, placement.line.toChar);
    if (from === null || to === null || pmPos < from || pmPos > to) continue;

    return {
      x: placement.x + positionToX(placement.block, placement.measure, placement.line, pmPos),
      y: placement.y,
      height: placement.height,
    };
  }

  // Cell and paragraph boundaries do not always belong to a run. Keep the
  // fallback local to the tightest visible cell rather than jumping to the
  // table's top-left or dropping the caret entirely.
  let best: TableCellPlacement | null = null;
  for (const cell of placements.cells) {
    if (cell.docFrom === undefined || cell.docTo === undefined) continue;
    if (pmPos < cell.docFrom || pmPos > cell.docTo) continue;
    if (
      !best ||
      cell.docTo - cell.docFrom < (best.docTo ?? Infinity) - (best.docFrom ?? -Infinity)
    ) {
      best = cell;
    }
  }
  if (!best) return null;

  return {
    x: best.contentX,
    y: best.y,
    height: Math.min(TABLE_BOUNDARY_CARET_HEIGHT, best.height),
  };
}

function tableSelectionRects(
  block: TableBlock,
  measure: TableMetrics,
  fragment: TableFragment,
  from: number,
  to: number,
  pageIndex: number,
  pageTop: number
): SelectionBox[] {
  const placements = tablePlacements(block, measure, fragment);
  const boxes: SelectionBox[] = [];

  for (const placement of placements.lines) {
    const lineFrom = linePosition(placement.block, placement.line.fromRun, placement.line.fromChar);
    const lineTo = linePosition(placement.block, placement.line.toRun, placement.line.toChar);
    if (lineFrom === null || lineTo === null || lineTo <= from || lineFrom >= to) continue;

    const startPos = Math.max(from, lineFrom);
    const endPos = Math.min(to, lineTo);
    const x1 =
      placement.x + positionToX(placement.block, placement.measure, placement.line, startPos);
    const x2 =
      placement.x + positionToX(placement.block, placement.measure, placement.line, endPos);
    boxes.push({
      x: Math.min(x1, x2),
      y: placement.y + pageTop,
      width: Math.abs(x2 - x1),
      height: placement.height,
      pageIndex,
    });
  }

  if (boxes.length > 0) return boxes;

  // Atomic/nested cell content has no line boxes. A visible cell is still a
  // bounded, useful fallback and avoids the old full-table highlight.
  for (const cell of placements.cells) {
    if (cell.docFrom === undefined || cell.docTo === undefined) continue;
    if (cell.docTo <= from || cell.docFrom >= to) continue;
    boxes.push({
      x: cell.x,
      y: cell.y + pageTop,
      width: cell.width,
      height: cell.height,
      pageIndex,
    });
  }

  return boxes;
}

function tablePlacements(
  block: TableBlock,
  measure: TableMetrics,
  fragment: TableFragment
): TablePlacements {
  const lines: TableLinePlacement[] = [];
  const cells: TableCellPlacement[] = [];
  const rowTops = tableRowTops(measure);
  const grid = resolveCellGrid(block);
  const tableWidth = measure.columnWidths.reduce((sum, width) => sum + (width ?? 0), 0);
  const repeatedHeaderRows =
    fragment.continuesFromPrev === true ? Math.max(0, fragment.headerRowCount ?? 0) : 0;
  const headerHeight = rowTops[Math.min(repeatedHeaderRows, measure.rows.length)] ?? 0;
  const windowTop = (rowTops[fragment.fromRow] ?? 0) + (fragment.topClip ?? 0);

  const addCell = (
    gridCell: (typeof grid)[number],
    cellTop: number,
    clipTop: number,
    clipBottom: number
  ): void => {
    const cell = block.rows[gridCell.rowIndex]?.cells?.[gridCell.cellIndex];
    const cellMeasure = measure.rows[gridCell.rowIndex]?.cells?.[gridCell.cellIndex];
    if (!cell || !cellMeasure) return;

    const cellEndRow = Math.min(measure.rows.length, gridCell.rowIndex + gridCell.rowSpan);
    const cellHeight = (rowTops[cellEndRow] ?? 0) - (rowTops[gridCell.rowIndex] ?? 0);
    const logicalX = columnOffset(measure.columnWidths, gridCell.columnIndex);
    const width = columnSpanWidth(measure.columnWidths, gridCell.columnIndex, gridCell.colSpan);
    const cellX = block.bidi ? tableWidth - logicalX - width : logicalX;
    const visibleTop = Math.max(cellTop, clipTop);
    const visibleBottom = Math.min(cellTop + cellHeight, clipBottom);
    if (visibleBottom <= visibleTop) return;

    const padLeft = cell.padding?.left ?? DEFAULT_CELL_PADDING_X;
    const padTop = cell.padding?.top ?? DEFAULT_CELL_PADDING_Y;
    const range = cellDocRange(cell.nodes);
    cells.push({
      x: fragment.x + cellX,
      y: fragment.y + visibleTop,
      width,
      height: visibleBottom - visibleTop,
      contentX: fragment.x + cellX + padLeft,
      ...range,
    });

    const content = layoutCellContent(cell.nodes, cellMeasure.metrics, padTop);
    const slack = Math.max(0, cellHeight - (cellMeasure.height ?? 0));
    const verticalOffset =
      cell.verticalAlign === 'bottom' ? slack : cell.verticalAlign === 'center' ? slack / 2 : 0;

    for (let nodeIndex = 0; nodeIndex < cell.nodes.length; nodeIndex++) {
      const child = cell.nodes[nodeIndex];
      const childMeasure = cellMeasure.metrics[nodeIndex];
      if (child?.kind !== 'paragraph' || childMeasure?.kind !== 'paragraph') continue;

      const lineTops = content.lineTops[nodeIndex] ?? [];
      for (let lineIndex = 0; lineIndex < childMeasure.lines.length; lineIndex++) {
        const line = childMeasure.lines[lineIndex];
        const lineTop = cellTop + verticalOffset + (lineTops[lineIndex] ?? 0);
        const lineBottom = lineTop + line.lineHeight;
        const clippedTop = Math.max(lineTop, clipTop);
        const clippedBottom = Math.min(lineBottom, clipBottom);
        if (clippedBottom <= clippedTop) continue;

        lines.push({
          block: child,
          measure: childMeasure,
          line,
          x: fragment.x + cellX + padLeft,
          y: fragment.y + clippedTop,
          height: clippedBottom - clippedTop,
        });
      }
    }
  };

  // Repeated headers are painted in a separate unwindowed strip.
  if (repeatedHeaderRows > 0) {
    for (const gridCell of grid) {
      if (gridCell.rowIndex >= repeatedHeaderRows) continue;
      addCell(gridCell, rowTops[gridCell.rowIndex] ?? 0, 0, headerHeight);
    }
  }

  // Body rows are translated through the fragment's table-coordinate window.
  const bodyClipTop = headerHeight;
  const bodyClipBottom = fragment.height;
  for (const gridCell of grid) {
    const cellEndRow = gridCell.rowIndex + gridCell.rowSpan;
    if (gridCell.rowIndex >= fragment.toRow || cellEndRow <= fragment.fromRow) continue;
    const cellTop = headerHeight + (rowTops[gridCell.rowIndex] ?? 0) - windowTop;
    addCell(gridCell, cellTop, bodyClipTop, bodyClipBottom);
  }

  return { lines, cells };
}

function tableRowTops(measure: TableMetrics): number[] {
  const tops = [0];
  for (const row of measure.rows) tops.push(tops[tops.length - 1]! + row.height);
  return tops;
}

function columnOffset(widths: readonly number[], columnIndex: number): number {
  let x = 0;
  for (let i = 0; i < columnIndex && i < widths.length; i++) x += widths[i] ?? 0;
  return x;
}

function columnSpanWidth(widths: readonly number[], columnIndex: number, colSpan: number): number {
  let width = 0;
  for (let i = columnIndex; i < columnIndex + colSpan && i < widths.length; i++) {
    width += widths[i] ?? 0;
  }
  return width;
}

function cellDocRange(nodes: readonly ContentNode[]): { docFrom?: number; docTo?: number } {
  let docFrom: number | undefined;
  let docTo: number | undefined;
  for (const block of nodes) {
    if (block.docFrom !== undefined) docFrom = Math.min(docFrom ?? block.docFrom, block.docFrom);
    if (block.docTo !== undefined) docTo = Math.max(docTo ?? block.docTo, block.docTo);
  }
  return { docFrom, docTo };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coversPosition(fragment: Page['fragments'][number], pmPos: number): boolean {
  const from = fragment.docFrom;
  const to = fragment.docTo;
  if (from === undefined) return false;
  return pmPos >= from && pmPos <= (to ?? from);
}

function linePosition(
  block: Extract<ContentNode, { kind: 'paragraph' }>,
  runIndex: number,
  charOffset: number
): number | null {
  const run = block.runs[runIndex];
  if (!run || run.docFrom === undefined) return null;
  return run.docFrom + charOffset;
}

function nodeIndex(
  nodes: ContentNode[],
  metrics: LayoutMetrics[]
): Map<string, { block: ContentNode; measure: LayoutMetrics }> {
  const map = new Map<string, { block: ContentNode; measure: LayoutMetrics }>();
  for (let i = 0; i < nodes.length; i++) {
    const measure = metrics[i];
    if (measure) map.set(String(nodes[i].id), { block: nodes[i], measure });
  }
  return map;
}
