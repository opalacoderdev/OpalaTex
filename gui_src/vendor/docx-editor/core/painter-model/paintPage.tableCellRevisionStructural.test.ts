import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Page, ParagraphBlock, TableBlock, TableMetrics } from '../pagination-model/types';
import { paragraphLayout } from '../flow-model/metrics/paragraphLayout';
import { paintPage } from './paintPage';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const page: Page = {
  number: 1,
  size: { w: 240, h: 180 },
  margins: { top: 20, right: 30, bottom: 20, left: 30 },
  fragments: [],
};

function bars(root: HTMLElement, revisionId: number) {
  return root.querySelectorAll<HTMLElement>(
    `.layout-revision-change-bar.layout-revision-ins[data-revision-id="${revisionId}"]`
  );
}

describe('tracked structural revisions in table cells', () => {
  test('registers one clipped paragraph-boundary bar from a bottom-aligned bordered cell', () => {
    const paragraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'tracked-cell-paragraph',
      attrs: {
        pPrIns: {
          revisionId: 111,
          author: 'Jane',
          date: '2026-07-16T19:00:00Z',
        },
      },
      runs: [{ kind: 'text', text: 'Tracked boundary' }],
    };
    const paragraphMetrics = paragraphLayout(paragraph, 106);
    const table: TableBlock = {
      kind: 'table',
      id: 'tracked-cell-paragraph-table',
      rows: [
        {
          id: 'tracked-cell-paragraph-row',
          cells: [
            {
              id: 'tracked-cell-paragraph-cell',
              verticalAlign: 'bottom',
              padding: { top: 4, right: 7, bottom: 5, left: 7 },
              borders: {
                top: { style: 'double', width: 1, color: '#000000' },
                bottom: { style: 'solid', width: 2, color: '#000000' },
              },
              nodes: [paragraph],
            },
          ],
        },
      ],
    };
    const metrics: TableMetrics = {
      kind: 'table',
      rows: [
        {
          height: 45,
          cells: [
            {
              width: 120,
              height: paragraphMetrics.totalHeight + 9,
              metrics: [paragraphMetrics],
            },
          ],
        },
      ],
      columnWidths: [120],
      totalWidth: 120,
      totalHeight: 45,
    };
    const contentTop = 38 - paragraphMetrics.totalHeight;
    const painted = paintPage(
      {
        ...page,
        fragments: [
          {
            kind: 'table',
            nodeId: table.id,
            x: 30,
            y: 50,
            width: 120,
            height: 30,
            fromRow: 0,
            toRow: 1,
            bottomClip: 30,
          },
        ],
      },
      { pageNumber: 1, totalPages: 1, section: 'body' },
      { document, nodeLookup: new Map([[String(table.id), { node: table, metrics }]]) }
    );
    const revisionBars = bars(painted, 111);

    expect(
      painted.querySelector(
        '.layout-table-cell .layout-revision-pmark.layout-revision-ins[data-revision-id="111"]'
      )
    ).not.toBeNull();
    expect(revisionBars).toHaveLength(1);
    expect(revisionBars[0]?.style.top).toBe(`${30 + contentTop}px`);
    expect(revisionBars[0]?.style.height).toBe(`${30 - contentTop}px`);
  });

  test('registers nested whole-table and tracked-row spans once in outer-page coordinates', () => {
    const wholeRevision = {
      revisionId: 201,
      author: 'Jane',
      date: '2026-07-16T19:00:00Z',
    };
    const rowRevision = {
      revisionId: 202,
      author: 'Jane',
      date: '2026-07-16T19:01:00Z',
    };
    const wholeTable: TableBlock = {
      kind: 'table',
      id: 'nested-whole-tracked-table',
      rows: [{ id: 'nested-whole-row', trackedIns: wholeRevision, cells: [] }],
    };
    const wholeMetrics: TableMetrics = {
      kind: 'table',
      rows: [{ height: 12, cells: [] }],
      columnWidths: [106],
      totalWidth: 106,
      totalHeight: 12,
    };
    const rowTable: TableBlock = {
      kind: 'table',
      id: 'nested-row-tracked-table',
      rows: [
        { id: 'nested-untracked-row', cells: [] },
        { id: 'nested-tracked-row', trackedIns: rowRevision, cells: [] },
      ],
    };
    const rowMetrics: TableMetrics = {
      kind: 'table',
      rows: [
        { height: 10, cells: [] },
        { height: 14, cells: [] },
      ],
      columnWidths: [106],
      totalWidth: 106,
      totalHeight: 24,
    };
    const outerTable: TableBlock = {
      kind: 'table',
      id: 'outer-structural-table',
      rows: [
        {
          id: 'outer-structural-row',
          cells: [
            {
              id: 'outer-structural-cell',
              padding: { top: 3, right: 7, bottom: 1, left: 7 },
              nodes: [wholeTable, rowTable],
            },
          ],
        },
      ],
    };
    const outerMetrics: TableMetrics = {
      kind: 'table',
      rows: [
        {
          height: 40,
          cells: [
            {
              width: 120,
              height: 40,
              metrics: [wholeMetrics, rowMetrics],
            },
          ],
        },
      ],
      columnWidths: [120],
      totalWidth: 120,
      totalHeight: 40,
    };
    const painted = paintPage(
      {
        ...page,
        fragments: [
          {
            kind: 'table',
            nodeId: outerTable.id,
            x: 30,
            y: 50,
            width: 120,
            height: 40,
            fromRow: 0,
            toRow: 1,
          },
        ],
      },
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        nodeLookup: new Map([[String(outerTable.id), { node: outerTable, metrics: outerMetrics }]]),
      }
    );
    const wholeBars = bars(painted, 201);
    const rowBars = bars(painted, 202);

    expect(
      painted.querySelector(
        '.layout-nested-table.ep-revision-table.ep-revision-ins[data-revision-id="201"]'
      )
    ).not.toBeNull();
    expect(
      painted.querySelector(
        '.layout-nested-table .layout-table-row.ep-revision-row.ep-revision-ins' +
          '[data-revision-id="202"]'
      )
    ).not.toBeNull();
    expect(wholeBars).toHaveLength(1);
    expect(wholeBars[0]?.style.top).toBe('33px');
    expect(wholeBars[0]?.style.height).toBe('12px');
    expect(rowBars).toHaveLength(1);
    expect(rowBars[0]?.style.top).toBe('55px');
    expect(rowBars[0]?.style.height).toBe('14px');
  });
});
