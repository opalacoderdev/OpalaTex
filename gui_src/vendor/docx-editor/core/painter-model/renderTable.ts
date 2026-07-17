/**
 * Table Renderer
 *
 * Renders table fragments to DOM. Handles:
 * - Multi-row tables split across pages
 * - Cell content (paragraphs within cells)
 * - Column widths and cell spans
 * - Basic cell styling (borders, backgrounds)
 */

import type {
  TableFragment,
  TableBlock,
  TableMetrics,
  TableCell,
  TableCellMetrics,
} from '../pagination-model/types';
import type { RenderContext } from './paintPage';
import { resolveCellGrid } from '../flow-model/tableWidthUtils';
import {
  styleBorder,
  buildRowYPositions,
  isVisibleBorder,
  makeCutBorder,
  makeTableBodyClip,
} from './renderTableBorders';
import { applyRevisionAttrs } from './renderTableRevisions';
import {
  applyWholeTableRevisionDom,
  getWholeTableRevisionMetadata,
  resolveCellContentBox,
  type CellFloatRevisionContext,
} from './renderTableRevisionBars';
import type { RevisionBarCollector } from './revisionIndicators';
import { renderCellContent } from './renderTableCellContent';

export { getTableRevisionBarSpans, getWholeTableRevisionMetadata } from './renderTableRevisionBars';

/**
 * CSS class names for table elements
 */
export const TABLE_CLASS_NAMES = {
  table: 'layout-table',
  row: 'layout-table-row',
  cell: 'layout-table-cell',
  cellContent: 'layout-table-cell-content',
  resizeHandle: 'layout-table-resize-handle',
  rowResizeHandle: 'layout-table-row-resize-handle',
  tableEdgeHandleBottom: 'layout-table-edge-handle-bottom',
  tableEdgeHandleRight: 'layout-table-edge-handle-right',
};

/**
 * Options for rendering a table fragment
 */
export interface RenderTableFragmentOptions {
  document?: Document;
  revisionBars?: {
    collector: RevisionBarCollector;
    /** Table fragment top in the owning collector's coordinate space. */
    originTop: number;
  };
}

/**
 * Render a single table cell
 */
