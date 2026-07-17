import { describe, expect, test } from 'bun:test';
import type { TableBlock, TableFragment, TableMetrics } from '../pagination-model/types';
import { getTableRevisionBarSpans } from './renderTableRevisionBars';

const insertion = {
  revisionId: 77,
  author: 'Jane',
  date: '2026-07-16T17:00:00Z',
};

function tableWithTrackedRows(trackedRows: number[]): TableBlock {
  return {
    kind: 'table',
    id: 'tracked-table',
    rows: [0, 1].map((rowIndex) => ({
      id: `row-${rowIndex}`,
      cells: [],
      ...(trackedRows.includes(rowIndex) ? { trackedIns: insertion } : {}),
    })),
  };
}

const metrics: TableMetrics = {
  kind: 'table',
  rows: [
    { height: 20, cells: [] },
    { height: 100, cells: [] },
  ],
  columnWidths: [100],
  totalWidth: 100,
  totalHeight: 120,
};

const continuationFragment: TableFragment = {
  kind: 'table',
  nodeId: 'tracked-table',
  x: 0,
  y: 0,
  width: 100,
  // 20px repeated header + 40px visible slice of the second row.
  height: 60,
  fromRow: 1,
  toRow: 2,
  headerRowCount: 1,
  topClip: 10,
  bottomClip: 50,
  continuesFromPrev: true,
  continuesOnNext: true,
};

describe('getTableRevisionBarSpans', () => {
  test('whole-table bar equals repeated-header continuation fragment bounds', () => {
    const spans = getTableRevisionBarSpans(
      continuationFragment,
      tableWithTrackedRows([0, 1]),
      metrics,
      25
    );

    expect(spans).toEqual([
      {
        top: 25,
        height: 60,
        kind: 'ins',
        revisionId: 77,
        author: 'Jane',
        date: '2026-07-16T17:00:00Z',
      },
    ]);
  });

  test('partial tracked row is clipped to the body window below the repeated header', () => {
    const spans = getTableRevisionBarSpans(
      continuationFragment,
      tableWithTrackedRows([1]),
      metrics,
      25
    );

    expect(spans).toEqual([
      {
        top: 45,
        height: 40,
        kind: 'ins',
        revisionId: 77,
        author: 'Jane',
        date: '2026-07-16T17:00:00Z',
      },
    ]);
  });
});
