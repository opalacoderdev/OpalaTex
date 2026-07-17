import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type {
  Page,
  ParagraphBlock,
  ParagraphFragment,
  TableBlock,
  TableMetrics,
} from '../pagination-model/types';
import { paragraphLayout } from '../flow-model/metrics/paragraphLayout';
import type { ImageRun } from '../pagination-model/types';
import { getImagePaintGeometry } from '../utils/imagePaintGeometry';
import { paintPage } from './paintPage';
import { renderHeaderFooterContent } from './paintPage/headerFooter';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function trackedImageParagraph(
  displayMode: 'inline' | 'block' = 'inline',
  wrapType?: 'topAndBottom',
  options?: {
    transform?: string;
    isDeletion?: boolean;
  }
): ParagraphBlock {
  return {
    kind: 'paragraph',
    id: `tracked-${wrapType ?? displayMode}-paragraph`,
    runs: [
      {
        kind: 'image',
        src: 'data:image/png;base64,AA==',
        width: 40,
        height: 18,
        displayMode,
        wrapType,
        transform: options?.transform,
        isInsertion: !options?.isDeletion,
        isDeletion: options?.isDeletion ?? false,
        changeAuthor: 'Jane',
        changeDate: '2026-07-16T18:00:00Z',
        changeRevisionId: 101,
      },
    ],
  };
}

function expectedImageSpan(paragraph: ParagraphBlock, width: number) {
  const metrics = paragraphLayout(paragraph, width);
  const line = metrics.lines[0]!;
  const top = Math.max(0, (line.lineHeight - 18) / 2);
  return {
    metrics,
    top,
    height: Math.min(18, line.lineHeight - top),
  };
}

function expectedRotatedInlineBarSpan(paragraph: ParagraphBlock, width: number) {
  const metrics = paragraphLayout(paragraph, width);
  const line = metrics.lines[0]!;
  const runIndex = paragraph.runs.findIndex((run) => run.kind === 'image');
  const run = paragraph.runs[runIndex] as ImageRun;
  const geometry = getImagePaintGeometry(run, {
    paintedWidth: line.atomAdvances?.[runIndex] ?? run.width,
  });
  const imageOnly = paragraph.runs.length === 1 && run.kind === 'image';
  const imageTop = imageOnly
    ? (line.lineHeight - geometry.boxHeight - geometry.marginTop - geometry.marginBottom) / 2 +
      geometry.marginTop
    : line.lineHeight - geometry.marginBottom - geometry.boxHeight;
  const visibleTop = Math.max(0, imageTop);
  const visibleBottom = Math.min(line.lineHeight, imageTop + geometry.boxHeight);
  return {
    metrics,
    top: visibleTop,
    height: Math.max(0, visibleBottom - visibleTop),
  };
}

function revisionBars(root: HTMLElement) {
  return root.querySelectorAll<HTMLElement>(
    '.layout-revision-change-bar.layout-revision-ins[data-revision-id="101"]'
  );
}

