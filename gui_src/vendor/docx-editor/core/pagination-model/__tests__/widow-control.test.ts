import { describe, expect, test } from 'bun:test';
import { layOutPages } from '../pageComposer';
import type { ContentNode, LayoutMetrics, ParagraphBlock, ParagraphMetrics } from '../types';

function paragraph(
  id: string,
  lineHeights: number[],
  attrs: ParagraphBlock['attrs'] = {}
): { block: ParagraphBlock; measure: ParagraphMetrics } {
  return {
    block: {
      kind: 'paragraph',
      id,
      runs: [{ kind: 'text', text: id }],
      attrs,
    },
    measure: {
      kind: 'paragraph',
      lines: lineHeights.map((lineHeight, index) => ({
        fromRun: 0,
        fromChar: index,
        toRun: 0,
        toChar: index + 1,
        width: 10,
        ascent: 8,
        descent: 2,
        lineHeight,
      })),
      totalHeight: lineHeights.reduce((sum, height) => sum + height, 0),
    },
  };
}

function layout(
  entries: ReturnType<typeof paragraph>[],
  options: { columns?: number; height?: number } = {}
) {
  const nodes: ContentNode[] = entries.map((entry) => entry.block);
  const metrics: LayoutMetrics[] = entries.map((entry) => entry.measure);
  return layOutPages(nodes, metrics, {
    pageSize: { w: 300, h: options.height ?? 140 },
    margins: { top: 20, right: 20, bottom: 20, left: 20 },
    columns: options.columns ? { count: options.columns, gap: 20 } : undefined,
  });
}

function ranges(result: ReturnType<typeof layout>, id: string) {
  return result.pages.flatMap((page) =>
    page.fragments
      .filter((fragment) => fragment.kind === 'paragraph' && fragment.nodeId === id)
      .map((fragment) => ({
        page: page.number,
        x: fragment.x,
        from: fragment.kind === 'paragraph' ? fragment.fromLine : -1,
        to: fragment.kind === 'paragraph' ? fragment.toLine : -1,
      }))
  );
}

describe('Word-compatible widow/orphan control', () => {
  test('keeps two- and three-line paragraphs whole when they fit a fresh region', () => {
    const two = layout([paragraph('0', [90]), paragraph('1', [10, 10])]);
    expect(ranges(two, '1')).toEqual([{ page: 2, x: 20, from: 0, to: 2 }]);

    const three = layout([paragraph('0', [80]), paragraph('1', [10, 10, 10])]);
    expect(ranges(three, '1')).toEqual([{ page: 2, x: 20, from: 0, to: 3 }]);
  });

  test('requires two lines on both sides of a four-plus-line split', () => {
    const result = layout([paragraph('0', [70]), paragraph('1', [10, 10, 10, 10, 10])]);
    expect(ranges(result, '1').map(({ from, to }) => [from, to])).toEqual([
      [0, 3],
      [3, 5],
    ]);
  });

  test('explicit false allows a one-line fragment', () => {
    const result = layout([
      paragraph('0', [90]),
      paragraph('1', [10, 10, 10, 10], { widowControl: false }),
    ]);
    expect(ranges(result, '1').map(({ from, to }) => [from, to])).toEqual([
      [0, 1],
      [1, 4],
    ]);
  });

  test('advances to the next column before creating a page', () => {
    const result = layout([paragraph('0', [90]), paragraph('1', [10, 10, 10, 10])], { columns: 2 });
    const fragments = ranges(result, '1');
    expect(result.pages).toHaveLength(1);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].x).toBeGreaterThan(20);
    expect([fragments[0].from, fragments[0].to]).toEqual([0, 4]);
  });

  test('oversized lines overflow without looping', () => {
    const result = layout([paragraph('1', [120, 120, 120, 120])], { height: 100 });
    expect(ranges(result, '1')).toHaveLength(4);
    expect(result.pages.length).toBeLessThanOrEqual(4);
  });

  test('keepLines supersedes widow control when the paragraph fits fresh', () => {
    const result = layout([
      paragraph('0', [70]),
      paragraph('1', [10, 10, 10, 10], { keepLines: true, widowControl: false }),
    ]);
    expect(ranges(result, '1')).toEqual([{ page: 2, x: 20, from: 0, to: 4 }]);
  });

  test('visits long-paragraph line heights linearly', () => {
    let lineHeightReads = 0;
    const lineCount = 200;
    const entry = paragraph('1', new Array(lineCount).fill(10));
    for (const line of entry.measure.lines) {
      Object.defineProperty(line, 'lineHeight', {
        configurable: true,
        get() {
          lineHeightReads++;
          return 10;
        },
      });
    }

    const result = layout([entry]);
    expect(ranges(result, '1').at(-1)?.to).toBe(lineCount);
    // Composer walks lines for fit counting; allow a small constant factor.
    expect(lineHeightReads).toBeLessThanOrEqual(lineCount * 6);
  });
});
