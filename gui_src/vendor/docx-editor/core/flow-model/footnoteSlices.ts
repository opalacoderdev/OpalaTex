import type {
  FootnoteNodeFragment,
  FootnoteContent,
  FootnoteFragment,
} from '../pagination-model/types';
import { buildTableRowBreakInfo } from '../pagination-model/tableRowBreak';
import { fitTableRows } from '../pagination-model/tableLayout';

export interface FootnoteParagraphPosition {
  runIndex: number;
  charOffset: number;
}

export interface FootnoteSliceCursor {
  nodeIndex: number;
  /**
   * Page-local line index for an initial paragraph cursor, or row index for a
   * table cursor. Once a paragraph has started, `paragraphPosition` is the
   * width-independent source of truth and this value is only a cached hint.
   */
  unitIndex: number;
  unitOffset?: number;
  /** Stable continuation address in the paragraph's run stream. */
  paragraphPosition?: FootnoteParagraphPosition;
}

function measureLineHeight(line: { lineHeight: number; floatSkipBefore?: number }): number {
  return line.lineHeight + (line.floatSkipBefore ?? 0);
}

function compareParagraphPositions(
  left: FootnoteParagraphPosition,
  right: FootnoteParagraphPosition
): number {
  return left.runIndex - right.runIndex || left.charOffset - right.charOffset;
}

/**
 * Find the first measured line with content after `position`. A binary search
 * keeps continuation lookup logarithmic even for very long footnotes.
 */
