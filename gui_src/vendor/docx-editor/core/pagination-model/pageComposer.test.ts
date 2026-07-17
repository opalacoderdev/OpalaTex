import { describe, expect, test } from 'bun:test';

import { layOutPages } from './pageComposer';
import type {
  MeasuredLine,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMetrics,
  SectionMarkerBlock,
} from './types';

function paragraph(id: string, lineCount = 1, attrs: ParagraphBlock['attrs'] = {}): ParagraphBlock {
  return {
    kind: 'paragraph',
    id,
    attrs,
    runs: [{ kind: 'text', text: 'x'.repeat(lineCount) }],
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

function fragmentsFor(widowControl?: boolean): ParagraphFragment[] {
  const targetAttrs = widowControl === undefined ? {} : { widowControl };
  const nodes = [paragraph('filler'), paragraph('target', 4, targetAttrs)];
  const metrics = [paragraphMetrics(50), paragraphMetrics(10, 10, 10, 10)];
  const layout = layOutPages(nodes, metrics, {
    pageSize: { w: 100, h: 100 },
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
  });

  return layout.pages
    .flatMap((page) => page.fragments)
    .filter(
      (fragment): fragment is ParagraphFragment =>
        fragment.kind === 'paragraph' && fragment.nodeId === 'target'
    );
}

describe('paragraph widow control', () => {
  test('undefined uses Word default and avoids a single next-page line', () => {
    const fragments = fragmentsFor();
    expect(fragments.map(({ fromLine, toLine }) => [fromLine, toLine])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  test('explicit false permits the natural 3+1 split', () => {
    const fragments = fragmentsFor(false);
    expect(fragments.map(({ fromLine, toLine }) => [fromLine, toLine])).toEqual([
      [0, 3],
      [3, 4],
    ]);
  });
});

describe('keepLines leading-gap fit', () => {
  const config = {
    pageSize: { w: 100, h: 100 },
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
  };

  test('moves the whole paragraph when lines fit but the collapsed gap does not', () => {
    const nodes = [
      paragraph('previous', 1, { spacing: { after: 10 }, widowControl: false }),
      paragraph('kept', 3, {
        keepLines: true,
        widowControl: false,
        spacing: { before: 20 },
      }),
    ];

    const layout = layOutPages(nodes, [paragraphMetrics(70), paragraphMetrics(10, 10, 10)], config);

    expect(layout.pages).toHaveLength(2);
    expect(layout.pages[0].fragments.map((fragment) => fragment.nodeId)).toEqual(['previous']);
    expect(layout.pages[1].fragments).toHaveLength(1);
    expect(layout.pages[1].fragments[0]).toMatchObject({
      nodeId: 'kept',
      y: 20,
      height: 30,
      fromLine: 0,
      toLine: 3,
    });
  });

  test('keeps the paragraph on the current page at an exact gap-inclusive fit', () => {
    const nodes = [
      paragraph('previous', 1, { spacing: { after: 10 }, widowControl: false }),
      paragraph('kept', 3, {
        keepLines: true,
        widowControl: false,
        spacing: { before: 20 },
      }),
    ];

    const layout = layOutPages(nodes, [paragraphMetrics(50), paragraphMetrics(10, 10, 10)], config);

    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0].fragments[1]).toMatchObject({
      nodeId: 'kept',
      y: 70,
      height: 30,
      fromLine: 0,
      toLine: 3,
    });
  });
});

describe('odd/even section starts', () => {
  test('attributes parity filler pages to the section they close', () => {
    const oldMargins = { top: 10, right: 10, bottom: 10, left: 10 };
    const newMargins = { top: 20, right: 20, bottom: 20, left: 20 };
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'section-break',
      pageSize: { w: 100, h: 100 },
      margins: oldMargins,
    };
    const pageStarts: Array<{
      pageNumber: number;
      sectionIndex: number;
      sectionPageNumber: number;
    }> = [];
    const config = {
      pageSize: { w: 100, h: 100 },
      margins: oldMargins,
      finalPageSize: { w: 120, h: 120 },
      finalMargins: newMargins,
      bodyBreakType: 'oddPage' as const,
      onPageStart: ({
        pageNumber,
        sectionIndex,
        sectionPageNumber,
      }: {
        pageNumber: number;
        sectionIndex: number;
        sectionPageNumber: number;
      }) => pageStarts.push({ pageNumber, sectionIndex, sectionPageNumber }),
    };

    const layout = layOutPages(
      [paragraph('old-section'), sectionBreak, paragraph('new-section')],
      [paragraphMetrics(20), { kind: 'sectionBreak' }, paragraphMetrics(20)],
      config
    );

    expect(pageStarts).toEqual([
      { pageNumber: 1, sectionIndex: 0, sectionPageNumber: 1 },
      { pageNumber: 2, sectionIndex: 0, sectionPageNumber: 2 },
      { pageNumber: 3, sectionIndex: 1, sectionPageNumber: 1 },
    ]);
    expect(layout.pages.map((page) => page.size.w)).toEqual([100, 100, 120]);
    expect(layout.pages.map((page) => page.margins.left)).toEqual([10, 10, 20]);
    expect(layout.pages[1].fragments).toHaveLength(0);
    expect(layout.pages[2].fragments.map((fragment) => fragment.nodeId)).toEqual(['new-section']);
  });
});