describe('tracked inline image revision bars', () => {
  test('body inline image registers its measured visible image span once', () => {
    const paragraph = trackedImageParagraph();
    const { metrics, top, height } = expectedImageSpan(paragraph, 180);
    const fragment: ParagraphFragment = {
      kind: 'paragraph',
      nodeId: paragraph.id,
      x: 30,
      y: 50,
      width: 180,
      height: metrics.lines[0]!.lineHeight,
      fromLine: 0,
      toLine: 1,
    };
    const page: Page = {
      number: 1,
      size: { w: 240, h: 180 },
      margins: { top: 20, right: 30, bottom: 20, left: 30 },
      fragments: [fragment],
    };

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        nodeLookup: new Map([[String(paragraph.id), { node: paragraph, metrics }]]),
      }
    );
    const bars = revisionBars(painted);

    expect(painted.querySelector('img.layout-run-image.docx-insertion')).not.toBeNull();
    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe(`${30 + top}px`);
    expect(bars[0]?.style.height).toBe(`${height}px`);
  });

  test('rotated body inline image keeps revision metadata on a single semantic wrapper', () => {
    const paragraph = trackedImageParagraph('inline', undefined, { transform: 'rotate(90deg)' });
    const { metrics, top, height } = expectedRotatedInlineBarSpan(paragraph, 180);
    const fragment: ParagraphFragment = {
      kind: 'paragraph',
      nodeId: paragraph.id,
      x: 30,
      y: 50,
      width: 180,
      height: metrics.lines[0]!.lineHeight,
      fromLine: 0,
      toLine: 1,
    };
    const page: Page = {
      number: 1,
      size: { w: 240, h: 180 },
      margins: { top: 20, right: 30, bottom: 20, left: 30 },
      fragments: [fragment],
    };

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        nodeLookup: new Map([[String(paragraph.id), { node: paragraph, metrics }]]),
      }
    );
    const wrapper = painted.querySelector<HTMLElement>(
      '.layout-run-image-wrapper.docx-insertion[data-revision-id="101"]'
    );
    const img = wrapper?.querySelector<HTMLImageElement>('img.layout-run-image');

    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.width).toBe('18px');
    expect(wrapper?.style.height).toBe('40px');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('data-revision-id')).toBeNull();
    expect(img?.classList.contains('docx-insertion')).toBe(false);
    const bars = revisionBars(painted);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe(`${30 + top}px`);
    expect(bars[0]?.style.height).toBe(`${height}px`);
  });

  test('table-cell inline image registers in the owning page coordinates once', () => {
    const paragraph = trackedImageParagraph();
    const { metrics: paragraphMetrics, top, height } = expectedImageSpan(paragraph, 106);
    const table: TableBlock = {
      kind: 'table',
      id: 'inline-image-table',
      rows: [
        {
          id: 'inline-image-row',
          cells: [
            {
              id: 'inline-image-cell',
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
          cells: [
            {
              width: 120,
              height: paragraphMetrics.totalHeight + 4,
              metrics: [paragraphMetrics],
            },
          ],
        },
      ],
      columnWidths: [120],
      totalWidth: 120,
      totalHeight: 40,
    };
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
          height: 40,
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
    const bars = revisionBars(painted);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe(`${33 + top}px`);
    expect(bars[0]?.style.height).toBe(`${height}px`);
  });

  test('header inline image registers its measured visible image span once', () => {
    const paragraph = trackedImageParagraph();
    const { metrics, top, height } = expectedImageSpan(paragraph, 180);

    const painted = renderHeaderFooterContent(
      { nodes: [paragraph], metrics: [metrics], height: metrics.totalHeight },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 180 },
      { document },
      {
        flowTop: 20,
        flowLeft: 30,
        contentWidth: 180,
        pageWidth: 240,
        pageHeight: 180,
        margins: { top: 20, right: 30, bottom: 20, left: 30 },
      }
    );
    const bars = revisionBars(painted);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe(`${top}px`);
    expect(bars[0]?.style.height).toBe(`${height}px`);
  });
});

describe('tracked paragraph block-image cues', () => {
  test('body block run applies inner metadata and registers its image bar once', () => {
    const paragraph = trackedImageParagraph('block');
    const { metrics, top, height } = expectedImageSpan(paragraph, 180);
    const page: Page = {
      number: 1,
      size: { w: 240, h: 180 },
      margins: { top: 20, right: 30, bottom: 20, left: 30 },
      fragments: [
        {
          kind: 'paragraph',
          nodeId: paragraph.id,
          x: 30,
          y: 50,
          width: 180,
          height: metrics.totalHeight,
          fromLine: 0,
          toLine: metrics.lines.length,
        },
      ],
    };

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        nodeLookup: new Map([[String(paragraph.id), { node: paragraph, metrics }]]),
      }
    );
    const wrapper = painted.querySelector<HTMLElement>(
      '.layout-block-image.docx-insertion[data-revision-id="101"]'
    );
    const bars = revisionBars(painted);

    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('img.docx-insertion[data-revision-id="101"]')).not.toBeNull();
    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe(`${30 + top}px`);
    expect(bars[0]?.style.height).toBe(`${height}px`);
  });

  test('table-cell topAndBottom run registers its clipped image bar once', () => {
    const paragraph = trackedImageParagraph('inline', 'topAndBottom');
    const { metrics: paragraphMetrics, top, height } = expectedImageSpan(paragraph, 106);
    const table: TableBlock = {
      kind: 'table',
      id: 'top-and-bottom-image-table',
      rows: [
        {
          id: 'top-and-bottom-image-row',
          cells: [
            {
              id: 'top-and-bottom-image-cell',
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
          cells: [
            {
              width: 120,
              height: paragraphMetrics.totalHeight + 4,
              metrics: [paragraphMetrics],
            },
          ],
        },
      ],
      columnWidths: [120],
      totalWidth: 120,
      totalHeight: 40,
    };
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
          height: 40,
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
    const bars = revisionBars(painted);

    expect(painted.querySelector('.layout-block-image.docx-insertion')).not.toBeNull();
    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe(`${33 + top}px`);
    expect(bars[0]?.style.height).toBe(`${height}px`);
  });

  test('footer block run registers through the shared header/footer painter', () => {
    const paragraph = trackedImageParagraph('block');
    const { metrics, top, height } = expectedImageSpan(paragraph, 180);

    const painted = renderHeaderFooterContent(
      { nodes: [paragraph], metrics: [metrics], height: metrics.totalHeight },
      { pageNumber: 1, totalPages: 1, section: 'footer', contentWidth: 180 },
      { document },
      {
        flowTop: 140,
        flowLeft: 30,
        contentWidth: 180,
        pageWidth: 240,
        pageHeight: 180,
        margins: { top: 20, right: 30, bottom: 20, left: 30 },
      }
    );
    const bars = revisionBars(painted);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.top).toBe(`${top}px`);
    expect(bars[0]?.style.height).toBe(`${height}px`);
  });
});

