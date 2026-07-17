import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type {
  Page,
  ParagraphBlock,
  TableBlock,
  TableFragment,
  TableMetrics,
} from '../pagination-model/types';
import { paragraphLayout } from '../flow-model/metrics/paragraphLayout';
import { paintPage } from './paintPage';
import { renderHeaderFooterContent } from './paintPage/headerFooter';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function paintTrackedCellFloat(wrapType: 'square' | 'behind') {
  const paragraph: ParagraphBlock = {
    kind: 'paragraph',
    id: `cell-paragraph-${wrapType}`,
    runs: [
      {
        kind: 'image',
        src: 'data:image/png;base64,AA==',
        width: 40,
        height: 18,
        displayMode: 'float',
        wrapType,
        cssFloat: wrapType === 'square' ? 'left' : 'none',
        position: {
          horizontal: { relativeTo: 'column', posOffset: 0 },
          vertical: { relativeTo: 'paragraph', posOffset: 0 },
        },
        isInsertion: true,
        changeAuthor: 'Jane',
        changeDate: '2026-07-16T17:00:00Z',
        changeRevisionId: 91,
      },
    ],
  };
  const paragraphMetrics = paragraphLayout(paragraph, 106);
  const table: TableBlock = {
    kind: 'table',
    id: `table-${wrapType}`,
    rows: [
      {
        id: `row-${wrapType}`,
        cells: [
          {
            id: `cell-${wrapType}`,
            padding: { top: 3, right: 7, bottom: 1, left: 7 },
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
        height: 40,
        cells: [{ width: 120, height: 40, metrics: [paragraphMetrics] }],
      },
    ],
    columnWidths: [120],
    totalWidth: 120,
    totalHeight: 40,
  };
  const fragment: TableFragment = {
    kind: 'table',
    nodeId: table.id,
    x: 30,
    y: 50,
    width: 120,
    height: 40,
    fromRow: 0,
    toRow: 1,
  };
  const page: Page = {
    number: 1,
    size: { w: 240, h: 180 },
    margins: { top: 20, right: 30, bottom: 20, left: 30 },
    fragments: [fragment],
  };

  return paintPage(
    page,
    { pageNumber: 1, totalPages: 1, section: 'body' },
    {
      document,
      nodeLookup: new Map([[String(table.id), { node: table, metrics }]]),
    }
  );
}

function makeAlignedTrackedCellFloat(
  verticalAlign: 'center' | 'bottom',
  wrapType: 'square' | 'behind'
) {
  const paragraph: ParagraphBlock = {
    kind: 'paragraph',
    id: `aligned-cell-paragraph-${verticalAlign}-${wrapType}`,
    runs: [
      {
        kind: 'image',
        src: 'data:image/png;base64,AA==',
        width: 40,
        height: 18,
        displayMode: 'float',
        wrapType,
        cssFloat: wrapType === 'square' ? 'left' : 'none',
        position: {
          horizontal: { relativeTo: 'column', posOffset: 0 },
          vertical: { relativeTo: 'paragraph', posOffset: 10 * 9_525 },
        },
        isInsertion: true,
        changeAuthor: 'Jane',
        changeDate: '2026-07-16T17:00:00Z',
        changeRevisionId: 92,
      },
    ],
  };
  const paragraphMetrics = paragraphLayout(paragraph, 106);
  const table: TableBlock = {
    kind: 'table',
    id: `aligned-table-${verticalAlign}-${wrapType}`,
    rows: [
      {
        id: `aligned-row-${verticalAlign}-${wrapType}`,
        cells: [
          {
            id: `aligned-cell-${verticalAlign}-${wrapType}`,
            verticalAlign,
            padding: { top: 4, right: 7, bottom: 5, left: 7 },
            borders: {
              // Double borders are promoted to at least 3px by styleBorder.
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
        height: 60,
        // 18px painted content + 4px/5px vertical padding.
        cells: [{ width: 120, height: 27, metrics: [paragraphMetrics] }],
      },
    ],
    columnWidths: [120],
    totalWidth: 120,
    totalHeight: 60,
  };
  return { table, metrics };
}

function getBars(root: HTMLElement, revisionId: number) {
  return root.querySelectorAll<HTMLElement>(
    `.layout-revision-change-bar.layout-revision-ins[data-revision-id="${revisionId}"]`
  );
}

describe('tracked floating images in table cells', () => {
  for (const wrapType of ['square', 'behind'] as const) {
    test(`${wrapType} float registers one page-margin bar aligned to its visible bounds`, () => {
      const painted = paintTrackedCellFloat(wrapType);
      const image = painted.querySelector<HTMLElement>(
        '.layout-cell-floating-image.docx-insertion[data-revision-id="91"]'
      );
      const bars = painted.querySelectorAll<HTMLElement>(
        '.layout-page-content > .layout-revision-bars ' +
          '.layout-revision-change-bar.layout-revision-ins[data-revision-id="91"]'
      );

      expect(image).not.toBeNull();
      expect(image?.querySelector('img.docx-insertion[data-revision-id="91"]')).not.toBeNull();
      expect(bars).toHaveLength(1);
      // Page-content coordinates: table top (50 - 20 margin) + cell top (0)
      // + authored top padding (3) + cell-local float top (0).
      expect(bars[0]?.style.top).toBe('33px');
      expect(bars[0]?.style.height).toBe('18px');
      expect(bars[0]?.style.left).toBe('-10px');
    });
  }

  test('center-aligned bordered cell registers only its clipped front-float span', () => {
    const { table, metrics } = makeAlignedTrackedCellFloat('center', 'square');
    const page: Page = {
      number: 1,
      size: { w: 240, h: 180 },
      margins: { top: 20, right: 30, bottom: 20, left: 30 },
      fragments: [
        {
          kind: 'table',
          nodeId: table.id,
          x: 30,
          y: 50,
          width: 120,
          height: 60,
          fromRow: 0,
          toRow: 1,
        },
      ],
    };
    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      { document, nodeLookup: new Map([[String(table.id), { node: table, metrics }]]) }
    );
    const bars = getBars(painted, 92);
    const image = painted.querySelector<HTMLElement>('.layout-cell-floating-image');

    expect(image?.style.top).toBe('10px');
    expect(image?.querySelector('img')?.style.width).toBe('40px');
    expect(image?.querySelector('img')?.style.height).toBe('18px');
    expect(bars).toHaveLength(1);
    // Table top 30 + resolved content top 21 + image y 10; clipped at
    // content bottom 39, leaving 8px visible.
    expect(bars[0]?.style.top).toBe('61px');
    expect(bars[0]?.style.height).toBe('8px');
  });

  test('bottom-aligned bordered cell registers only its clipped behind-float span', () => {
    const { table, metrics } = makeAlignedTrackedCellFloat('bottom', 'behind');
    const page: Page = {
      number: 1,
      size: { w: 240, h: 180 },
      margins: { top: 20, right: 30, bottom: 20, left: 30 },
      fragments: [
        {
          kind: 'table',
          nodeId: table.id,
          x: 30,
          y: 50,
          width: 120,
          height: 60,
          fromRow: 0,
          toRow: 1,
        },
      ],
    };
    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      { document, nodeLookup: new Map([[String(table.id), { node: table, metrics }]]) }
    );
    const bars = getBars(painted, 92);
    const image = painted.querySelector<HTMLElement>('.layout-cell-floating-image');

    expect(image?.style.top).toBe('10px');
    expect(image?.querySelector('img')?.style.width).toBe('40px');
    expect(image?.querySelector('img')?.style.height).toBe('18px');
    expect(bars).toHaveLength(1);
    // Table top 30 + resolved content top 35 + image y 10; clipped at
    // content bottom 53, leaving 8px visible.
    expect(bars[0]?.style.top).toBe('75px');
    expect(bars[0]?.style.height).toBe('8px');
  });

  test('header table uses the same centered cell content-box geometry', () => {
    const { table, metrics } = makeAlignedTrackedCellFloat('center', 'square');
    const painted = renderHeaderFooterContent(
      { nodes: [table], metrics: [metrics], height: 60 },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 120 },
      { document },
      {
        flowTop: 20,
        flowLeft: 30,
        contentWidth: 120,
        pageWidth: 240,
        pageHeight: 180,
        margins: { top: 20, right: 30, bottom: 20, left: 30 },
      }
    );
    const bars = getBars(painted, 92);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe('31px');
    expect(bars[0]?.style.height).toBe('8px');
  });
});
