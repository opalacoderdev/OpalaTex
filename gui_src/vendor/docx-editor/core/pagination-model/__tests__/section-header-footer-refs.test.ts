import { describe, expect, test } from 'bun:test';
import { layOutPages } from '../index';
import {
  selectHeaderFooterRefForPage,
  type ContentNode,
  type LayoutMetrics,
  type PageHeaderFooterRefs,
} from '../types';

const REFS_A: PageHeaderFooterRefs = {
  headerDefault: 'rIdHeaderA',
  headerFirst: 'rIdHeaderFirstA',
  footerDefault: 'rIdFooterA',
  titlePg: true,
};

const REFS_B: PageHeaderFooterRefs = {
  headerDefault: 'rIdHeaderB',
  headerEven: 'rIdHeaderEvenB',
  footerDefault: 'rIdFooterB',
};

function paragraph(id: string, height = 100): { block: ContentNode; measure: LayoutMetrics } {
  return {
    block: { kind: 'paragraph', id, runs: [{ kind: 'text', text: id }] },
    measure: { kind: 'paragraph', lines: [], totalHeight: height },
  };
}

describe('section header/footer refs', () => {
  test('stamps pages with the active section refs', () => {
    const first = paragraph('first');
    const second = paragraph('second');
    const blocks: ContentNode[] = [
      first.block,
      {
        kind: 'sectionBreak',
        id: 'section-a',
        type: 'nextPage',
        margins: { top: 96, right: 96, bottom: 96, left: 96 },
        headerFooterRefs: REFS_A,
      },
      second.block,
    ];
    const measures: LayoutMetrics[] = [first.measure, { kind: 'sectionBreak' }, second.measure];

    const layout = layOutPages(blocks, measures, {
      pageSize: { w: 600, h: 400 },
      margins: { top: 96, right: 96, bottom: 96, left: 96 },
      finalMargins: { top: 96, right: 96, bottom: 96, left: 96 },
      finalHeaderFooterRefs: REFS_B,
    });

    expect(layout.pages[0].headerFooterRefs).toEqual(REFS_A);
    expect(layout.pages[1].headerFooterRefs).toEqual(REFS_B);
  });

  test('selects first, even, and default refs like Word', () => {
    expect(
      selectHeaderFooterRefForPage(REFS_A, 'header', {
        isFirstOfSection: true,
        isEvenPage: false,
        evenAndOddHeaders: false,
      })
    ).toBe('rIdHeaderFirstA');

    expect(
      selectHeaderFooterRefForPage(REFS_B, 'header', {
        isFirstOfSection: false,
        isEvenPage: true,
        evenAndOddHeaders: true,
      })
    ).toBe('rIdHeaderEvenB');

    expect(
      selectHeaderFooterRefForPage(REFS_B, 'footer', {
        isFirstOfSection: false,
        isEvenPage: false,
        evenAndOddHeaders: true,
      })
    ).toBe('rIdFooterB');
  });
});