describe('tracked images in nested tables', () => {
  test('registers inline and clipped topAndBottom image bars once in outer-page coordinates', () => {
    const inlineParagraph = trackedImageParagraph();
    const topAndBottomParagraph = trackedImageParagraph('inline', 'topAndBottom');
    const topAndBottomRun = topAndBottomParagraph.runs[0];
    if (topAndBottomRun?.kind === 'image') {
      topAndBottomRun.changeRevisionId = 102;
    }
    const inlineSpan = expectedImageSpan(inlineParagraph, 92);
    const topAndBottomSpan = expectedImageSpan(topAndBottomParagraph, 92);

    const nestedTable: TableBlock = {
      kind: 'table',
      id: 'nested-image-table',
      rows: [
        {
          id: 'nested-image-row',
          cells: [
            {
              id: 'nested-image-cell',
              padding: { top: 2, right: 7, bottom: 1, left: 7 },
              nodes: [inlineParagraph, topAndBottomParagraph],
            },
          ],
        },
      ],
    };
    const nestedHeight =
      2 + inlineSpan.metrics.totalHeight + topAndBottomSpan.metrics.totalHeight + 1;
    const nestedMetrics: TableMetrics = {
      kind: 'table',
      rows: [
        {
          height: nestedHeight,
          cells: [
            {
              width: 106,
              height: nestedHeight,
              metrics: [inlineSpan.metrics, topAndBottomSpan.metrics],
            },
          ],
        },
      ],
      columnWidths: [106],
      totalWidth: 106,
      totalHeight: nestedHeight,
    };
    const outerTable: TableBlock = {
      kind: 'table',
      id: 'outer-image-table',
      rows: [
        {
          id: 'outer-image-row',
          cells: [
            {
              id: 'outer-image-cell',
              padding: { top: 3, right: 7, bottom: 1, left: 7 },
              nodes: [nestedTable],
            },
          ],
        },
      ],
    };
    const outerMetrics: TableMetrics = {
      kind: 'table',
      rows: [
        {
          // Clip the second nested image after 8 visible pixels; the outer
          // cell's 1px bottom padding ends content before the row edge.
          height: 32,
          cells: [
            {
              width: 120,
              height: nestedHeight + 4,
              metrics: [nestedMetrics],
            },
          ],
        },
      ],
      columnWidths: [120],
      totalWidth: 120,
      totalHeight: 32,
    };
    const page: Page = {
      number: 1,
      size: { w: 240, h: 180 },
      margins: { top: 20, right: 30, bottom: 20, left: 30 },
      fragments: [
        {
          kind: 'table',
          nodeId: outerTable.id,
          x: 30,
          y: 50,
          width: 120,
          height: 32,
          fromRow: 0,
          toRow: 1,
        },
      ],
    };

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        nodeLookup: new Map([[String(outerTable.id), { node: outerTable, metrics: outerMetrics }]]),
      }
    );
    const nestedImages = painted.querySelectorAll<HTMLImageElement>('.layout-nested-table img');
    const inlineBars = painted.querySelectorAll<HTMLElement>(
      '.layout-revision-change-bar[data-revision-id="101"]'
    );
    const topAndBottomBars = painted.querySelectorAll<HTMLElement>(
      '.layout-revision-change-bar[data-revision-id="102"]'
    );

    expect(nestedImages).toHaveLength(2);
    expect(nestedImages[0]?.width).toBe(40);
    expect(nestedImages[0]?.height).toBe(18);
    expect(nestedImages[1]?.width).toBe(40);
    expect(nestedImages[1]?.height).toBe(18);
    expect(inlineBars).toHaveLength(1);
    expect(inlineBars[0]?.style.top).toBe(`${35 + inlineSpan.top}px`);
    expect(inlineBars[0]?.style.height).toBe(`${inlineSpan.height}px`);
    expect(topAndBottomBars).toHaveLength(1);
    expect(topAndBottomBars[0]?.style.top).toBe(
      `${35 + inlineSpan.metrics.totalHeight + topAndBottomSpan.top}px`
    );
    expect(topAndBottomBars[0]?.style.height).toBe('8px');
  });
});