function paintTableCell(
  cell: TableCell,
  cellMetrics: TableCellMetrics,
  x: number,
  rowHeight: number,
  borderFlags: {
    isFirstRow: boolean;
    isLastRow: boolean;
    isFirstCol: boolean;
    isLastCol: boolean;
  },
  context: RenderContext,
  doc: Document,
  /** Row-level tracked revision id (if any). When the cell's tracked
   * marker shares this id, the row visual already covers it — suppress
   * the per-cell border / background to avoid stacking 2-3 green visuals
   * on the same cell. */
  parentRowRevisionId?: number,
  revisionContext?: Omit<CellFloatRevisionContext, 'contentTop' | 'contentHeight'>
): HTMLElement {
  const cellEl = doc.createElement('div');
  cellEl.className = TABLE_CLASS_NAMES.cell;

  if (cell.trackedMarker && cell.trackedMarker.info.revisionId !== parentRowRevisionId) {
    applyRevisionAttrs(cellEl, 'cell', cell.trackedMarker.kind, cell.trackedMarker.info);
  }

  // Positioning
  cellEl.style.position = 'absolute';
  cellEl.style.left = `${x}px`;
  cellEl.style.top = '0';
  cellEl.style.width = `${cellMetrics.width}px`;
  cellEl.style.height = `${rowHeight}px`;
  cellEl.style.overflow = 'hidden';
  cellEl.style.boxSizing = 'border-box';
  // Use per-cell padding from DOCX margins, default to Word's visual rendering
  const padTop = cell.padding?.top ?? 1;
  const padRight = cell.padding?.right ?? 7;
  const padBottom = cell.padding?.bottom ?? 1;
  const padLeft = cell.padding?.left ?? 7;
  cellEl.style.padding = `${padTop}px ${padRight}px ${padBottom}px ${padLeft}px`;

  // Apply borders - use cell borders if available, otherwise no border
  if (cell.borders) {
    // Collapse shared borders to avoid double-thick lines.
    // Strategy: "bottom wins" for rows, "right wins" for columns.
    // Each cell's bottom border represents the shared edge with the row below.
    // Each cell's right border represents the shared edge with the column to its right.
    // Only the first row draws its top border (table's top edge).
    // Only the first column draws its left border (table's left edge).
    if (borderFlags.isFirstRow) {
      styleBorder(cellEl, 'top', cell.borders.top);
    }
    styleBorder(cellEl, 'right', cell.borders.right);
    styleBorder(cellEl, 'bottom', cell.borders.bottom);
    if (borderFlags.isFirstCol) styleBorder(cellEl, 'left', cell.borders.left);
  }
  // No default border - cells without explicit borders should be borderless

  // Background color
  if (cell.background) {
    cellEl.style.backgroundColor = cell.background;
  }

  // `w:noWrap` (§17.4.30): forbid soft-wrapping inside the cell. We apply
  // it on the cell box so descendants pick it up by inheritance — paragraph
  // lines remain a single visual line that may grow the cell's effective
  // content width past its measured size.
  if (cell.noWrap) {
    cellEl.style.whiteSpace = 'nowrap';
  }

  // Vertical alignment. When the content fills or overflows the cell box
  // (e.g. a vertically-merged cell whose content was distributed to span its
  // rows), Word top-anchors it — vAlign only positions the leftover slack.
  // Forcing top here also keeps the painted lines aligned with the break
  // offsets the pageComposer computed (which assume top-anchored content).
  const contentBox = resolveCellContentBox(cell, cellMetrics, rowHeight, borderFlags);
  if (contentBox.justifyContent) {
    cellEl.style.display = 'flex';
    cellEl.style.flexDirection = 'column';
    cellEl.style.justifyContent = contentBox.justifyContent;
  }

  // Render cell content
  const contentEl = renderCellContent(
    cell,
    cellMetrics,
    context,
    doc,
    revisionContext
      ? {
          ...revisionContext,
          contentTop: contentBox.top,
          contentHeight: contentBox.height,
        }
      : undefined
  );
  cellEl.appendChild(contentEl);

  // Store PM positions for selection
  if (cell.nodes.length > 0) {
    const firstBlock = cell.nodes[0];
    const lastBlock = cell.nodes[cell.nodes.length - 1];
    if (firstBlock && 'docFrom' in firstBlock && firstBlock.docFrom !== undefined) {
      cellEl.dataset.docFrom = String(firstBlock.docFrom);
    }
    if (lastBlock && 'docTo' in lastBlock && lastBlock.docTo !== undefined) {
      cellEl.dataset.docTo = String(lastBlock.docTo);
    }
  }

  return cellEl;
}

/**
 * Track cells that span multiple rows
 */
export type SpanningCell = {
  cell: TableCell;
  cellMetrics: TableCellMetrics;
  columnIndex: number;
  startRow: number;
  rowSpan: number;
  colSpan: number;
  x: number;
  totalHeight: number;
};

/** A merged cell resolved for cross-fragment re-emit (grid placement + x). */
type GridCell = {
  rowIndex: number;
  cellIndex: number;
  columnIndex: number;
  x: number;
  colSpan: number;
  rowSpan: number;
  cell: TableCell;
};

/**
 * Resolve each cell's column index (via the shared grid resolver) and add its
 * pixel x offset from this table's column widths.
 */