function lineIndexForPosition(
  lines: Array<{ toRun: number; toChar: number }>,
  position: FootnoteParagraphPosition
): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const lineEnd = { runIndex: lines[mid].toRun, charOffset: lines[mid].toChar };
    if (compareParagraphPositions(lineEnd, position) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Take the largest whole-line/whole-row footnote slice that fits the available
 * page area. Atomic images and text boxes stay unsplit.
 */
export function takeFootnoteSlice(
  content: FootnoteContent,
  cursorIn: FootnoteSliceCursor,
  capacity: number,
  columnIndex: number,
  allowOversizedFirstUnit = false
): { fragment?: FootnoteFragment; cursor: FootnoteSliceCursor; done: boolean } {
  const cursor: FootnoteSliceCursor = { ...cursorIn };
  const nodes: FootnoteNodeFragment[] = [];
  let used = 0;

  while (cursor.nodeIndex < content.nodes.length) {
    const nodeIndex = cursor.nodeIndex;
    const block = content.nodes[nodeIndex];
    const measure = content.metrics[nodeIndex];
    if (!block || !measure) {
      cursor.nodeIndex++;
      cursor.unitIndex = 0;
      cursor.unitOffset = 0;
      cursor.paragraphPosition = undefined;
      continue;
    }

    if (block.kind === 'paragraph' && measure.kind === 'paragraph') {
      const fromLine = cursor.paragraphPosition
        ? lineIndexForPosition(measure.lines, cursor.paragraphPosition)
        : cursor.unitIndex;
      if (fromLine >= measure.lines.length) {
        cursor.nodeIndex++;
        cursor.unitIndex = 0;
        cursor.unitOffset = 0;
        cursor.paragraphPosition = undefined;
        continue;
      }

      const firstLine = measure.lines[fromLine];
      const contentFrom =
        cursor.paragraphPosition ??
        ({
          runIndex: firstLine.fromRun,
          charOffset: firstLine.fromChar,
        } satisfies FootnoteParagraphPosition);
      const spacingBefore = fromLine === 0 ? (block.attrs?.spacing?.before ?? 0) : 0;
      const lineTotal = measure.lines.reduce((sum, line) => sum + measureLineHeight(line), 0);
      const spacingAfter = Math.max(
        0,
        measure.totalHeight - (block.attrs?.spacing?.before ?? 0) - lineTotal
      );

      let lineHeight = 0;
      let toLine = fromLine;
      while (toLine < measure.lines.length) {
        const nextLineHeight = measureLineHeight(measure.lines[toLine]);
        const finishesParagraph = toLine + 1 === measure.lines.length;
        const candidate =
          used +
          spacingBefore +
          lineHeight +
          nextLineHeight +
          (finishesParagraph ? spacingAfter : 0);
        if (candidate > capacity && (used > 0 || lineHeight > 0 || !allowOversizedFirstUnit)) {
          break;
        }
        lineHeight += nextLineHeight;
        toLine++;
        if (candidate > capacity) break;
      }

      if (toLine === fromLine) break;
      const lastLine = measure.lines[toLine - 1];
      const contentTo: FootnoteParagraphPosition = {
        runIndex: lastLine.toRun,
        charOffset: lastLine.toChar,
      };
      nodes.push({
        kind: 'paragraph',
        nodeIndex,
        y: used + spacingBefore,
        height: lineHeight,
        fromLine,
        toLine,
        fromRun: contentFrom.runIndex,
        fromChar: contentFrom.charOffset,
        toRun: contentTo.runIndex,
        toChar: contentTo.charOffset,
      });
      const finished = toLine === measure.lines.length;
      used += spacingBefore + lineHeight + (finished ? spacingAfter : 0);
      if (!finished) {
        cursor.unitIndex = toLine;
        cursor.paragraphPosition = contentTo;
        break;
      }
      cursor.nodeIndex++;
      cursor.unitIndex = 0;
      cursor.unitOffset = 0;
      cursor.paragraphPosition = undefined;
      continue;
    }

    if (block.kind === 'table' && measure.kind === 'table') {
      const fromRow = cursor.unitIndex;
      const fromOffset = cursor.unitOffset ?? 0;
      if (fromRow >= measure.rows.length) {
        cursor.nodeIndex++;
        cursor.unitIndex = 0;
        cursor.unitOffset = 0;
        cursor.paragraphPosition = undefined;
        continue;
      }
      const rowsHeight = measure.rows.reduce((sum, row) => sum + row.height, 0);
      const trailing = Math.max(0, measure.totalHeight - rowsHeight);
      const available = Math.max(0, capacity - used);
      const breakInfo = buildTableRowBreakInfo(block, measure);
      let rowSlice = fitTableRows(block, measure, breakInfo, fromRow, fromOffset, available);
      if (rowSlice.nextRow >= measure.rows.length && rowSlice.consumed + trailing > available) {
        rowSlice = fitTableRows(
          block,
          measure,
          breakInfo,
          fromRow,
          fromOffset,
          Math.max(0, available - trailing)
        );
      }
      if (rowSlice.consumed <= 0) {
        if (used > 0 || !allowOversizedFirstUnit) break;
        const rowHeight = measure.rows[fromRow].height;
        rowSlice = {
          consumed: rowHeight - fromOffset,
          toRow: fromRow + 1,
          nextRow: fromRow + 1,
          nextOffset: 0,
          bottomClip: 0,
        };
      }
      const finished = rowSlice.nextRow >= measure.rows.length;
      const height = rowSlice.consumed + (finished ? trailing : 0);
      nodes.push({
        kind: 'table',
        nodeIndex,
        y: used,
        height,
        fromRow,
        toRow: rowSlice.toRow,
        ...(fromOffset > 0 ? { topClip: fromOffset } : {}),
        ...(rowSlice.bottomClip > 0 ? { bottomClip: rowSlice.bottomClip } : {}),
      });
      used += height;
      if (!finished) {
        cursor.unitIndex = rowSlice.nextRow;
        cursor.unitOffset = rowSlice.nextOffset;
        break;
      }
      cursor.nodeIndex++;
      cursor.unitIndex = 0;
      cursor.unitOffset = 0;
      cursor.paragraphPosition = undefined;
      continue;
    }

    if (
      (block.kind === 'image' && measure.kind === 'image') ||
      (block.kind === 'textBox' && measure.kind === 'textBox')
    ) {
      if (used + measure.height > capacity && (used > 0 || !allowOversizedFirstUnit)) {
        break;
      }
      nodes.push({
        kind: block.kind,
        nodeIndex,
        y: used,
        height: measure.height,
      });
      used += measure.height;
      cursor.nodeIndex++;
      cursor.unitIndex = 0;
      cursor.unitOffset = 0;
      cursor.paragraphPosition = undefined;
      if (used > capacity) break;
      continue;
    }

    // Break/section nodes occupy no footnote height.
    cursor.nodeIndex++;
    cursor.unitIndex = 0;
    cursor.unitOffset = 0;
    cursor.paragraphPosition = undefined;
  }

  const done = cursor.nodeIndex >= content.nodes.length;
  if (nodes.length === 0) return { cursor, done };
  return {
    fragment: {
      footnoteId: content.id,
      displayNumber: content.displayNumber,
      nodes,
      height: used,
      ...(columnIndex > 0 ? { columnIndex } : {}),
    },
    cursor,
    done,
  };
}
