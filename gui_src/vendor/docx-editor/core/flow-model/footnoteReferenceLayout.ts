/**
 * Footnote-reference collection with physical table-row geometry.
 *
 * Table fragments retain the whole table's document range, so references in
 * rows that split across pages need measured cell-line geometry to identify
 * the fragment that actually paints the marker.
 */

import {
  DEFAULT_TEXTBOX_MARGINS,
  type NodeId,
  type ContentNode,
  type LayoutMetrics,
  type ParagraphMetrics,
  type TableMetrics,
} from '../pagination-model/types';
import { layoutCellContent } from './cellBlockLayout';

const MAX_REFERENCE_GEOMETRY_DEPTH = 32;
const MAX_REFERENCE_GEOMETRY_BLOCKS = 10_000;

/**
 * Where a footnote reference lives.
 *
 * `pmPos` identifies ordinary paragraph fragments. Table references also carry
 * their outer row and, when metrics are available, the marker line's midpoint
 * within that row.
 */
export type FootnoteRefLocation = {
  footnoteId: number;
  pmPos: number;
  tableNodeId?: NodeId;
  rowIndex?: number;
  rowOffset?: number;
  rowHeight?: number;
};

interface TableContext {
  tableNodeId: NodeId;
  rowTops: number[];
  sourceRowIndex: number;
}

interface CellGeometry {
  blockTops: Array<number | undefined>;
  lineTops: number[][];
  tableOffset: number;
}

interface GeometryBudget {
  remaining: number;
}

function measuredRowLocation(
  tableCtx: TableContext,
  geometry: CellGeometry | undefined,
  nodeIndex: number,
  runIndex: number,
  measure: LayoutMetrics | undefined
): Pick<FootnoteRefLocation, 'rowIndex' | 'rowOffset' | 'rowHeight'> {
  if (!geometry || measure?.kind !== 'paragraph') {
    return { rowIndex: tableCtx.sourceRowIndex };
  }
  const lineIndex = measure.lines.findIndex((line) => {
    const startsBeforeRun =
      line.fromRun < runIndex || (line.fromRun === runIndex && line.fromChar <= 0);
    const endsAfterRun = line.toRun > runIndex || (line.toRun === runIndex && line.toChar > 0);
    return startsBeforeRun && endsAfterRun;
  });
  const lineTop = geometry.lineTops[nodeIndex]?.[lineIndex];
  const line = measure.lines[lineIndex];
  if (lineTop == null || !line) return { rowIndex: tableCtx.sourceRowIndex };

  const tableOffset = geometry.tableOffset + lineTop + line.lineHeight / 2;
  let rowIndex = tableCtx.sourceRowIndex;
  while (
    rowIndex + 1 < tableCtx.rowTops.length - 1 &&
    tableOffset >= tableCtx.rowTops[rowIndex + 1]
  ) {
    rowIndex++;
  }
  const rowTop = tableCtx.rowTops[rowIndex];
  const rowBottom = tableCtx.rowTops[rowIndex + 1];
  if (rowTop == null || rowBottom == null || tableOffset < rowTop || tableOffset >= rowBottom) {
    return { rowIndex: tableCtx.sourceRowIndex };
  }
  return {
    rowIndex,
    rowOffset: tableOffset - rowTop,
    rowHeight: rowBottom - rowTop,
  };
}

function paragraphLineTops(measure: ParagraphMetrics, startY: number): number[] {
  const tops: number[] = [];
  let y = startY;
  for (const line of measure.lines) {
    y += line.floatSkipBefore ?? 0;
    tops.push(y);
    y += line.lineHeight;
  }
  return tops;
}

/**
 * Continue scanning after geometry recursion reaches its limit. This preserves
 * references and document order while deliberately degrading only their
 * physical location to the enclosing row.
 */