function computeCellGrid(block: TableBlock, columnWidths: number[]): GridCell[] {
  // RTL table (`w:bidiVisual`): mirror x so logical column 0 lands at the right
  // edge (width unchanged). vmerge re-emit + cut-edge borders inherit GridCell.x.
  const bidi = block.bidi === true;
  const tableWidth = bidi ? columnWidths.reduce((w, cw) => w + (cw ?? 0), 0) : 0;
  return resolveCellGrid(block).map((g) => {
    let x = 0;
    for (let c = 0; c < g.columnIndex; c++) x += columnWidths[c] ?? 0;
    if (bidi) {
      let cellWidth = 0;
      for (let c = 0; c < g.colSpan; c++) cellWidth += columnWidths[g.columnIndex + c] ?? 0;
      x = tableWidth - x - cellWidth;
    }
    return {
      rowIndex: g.rowIndex,
      cellIndex: g.cellIndex,
      columnIndex: g.columnIndex,
      x,
      colSpan: g.colSpan,
      rowSpan: g.rowSpan,
      cell: block.rows[g.rowIndex]!.cells[g.cellIndex]!,
    };
  });
}

/**
 * Render a table row with rowSpan support
 */
export function paintTableRow(
  row: TableBlock['rows'][number],
  rowMeasure: TableMetrics['rows'][number],
  rowIndex: number,
  y: number,
  columnWidths: number[],
  totalRows: number,
  context: RenderContext,
  doc: Document,
  spanningCells?: Map<string, SpanningCell>,
  rowYPositions?: number[],
  isFirstRowInFragment?: boolean,
  /** When the parent table already carries a whole-table revision bar,
   * the per-row bar would double-paint. Suppress. */
  suppressRowRevisionVisual?: boolean,
  /** RTL table (`w:bidiVisual`): mirror cell x and swap first/last column. */
  bidi = false,
  /** Sum of `columnWidths`, used to mirror x when `bidi`. */
  tableWidth = 0,
  revisionContext?: Omit<CellFloatRevisionContext, 'rowHeight' | 'contentTop' | 'contentHeight'>
): HTMLElement {
  const rowEl = doc.createElement('div');
  rowEl.className = TABLE_CLASS_NAMES.row;

  // Tracked-row marker (sidebar reads the same data attrs as cells).
  // Prefer `del` when both flags are present (rare; "ins of a row that
  // was later marked deleted" — the deletion is the more recent action).
  if (!suppressRowRevisionVisual) {
    if (row.trackedDel) {
      applyRevisionAttrs(rowEl, 'row', 'del', row.trackedDel);
    } else if (row.trackedIns) {
      applyRevisionAttrs(rowEl, 'row', 'ins', row.trackedIns);
    }
  }

  // Use the pixel-rounded row height (diff of rounded row offsets) so the row
  // box edges — and the borders on them — sit on whole pixels. Falls back to
  // the measured height when row offsets aren't supplied (defensive).
  const renderedRowHeight =
    rowYPositions && rowYPositions.length > rowIndex + 1
      ? (rowYPositions[rowIndex + 1] ?? 0) - (rowYPositions[rowIndex] ?? 0)
      : rowMeasure.height;

  // Positioning
  rowEl.style.position = 'absolute';
  rowEl.style.left = '0';
  rowEl.style.top = `${y}px`;
  rowEl.style.width = '100%';
  rowEl.style.height = `${renderedRowHeight}px`;

  // Data attributes
  rowEl.dataset.rowIndex = String(rowIndex);

  // Build set of columns occupied by spanning cells from previous rows
  const occupiedColumns = new Set<number>();
  if (spanningCells) {
    for (const [, spanCell] of spanningCells) {
      // Check if this spanning cell covers the current row
      if (spanCell.startRow < rowIndex && spanCell.startRow + spanCell.rowSpan > rowIndex) {
        for (let c = 0; c < spanCell.colSpan; c++) {
          occupiedColumns.add(spanCell.columnIndex + c);
        }
      }
    }
  }

  // Render cells
  // Track actual column index separately from cell index
  // because cells with colSpan > 1 span multiple columns
  let x = 0;
  let columnIndex = 0;

  // Skip columns occupied by spanning cells
  while (occupiedColumns.has(columnIndex)) {
    x += columnWidths[columnIndex] ?? 0;
    columnIndex++;
  }

  for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex++) {
    const cell = row.cells[cellIndex];
    const cellMetrics = rowMeasure.cells[cellIndex];

    if (!cell || !cellMetrics) continue;

    const colSpan = cell.colSpan ?? 1;
    const rowSpan = cell.rowSpan ?? 1;

    // Calculate cell height - for spanning cells, use total height of spanned rows
    let cellHeight = renderedRowHeight;
    if (rowSpan > 1 && rowYPositions) {
      cellHeight = 0;
      for (let r = rowIndex; r < rowIndex + rowSpan && r < rowYPositions.length - 1; r++) {
        cellHeight += (rowYPositions[r + 1] ?? 0) - (rowYPositions[r] ?? 0);
      }
      // Fallback if rowYPositions doesn't have enough entries
      if (cellHeight === 0) {
        cellHeight = rowMeasure.height * rowSpan;
      }
    }

    // Column-span width, computed up front so an RTL cell can mirror its x.
    let cellWidth = 0;
    for (let c = 0; c < colSpan && columnIndex + c < columnWidths.length; c++) {
      cellWidth += columnWidths[columnIndex + c] ?? 0;
    }

    const isFirstRow = rowIndex === 0 || isFirstRowInFragment === true;
    const isLastRow = rowIndex + rowSpan >= totalRows;
    // In an RTL table the visual first/last columns are the logical last/first.
    const isFirstCol = bidi ? columnIndex + colSpan >= columnWidths.length : columnIndex === 0;
    const isLastCol = bidi ? columnIndex === 0 : columnIndex + colSpan >= columnWidths.length;

    const cellEl = paintTableCell(
      cell,
      cellMetrics,
      bidi ? tableWidth - x - cellWidth : x,
      cellHeight,
      { isFirstRow, isLastRow, isFirstCol, isLastCol },
      context,
      doc,
      row.trackedIns?.revisionId ?? row.trackedDel?.revisionId,
      revisionContext
        ? {
            ...revisionContext,
            rowHeight: cellHeight,
          }
        : undefined
    );
    cellEl.dataset.cellIndex = String(cellIndex);
    cellEl.dataset.columnIndex = String(columnIndex);

    // Store rowSpan info for styling
    if (rowSpan > 1) {
      cellEl.dataset.rowSpan = String(rowSpan);
    }

    rowEl.appendChild(cellEl);

    // Track this cell as spanning if it spans multiple rows
    if (rowSpan > 1 && spanningCells) {
      const key = `${rowIndex}-${columnIndex}`;
      spanningCells.set(key, {
        cell,
        cellMetrics,
        columnIndex,
        startRow: rowIndex,
        rowSpan,
        colSpan,
        x,
        totalHeight: cellHeight,
      });
    }

    // Move x by the width of columns this cell spans (logical left-to-right;
    // the mirror is applied per-cell above, not to this running accumulator).
    x += cellWidth;

    // Advance column index by colSpan
    columnIndex += colSpan;

    // Skip columns occupied by spanning cells
    while (occupiedColumns.has(columnIndex)) {
      x += columnWidths[columnIndex] ?? 0;
      columnIndex++;
    }
  }

  return rowEl;
}

