import { describe, expect, test } from 'bun:test';
import { layOutPages } from '../index';
import type { ContentNode, LayoutMetrics, ParagraphBlock, ParagraphMetrics } from '../types';

function para(
  id: string,
  before: number,
  explicitBefore = false
): { block: ParagraphBlock; measure: ParagraphMetrics } {
  return {
    block: {
      kind: 'paragraph',
      id,
      runs: [{ kind: 'text', text: id }],
      attrs: {
        spacing: { before },
        ...(explicitBefore ? { spacingOverrides: { before: true } } : {}),
      },
    },
    measure: {
      kind: 'paragraph',
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: id.length,
          width: 20,
          ascent: 8,
          descent: 2,
          lineHeight: 10,
        },
      ],
      totalHeight: 10,
    },
  };
}

describe('page-top paragraph spacing', () => {
  test('preserves inherited space-before on the first document paragraph', () => {
    const first = para('first', 24);
    const second = para('second', 24);
    const blocks: ContentNode[] = [first.block, { kind: 'pageBreak', id: 'pb' }, second.block];
    const measures: LayoutMetrics[] = [first.measure, { kind: 'pageBreak' }, second.measure];

    const layout = layOutPages(blocks, measures, {
      pageSize: { w: 200, h: 200 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 200, h: 200 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(layout.pages[0].fragments[0].y).toBe(74);
    expect(layout.pages[1].fragments[0].y).toBe(50);
  });

  test('preserves direct space-before after a standalone hard page break', () => {
    const first = para('first', 24);
    const second = para('second', 24, true);
    const blocks: ContentNode[] = [first.block, { kind: 'pageBreak', id: 'pb' }, second.block];
    const measures: LayoutMetrics[] = [first.measure, { kind: 'pageBreak' }, second.measure];

    const layout = layOutPages(blocks, measures, {
      pageSize: { w: 200, h: 200 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 200, h: 200 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(layout.pages[1].fragments[0].y).toBe(74);
  });

  test('preserves inherited space-before after a next-page section break', () => {
    const first = para('first', 24);
    const heading = para('heading', 32);
    const blocks: ContentNode[] = [
      first.block,
      { kind: 'sectionBreak', id: 'sb', type: 'nextPage' },
      heading.block,
    ];
    const measures: LayoutMetrics[] = [first.measure, { kind: 'sectionBreak' }, heading.measure];

    const layout = layOutPages(blocks, measures, {
      pageSize: { w: 200, h: 200 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 200, h: 200 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(layout.pages[1].fragments[0].y).toBe(82);
  });

  test('preserves inherited space-before on pageBreakBefore paragraphs', () => {
    const first = para('first', 24);
    const heading = para('heading', 32);
    heading.block.attrs = {
      ...heading.block.attrs,
      pageBreakBefore: true,
    };
    const blocks: ContentNode[] = [first.block, heading.block];
    const measures: LayoutMetrics[] = [first.measure, heading.measure];

    const layout = layOutPages(blocks, measures, {
      pageSize: { w: 200, h: 200 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 200, h: 200 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(layout.pages[1].fragments[0].y).toBe(82);
  });
});