function collectRefsWithoutGeometry(
  input: readonly ContentNode[],
  refs: FootnoteRefLocation[],
  inheritedTableCtx?: TableContext
): void {
  const stack: Array<{ block: ContentNode; tableCtx?: TableContext }> = [];
  for (let index = input.length - 1; index >= 0; index--) {
    stack.push({ block: input[index], tableCtx: inheritedTableCtx });
  }

  while (stack.length > 0) {
    const current = stack.pop()!;
    const { block, tableCtx } = current;
    if (block.kind === 'paragraph') {
      for (const run of block.runs) {
        if (run.kind !== 'text' || run.footnoteRefId == null) continue;
        refs.push({
          footnoteId: run.footnoteRefId,
          pmPos: run.docFrom ?? 0,
          ...(tableCtx
            ? {
                tableNodeId: tableCtx.tableNodeId,
                rowIndex: tableCtx.sourceRowIndex,
              }
            : {}),
        });
      }
      continue;
    }

    const children: Array<{ block: ContentNode; tableCtx?: TableContext }> = [];
    if (block.kind === 'table') {
      block.rows.forEach((row, rowIndex) => {
        const nextTableCtx =
          tableCtx ??
          ({
            tableNodeId: block.id,
            rowTops: [],
            sourceRowIndex: rowIndex,
          } satisfies TableContext);
        for (const cell of row.cells) {
          for (const child of cell.nodes) children.push({ block: child, tableCtx: nextTableCtx });
        }
      });
    } else if (block.kind === 'textBox') {
      for (const child of block.content) children.push({ block: child, tableCtx });
    }
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
}

/**
 * Scan FlowBlocks for runs with `footnoteRefId`, in document order.
 *
 * When metrics are supplied, table refs use the shared cell-content stack
 * from row breaking to capture their physical position inside a split row.
 * Callers without metrics retain the row-only fallback.
 */
export function collectFootnoteRefs(
  nodes: ContentNode[],
  metrics?: LayoutMetrics[]
): FootnoteRefLocation[] {
  const refs: FootnoteRefLocation[] = [];
  const geometryBudget: GeometryBudget = { remaining: MAX_REFERENCE_GEOMETRY_BLOCKS };

  const walk = (
    input: ContentNode[],
    inputMetrics?: LayoutMetrics[],
    tableCtx?: TableContext,
    cellGeometry?: CellGeometry,
    depth = 0
  ): void => {
    if (depth > MAX_REFERENCE_GEOMETRY_DEPTH) {
      collectRefsWithoutGeometry(input, refs, tableCtx);
      return;
    }

    for (let nodeIndex = 0; nodeIndex < input.length; nodeIndex++) {
      const block = input[nodeIndex];
      const measure = inputMetrics?.[nodeIndex];
      const geometryAllowed = geometryBudget.remaining-- > 0;
      const activeGeometry = geometryAllowed ? cellGeometry : undefined;
      if (block.kind === 'paragraph') {
        for (let runIndex = 0; runIndex < block.runs.length; runIndex++) {
          const run = block.runs[runIndex];
          if (run.kind !== 'text' || run.footnoteRefId == null) continue;
          const tableLocation = tableCtx
            ? {
                tableNodeId: tableCtx.tableNodeId,
                ...measuredRowLocation(tableCtx, activeGeometry, nodeIndex, runIndex, measure),
              }
            : {};
          refs.push({
            footnoteId: run.footnoteRefId,
            pmPos: run.docFrom ?? 0,
            ...tableLocation,
          });
        }
      } else if (block.kind === 'table') {
        const tableMeasure: TableMetrics | undefined =
          geometryAllowed && measure?.kind === 'table' ? measure : undefined;
        const rowTops = [0];
        for (const rowMeasure of tableMeasure?.rows ?? []) {
          rowTops.push(rowTops[rowTops.length - 1] + rowMeasure.height);
        }
        const nestedTableTop =
          tableCtx && activeGeometry
            ? activeGeometry.tableOffset + (activeGeometry.blockTops[nodeIndex] ?? Number.NaN)
            : 0;
        block.rows.forEach((row, rowIndex) => {
          row.cells.forEach((cell, cellIndex) => {
            const cellMeasure = tableMeasure?.rows[rowIndex]?.cells[cellIndex];
            const nextTableCtx = tableCtx ?? {
              tableNodeId: block.id,
              rowTops,
              sourceRowIndex: rowIndex,
            };
            const hasMeasuredPosition =
              cellMeasure &&
              rowTops.length > rowIndex + 1 &&
              (!tableCtx || Number.isFinite(nestedTableTop));
            if (!hasMeasuredPosition) {
              walk(cell.nodes, cellMeasure?.metrics, nextTableCtx, undefined, depth + 1);
              return;
            }
            const rowSpan = Math.max(1, cell.rowSpan ?? 1);
            const cellEndRow = Math.min(tableMeasure!.rows.length, rowIndex + rowSpan);
            const cellHeight = rowTops[cellEndRow] - rowTops[rowIndex];
            const slack = Math.max(0, cellHeight - (cellMeasure.height ?? 0));
            const verticalOffset =
              cell.verticalAlign === 'bottom'
                ? slack
                : cell.verticalAlign === 'center'
                  ? slack / 2
                  : 0;
            const content = layoutCellContent(
              cell.nodes,
              cellMeasure.metrics,
              cell.padding?.top ?? 0
            );
            walk(
              cell.nodes,
              cellMeasure.metrics,
              nextTableCtx,
              {
                blockTops: content.blockTops,
                lineTops: content.lineTops,
                tableOffset: nestedTableTop + rowTops[rowIndex] + verticalOffset,
              },
              depth + 1
            );
          });
        });
      } else if (block.kind === 'textBox') {
        const innerMetrics = measure?.kind === 'textBox' ? measure.innerMetrics : undefined;
        const relativeTextBoxTop = activeGeometry?.blockTops[nodeIndex];
        const textBoxTop =
          !activeGeometry || relativeTextBoxTop == null
            ? undefined
            : activeGeometry.tableOffset + relativeTextBoxTop;
        if (!tableCtx || textBoxTop == null || !innerMetrics) {
          walk(block.content, innerMetrics, tableCtx, undefined, depth + 1);
          continue;
        }

        const margins = block.margins ?? DEFAULT_TEXTBOX_MARGINS;
        let paragraphTop = margins.top;
        const blockTops: number[] = [];
        const lineTops: number[][] = [];
        for (const innerMeasure of innerMetrics) {
          blockTops.push(paragraphTop);
          lineTops.push(paragraphLineTops(innerMeasure, paragraphTop));
          paragraphTop += innerMeasure.totalHeight;
        }
        walk(
          block.content,
          innerMetrics,
          tableCtx,
          { blockTops, lineTops, tableOffset: textBoxTop },
          depth + 1
        );
      }
    }
  };

  walk(nodes, metrics);
  return refs;
}
