import { describe, expect, test } from 'bun:test';
import type {
  MeasuredLine,
  ParagraphBlock,
  ParagraphMetrics,
  TableBlock,
  TableCellMetrics,
  TableMetrics,
} from './types';
import { buildTableRowBreakInfo, snapRowBreak } from './tableRowBreak';

function paragraph(id: string): ParagraphBlock {
  return {
    kind: 'paragraph',
    id,
    runs: [{ kind: 'text', text: id }],
  };
}

function paragraphMetrics(...heights: number[]): ParagraphMetrics {
  return {
    kind: 'paragraph',
    totalHeight: heights.reduce((sum, height) => sum + height, 0),
    lines: heights.map(
      (lineHeight, index): MeasuredLine => ({
        fromRun: 0,
        fromChar: index,
        toRun: 0,
        toChar: index + 1,
        width: 10,
        ascent: lineHeight * 0.8,
        descent: lineHeight * 0.2,
        lineHeight,
      })
    ),
  };
}

function cellMetrics(metrics: ParagraphMetrics): TableCellMetrics {
  return { metrics: [metrics], width: 50, height: metrics.totalHeight };
}

describe('table row split candidates', () => {
  test('rejects a line bottom that cuts through a staggered sibling line', () => {
    const node: TableBlock = {
      kind: 'table',
      id: 'table',
      columnWidths: [50, 50],
      rows: [
        {
          id: 'row',
          cells: [
            { id: 'a', nodes: [paragraph('a')] },
            { id: 'b', nodes: [paragraph('b')] },
          ],
        },
      ],
    };
    const a = paragraphMetrics(10, 10, 10, 10);
    const b = paragraphMetrics(15, 15, 10);
    const metrics: TableMetrics = {
      kind: 'table',
      totalWidth: 100,
      totalHeight: 40,
      columnWidths: [50, 50],
      rows: [
        {
          height: 40,
          cells: [cellMetrics(a), cellMetrics(b)],
        },
      ],
    };

    const info = buildTableRowBreakInfo(node, metrics);

    expect(info.breakOffsets[0]).toEqual([30, 40]);
    expect(snapRowBreak(info, 0, 0, 20)).toBe(0);
    expect(snapRowBreak(info, 0, 0, 31)).toBe(30);
  });

  test('offsets safe cuts for vertically centered cell content', () => {
    const node: TableBlock = {
      kind: 'table',
      id: 'centered-table',
      columnWidths: [50],
      rows: [
        {
          id: 'row',
          cells: [{ id: 'centered', verticalAlign: 'center', nodes: [paragraph('centered')] }],
        },
      ],
    };
    const cellContentMetrics = paragraphMetrics(10, 10);
    const metrics: TableMetrics = {
      kind: 'table',
      totalWidth: 50,
      totalHeight: 60,
      columnWidths: [50],
      rows: [{ height: 60, cells: [cellMetrics(cellContentMetrics)] }],
    };

    const info = buildTableRowBreakInfo(node, metrics);

    expect(info.breakOffsets[0]).toEqual([30, 40, 60]);
    expect(snapRowBreak(info, 0, 0, 25)).toBe(0);
    expect(snapRowBreak(info, 0, 0, 30)).toBe(30);
  });

  test('includes a vMerge restart when checking continuation-row cuts', () => {
    const node: TableBlock = {
      kind: 'table',
      id: 'table',
      columnWidths: [50, 50],
      rows: [
        {
          id: 'row-0',
          cells: [
            { id: 'merged', rowSpan: 2, nodes: [paragraph('merged')] },
            { id: 'top', nodes: [paragraph('top')] },
          ],
        },
        {
          id: 'row-1',
          cells: [{ id: 'continuation-sibling', nodes: [paragraph('sibling')] }],
        },
      ],
    };
    const merged = paragraphMetrics(12, 12, 12);
    const top = paragraphMetrics(10, 10);
    const sibling = paragraphMetrics(10, 10);
    const metrics: TableMetrics = {
      kind: 'table',
      totalWidth: 100,
      totalHeight: 40,
      columnWidths: [50, 50],
      rows: [
        {
          height: 20,
          cells: [cellMetrics(merged), cellMetrics(top)],
        },
        {
          height: 20,
          cells: [cellMetrics(sibling)],
        },
      ],
    };

    const info = buildTableRowBreakInfo(node, metrics);

    expect(info.breakOffsets[1]).toEqual([20]);
    expect(snapRowBreak(info, 1, 0, 16)).toBe(0);
    expect(snapRowBreak(info, 1, 0, 20)).toBe(20);
  });
});
