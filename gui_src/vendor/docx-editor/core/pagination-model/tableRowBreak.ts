/**
 * Table row-break geometry.
 *
 * Word lets a table row break across a page boundary ("allow row to break
 * across pages", on by default). When a row is taller than the space left on
 * the page, the portion that fits stays and the rest continues on the next
 * page — broken between whole text lines, never through a glyph.
 *
 * This module computes, per row, the set of safe break offsets (the y of every
 * line bottom across the row's content, including vertically-merged cells that
 * span into the row) so the pageComposer can snap a break to the deepest whole
 * line that still fits.
 */

import type { TableBlock, TableMetrics } from './types';
import { resolveCellGrid } from '../flow-model/tableWidthUtils';
import { layoutCellContent } from '../flow-model/cellBlockLayout';

/**
 * Precomputed break geometry for a table.
 */
export interface TableRowBreakInfo {
  /** Cumulative y of the top of each row; rowTops[rows.length] is the table height. */
  rowTops: number[];
  /**
   * Per-row sorted, de-duplicated offsets (relative to the row top) at which a
   * break is clean across every active cell.
   */
  breakOffsets: number[][];
}

/**
 * Build break geometry for a table from its node + metrics.
 */
export function buildTableRowBreakInfo(node: TableBlock, metrics: TableMetrics): TableRowBreakInfo {
  const rowCount = metrics.rows.length;
  // True (unrounded) cumulative row offsets — the pageComposer splits against
  // exact measured heights. The painter has a sibling `buildRowYPositions`
  // that rounds to whole pixels for crisp borders; keep the two SEPARATE
  // (don't "dedupe") or you break either break-offset alignment or crispness.
  const rowTops: number[] = [];
  let acc = 0;
  for (let r = 0; r < rowCount; r++) {
    rowTops.push(acc);
    acc += metrics.rows[r]?.height ?? 0;
  }
  rowTops.push(acc);

  // Use the shared grid resolution so "which cells cover row r" matches the
  // measurer and painter. A cell starting in row `sr` with rowSpan covers
  // rows [sr, sr + rowSpan); a merged cell spills its line bottoms into the
  // rows below its restart row.
  const resolved = resolveCellGrid(node);
  const breakOffsets: number[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const rowHeight = metrics.rows[r]?.height ?? 0;
    const candidates = new Set<number>();
    candidates.add(rowHeight);
    const unbreakableRanges: Array<{ top: number; bottom: number }> = [];

    for (const g of resolved) {
      if (g.rowIndex > r || g.rowIndex + g.rowSpan - 1 < r) continue;
      const sourceCell = node.rows[g.rowIndex]?.cells?.[g.cellIndex];
      const measuredCell = metrics.rows[g.rowIndex]?.cells?.[g.cellIndex];
      if (!sourceCell || !measuredCell) continue;
      // OOXML/TableNormal default top padding is 0 (matches measureTable).
      const padTop = sourceCell.padding?.top ?? 0;
      const layout = layoutCellContent(sourceCell.nodes, measuredCell.metrics, padTop);
      const cellBottomRow = Math.min(rowCount, g.rowIndex + g.rowSpan);
      const cellHeight = rowTops[cellBottomRow] - rowTops[g.rowIndex];
      const measuredHeight = measuredCell.height ?? 0;
      const slack = Math.max(0, cellHeight - measuredHeight);
      const verticalOffset =
        sourceCell.verticalAlign === 'bottom'
          ? slack
          : sourceCell.verticalAlign === 'center'
            ? slack / 2
            : 0;
      // Map cell-content y (relative to the cell/region top at rowTops[startRow])
      // into this row's coordinate space (relative to rowTops[r]).
      const shift = rowTops[r] - rowTops[g.rowIndex];
      for (const b of layout.flatBottoms) {
        const off = b + verticalOffset - shift;
        if (off > 0 && off < rowHeight) candidates.add(off);
      }
      for (const range of layout.unbreakableRanges) {
        unbreakableRanges.push({
          top: range.top + verticalOffset - shift,
          bottom: range.bottom + verticalOffset - shift,
        });
      }
    }

    // A line bottom from one cell is only a candidate. The same horizontal cut
    // may still pass through a staggered line in a sibling cell (or through a
    // line belonging to a vertically merged cell whose restart is above this
    // row). Keep it only when every active cell is between lines there.
    const safe = [...candidates].filter(
      (candidate) =>
        !unbreakableRanges.some((range) => candidate > range.top && candidate < range.bottom)
    );
    breakOffsets.push(safe.sort((a, b) => a - b));
  }

  return { rowTops, breakOffsets };
}

/**
 * Given a row and how much of it has already been placed (`fromOffset`),
 * return how many more px can be placed ending on a whole line, without
 * exceeding `maxSlice`. Returns 0 when not even the first line fits.
 */
export function snapRowBreak(
  info: TableRowBreakInfo,
  rowIndex: number,
  fromOffset: number,
  maxSlice: number
): number {
  const offsets = info.breakOffsets[rowIndex];
  if (!offsets || offsets.length === 0) return 0;
  const limit = fromOffset + maxSlice;
  let best = 0;
  for (const off of offsets) {
    if (off <= fromOffset) continue;
    if (off <= limit) best = off - fromOffset;
    else break;
  }
  return best;
}