/**
 * Render a table fragment to DOM
 *
 * @param fragment - The table fragment to render
 * @param block - The full table block
 * @param measure - The full table measure
 * @param context - Rendering context
 * @param config - Rendering config
 * @returns The table DOM element
 */
export function paintTableFragment(
  fragment: TableFragment,
  block: TableBlock,
  measure: TableMetrics,
  context: RenderContext,
  config: RenderTableFragmentOptions = {}
): HTMLElement {
  const doc = config.document ?? document;

  const tableEl = doc.createElement('div');
  tableEl.className = TABLE_CLASS_NAMES.table;

  // Outer positioning: body's per-page layout uses `absolute` (caller sets
  // x/y via applyFragmentStyles); HF / textbox flow nodes vertically and
  // pass `positioning: 'flow'` so the table participates in normal document
  // flow instead. Pre-PR (#379) those callers had to overwrite the inline
  // style after the renderer call.
  tableEl.style.position = context.positioning === 'flow' ? 'relative' : 'absolute';
  tableEl.style.width = `${fragment.width}px`;
  // Height is set below from the rounded row stack (`visibleHeight`) once the
  // window geometry is known — fragment.height (engine, unrounded) can be ~1px
  // short of the painter's rounded rows and would clip the bottom border.
  tableEl.style.overflow = 'hidden';

  // Store metadata
  tableEl.dataset.blockId = String(fragment.nodeId);
  tableEl.dataset.fromRow = String(fragment.fromRow);
  tableEl.dataset.toRow = String(fragment.toRow);

  if (fragment.docFrom !== undefined) {
    tableEl.dataset.docFrom = String(fragment.docFrom);
  }
  if (fragment.docTo !== undefined) {
    tableEl.dataset.docTo = String(fragment.docTo);
  }

  // Whole-table tracked insertion / deletion — keep the class + metadata for
  // local cues and sidebar grouping, but the page-margin bar is painted by the
  // owning revision collector.
  const wholeTableRevision = getWholeTableRevisionMetadata(block.rows);
  const fragWholeTableTracked = wholeTableRevision != null;
  if (wholeTableRevision) {
    applyWholeTableRevisionDom(tableEl, wholeTableRevision);
  }

  // RTL table mirror axis (see computeCellGrid), reused by the handles below.
  const bidi = block.bidi === true;
  const tableWidth = measure.columnWidths.reduce((w, cw) => w + (cw ?? 0), 0);

  // Add column resize handles at each column boundary
  let handleX = 0;
  for (let col = 0; col < measure.columnWidths.length - 1; col++) {
    handleX += measure.columnWidths[col] ?? 0;
    const handle = doc.createElement('div');
    handle.className = TABLE_CLASS_NAMES.resizeHandle;
    handle.style.position = 'absolute';
    handle.style.left = `${(bidi ? tableWidth - handleX : handleX) - 3}px`;
    handle.style.top = '0';
    handle.style.width = '6px';
    handle.style.height = '100%';
    handle.style.cursor = 'col-resize';
    handle.style.zIndex = '10';
    handle.dataset.columnIndex = String(col);
    handle.dataset.tableNodeId = String(fragment.nodeId);
    if (fragment.docFrom !== undefined) {
      handle.dataset.tablePmStart = String(fragment.docFrom);
    }
    tableEl.appendChild(handle);
  }

  const rowYPositions = buildRowYPositions(measure.rows);

  // Resolve cell grid placement once (column index + x per cell).
  const grid = computeCellGrid(block, measure.columnWidths);

  // Render repeated header rows for continuation fragments at the very top of
  // the fragment, in their own coordinate space above the windowed body.
  const headerRowCount = fragment.headerRowCount ?? 0;
  let headerHeight = 0;
  if (headerRowCount > 0 && fragment.continuesFromPrev) {
    const headerSpans = new Map<string, SpanningCell>();
    for (let hdrIdx = 0; hdrIdx < headerRowCount; hdrIdx++) {
      const hdrRow = block.rows[hdrIdx];
      const hdrRowMeasure = measure.rows[hdrIdx];
      if (!hdrRow || !hdrRowMeasure) continue;

      const rowEl = paintTableRow(
        hdrRow,
        hdrRowMeasure,
        hdrIdx,
        headerHeight,
        measure.columnWidths,
        block.rows.length,
        context,
        doc,
        headerSpans,
        rowYPositions,
        hdrIdx === 0, // first header row draws top border
        fragWholeTableTracked,
        bidi,
        tableWidth,
        config.revisionBars
          ? {
              ...config.revisionBars,
              rowTop: headerHeight,
              clipTop: headerHeight,
              clipBottom: headerHeight + hdrRowMeasure.height,
            }
          : undefined
      );
      rowEl.dataset.repeatedHeader = 'true';
      tableEl.appendChild(rowEl);
      headerHeight += hdrRowMeasure.height;
    }
  }

  // This fragment shows a vertical window of the table starting at `winTop`
  // (full-table coordinates). Body rows render translated by `-winTop` and the
  // table's `overflow:hidden` clips anything outside the window — so a row that
  // broke mid-content (topClip) or a tall cell spilling past the page bottom
  // are clipped automatically, and the slice continues on the next fragment.
  const winTop = (rowYPositions[fragment.fromRow] ?? 0) + (fragment.topClip ?? 0);
  const toFragmentY = (fullY: number): number => headerHeight + (fullY - winTop);

  // Visible height of this fragment's window. For a clean bottom (a real row
  // boundary) use the rounded row stack so the last row's bottom border sits
  // exactly on the clip edge (not 1px past it, which overflow:hidden would eat);
  // for a mid-content break, clip at the rounded fragment height.
  const visibleHeight =
    fragment.bottomClip !== undefined
      ? Math.round(fragment.height)
      : toFragmentY(rowYPositions[fragment.toRow] ?? 0);
  tableEl.style.height = `${visibleHeight}px`;

  // A repeated header occupies [0, headerHeight]; the windowed body gets its own
  // clip box below it so a row resumed mid-content doesn't paint over the header
  // (see makeTableBodyClip). With no header, the table element is reused as-is.
  const { bodyParent, bodyOriginY } = makeTableBodyClip(
    tableEl,
    headerHeight,
    visibleHeight,
    fragment.width,
    doc
  );
  // Full-table Y within `bodyParent` (== toFragmentY when there's no clip box).
  const toBodyY = (fullY: number): number => toFragmentY(fullY) - bodyOriginY;

  // Track spanning cells across rows within this fragment.
  const spanningCells = new Map<string, SpanningCell>();

  // Re-emit vertically-merged cells whose restart row is on an EARLIER
  // fragment but whose span reaches into this one. This keeps their column
  // occupied (so body cells keep their grid columns) and flows the merged
  // content across the break: the cell is positioned at its true (negative)
  // top, and overflow:hidden hides the slice already shown on the prior page.
  const drawsHeaderRows = headerRowCount > 0 && fragment.continuesFromPrev;
  for (const g of grid) {
    if (g.rowSpan <= 1) continue;
    if (g.rowIndex >= fragment.fromRow) continue; // starts in this fragment → its row draws it
    if (g.rowIndex + g.rowSpan <= fragment.fromRow) continue; // ends before this fragment
    // A merged cell whose restart row is a repeated header is already drawn by
    // the header pass above — don't re-emit it (would double-paint).
    if (drawsHeaderRows && g.rowIndex < headerRowCount) continue;
    const cellMetrics = measure.rows[g.rowIndex]?.cells?.[g.cellIndex];
    if (!cellMetrics) continue;

    let spanHeight = 0;
    for (let r = g.rowIndex; r < g.rowIndex + g.rowSpan && r < rowYPositions.length - 1; r++) {
      spanHeight += (rowYPositions[r + 1] ?? 0) - (rowYPositions[r] ?? 0);
    }

    spanningCells.set(`${g.rowIndex}-${g.columnIndex}`, {
      cell: g.cell,
      cellMetrics,
      columnIndex: g.columnIndex,
      startRow: g.rowIndex,
      rowSpan: g.rowSpan,
      colSpan: g.colSpan,
      x: g.x,
      totalHeight: spanHeight,
    });

    const isLastRow = g.rowIndex + g.rowSpan >= block.rows.length;
    // RTL: visual first/last columns are the logical last/first.
    const isFirstCol = bidi
      ? g.columnIndex + g.colSpan >= measure.columnWidths.length
      : g.columnIndex === 0;
    const isLastCol = bidi
      ? g.columnIndex === 0
      : g.columnIndex + g.colSpan >= measure.columnWidths.length;
    const cellEl = paintTableCell(
      g.cell,
      cellMetrics,
      g.x,
      spanHeight,
      { isFirstRow: false, isLastRow, isFirstCol, isLastCol },
      context,
      doc,
      undefined,
      config.revisionBars
        ? {
            ...config.revisionBars,
            rowTop: toFragmentY(rowYPositions[g.rowIndex] ?? 0),
            rowHeight: spanHeight,
            clipTop: headerHeight,
            clipBottom: visibleHeight,
          }
        : undefined
    );
    cellEl.style.top = `${toBodyY(rowYPositions[g.rowIndex] ?? 0)}px`;
    cellEl.dataset.columnIndex = String(g.columnIndex);
    // Synthetic continuation slice: not directly selectable (the editable cell
    // lives on the fragment that owns its restart row).
    cellEl.dataset.vmergeContinuation = 'true';
    delete cellEl.dataset.docFrom;
    delete cellEl.dataset.docTo;
    bodyParent.appendChild(cellEl);
  }

  // Render content rows from fragment.fromRow to fragment.toRow in window coords.
  for (let rowIndex = fragment.fromRow; rowIndex < fragment.toRow; rowIndex++) {
    const row = block.rows[rowIndex];
    const rowMeasure = measure.rows[rowIndex];

    if (!row || !rowMeasure) continue;

    // A clean continuation boundary draws the row's top border; a row that
    // broke mid-content (topClip) does not (its top is above the window anyway).
    const isFirstRowInFragment =
      headerRowCount > 0 && fragment.continuesFromPrev
        ? false
        : fragment.continuesFromPrev && rowIndex === fragment.fromRow && !fragment.topClip;

    const rowEl = paintTableRow(
      row,
      rowMeasure,
      rowIndex,
      toBodyY(rowYPositions[rowIndex] ?? 0),
      measure.columnWidths,
      block.rows.length,
      context,
      doc,
      spanningCells,
      rowYPositions,
      isFirstRowInFragment,
      fragWholeTableTracked,
      bidi,
      tableWidth,
      config.revisionBars
        ? {
            ...config.revisionBars,
            rowTop: toFragmentY(rowYPositions[rowIndex] ?? 0),
            clipTop: headerHeight,
            clipBottom: visibleHeight,
          }
        : undefined
    );

    bodyParent.appendChild(rowEl);
  }

  // Close a fragment at a page break with a horizontal border on the cut edge,
  // the way Word does — otherwise the cell's own top/bottom border is off-window
  // (clipped) and the fragment looks open at the break. Emit one rule per column
  // (using the cell active in that column) so per-column border styles, colSpans,
  // merged columns, and borderless columns are all respected.
  //
  // `onlySpanning` limits drawing to cells that actually cross the edge — used at
  // a clean row boundary, where ordinary cells already drew their own border and
  // only a vertically-merged cell spanning into the next/prev fragment is open.
  const drawCutEdge = (
    cutRow: number,
    side: 'top' | 'bottom',
    topY: number,
    onlySpanning: boolean
  ) => {
    for (const g of grid) {
      // Cell must be present in (or span through) the cut row.
      if (g.rowIndex > cutRow || g.rowIndex + g.rowSpan - 1 < cutRow) continue;
      if (onlySpanning) {
        const crosses =
          side === 'bottom' ? g.rowIndex + g.rowSpan - 1 > cutRow : g.rowIndex < cutRow;
        if (!crosses) continue;
      }
      const spec = g.cell.borders?.[side];
      if (!isVisibleBorder(spec)) continue;
      let width = 0;
      for (let c = 0; c < g.colSpan; c++) width += measure.columnWidths[g.columnIndex + c] ?? 0;
      tableEl.appendChild(makeCutBorder(doc, { x: g.x, topY, width, edge: side, border: spec }));
    }
  };
  // Top edge: a row broken mid-content (topClip) closes every column; a clean
  // continuation only needs the merged cells that span in from the prior page.
  if (fragment.topClip) drawCutEdge(fragment.fromRow, 'top', headerHeight, false);
  else if (fragment.continuesFromPrev) drawCutEdge(fragment.fromRow, 'top', headerHeight, true);
  // Bottom edge: same, mirrored. Anchor to the element's actual bottom
  // (`visibleHeight`) so the rule sits exactly on the clip edge.
  if (fragment.bottomClip !== undefined)
    drawCutEdge(fragment.toRow - 1, 'bottom', visibleHeight, false);
  else if (fragment.continuesOnNext) drawCutEdge(fragment.toRow - 1, 'bottom', visibleHeight, true);

  // Row resize handles at row boundaries that fall inside the visible window.
  for (let rowIdx = fragment.fromRow; rowIdx < fragment.toRow - 1; rowIdx++) {
    const boundaryY = toFragmentY(rowYPositions[rowIdx + 1] ?? 0);
    if (boundaryY <= headerHeight || boundaryY >= fragment.height) continue;
    const rowHandle = doc.createElement('div');
    rowHandle.className = TABLE_CLASS_NAMES.rowResizeHandle;
    rowHandle.style.position = 'absolute';
    rowHandle.style.left = '0';
    rowHandle.style.top = `${boundaryY - 3}px`;
    rowHandle.style.width = '100%';
    rowHandle.style.height = '6px';
    rowHandle.style.cursor = 'row-resize';
    rowHandle.style.zIndex = '10';
    rowHandle.dataset.rowIndex = String(rowIdx);
    rowHandle.dataset.tableNodeId = String(fragment.nodeId);
    if (fragment.docFrom !== undefined) {
      rowHandle.dataset.tablePmStart = String(fragment.docFrom);
    }
    tableEl.appendChild(rowHandle);
  }

  // Bottom edge handle — only on the fragment that ends the table.
  const endsTable = fragment.toRow === block.rows.length && fragment.bottomClip === undefined;
  if (endsTable) {
    const bottomHandle = doc.createElement('div');
    bottomHandle.className = TABLE_CLASS_NAMES.tableEdgeHandleBottom;
    bottomHandle.style.position = 'absolute';
    bottomHandle.style.left = '0';
    bottomHandle.style.top = `${toFragmentY(rowYPositions[fragment.toRow] ?? 0) - 3}px`;
    bottomHandle.style.width = '100%';
    bottomHandle.style.height = '6px';
    bottomHandle.style.cursor = 'row-resize';
    bottomHandle.style.zIndex = '10';
    bottomHandle.dataset.rowIndex = String(block.rows.length - 1);
    bottomHandle.dataset.tableNodeId = String(fragment.nodeId);
    bottomHandle.dataset.isEdge = 'bottom';
    if (fragment.docFrom !== undefined) {
      bottomHandle.dataset.tablePmStart = String(fragment.docFrom);
    }
    tableEl.appendChild(bottomHandle);
  }

  // Right edge handle (only on fragments containing the last row)
  if (endsTable) {
    const rightHandle = doc.createElement('div');
    rightHandle.className = TABLE_CLASS_NAMES.tableEdgeHandleRight;
    rightHandle.style.position = 'absolute';
    rightHandle.style.left = `${tableWidth - 3}px`;
    rightHandle.style.top = '0';
    rightHandle.style.width = '6px';
    rightHandle.style.height = '100%';
    rightHandle.style.cursor = 'col-resize';
    rightHandle.style.zIndex = '10';
    rightHandle.dataset.columnIndex = String(measure.columnWidths.length - 1);
    rightHandle.dataset.tableNodeId = String(fragment.nodeId);
    rightHandle.dataset.isEdge = 'right';
    if (fragment.docFrom !== undefined) {
      rightHandle.dataset.tablePmStart = String(fragment.docFrom);
    }
    tableEl.appendChild(rightHandle);
  }

  return tableEl;
}
