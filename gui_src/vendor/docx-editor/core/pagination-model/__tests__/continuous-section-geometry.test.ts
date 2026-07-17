/** ECMA-376 §17.6.22: a `continuous` section break does not force a page,
 *  but the next page (when one is naturally created) must use the new
 *  section's geometry. The previous version skipped `updatePageLayout`
 *  for `continuous` and the next overflow page kept the old size/margins. */

import { describe, test, expect } from 'bun:test';
import { layOutPages } from '../pageComposer';
import type {
  ContentNode,
  Fragment,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMetrics,
  SectionMarkerBlock,
  TableBlock,
  TableFragment,
  TableMetrics,
} from '../types';

function isTableFragmentFor(blockId: string) {
  return (fragment: Fragment): fragment is TableFragment =>
    fragment.kind === 'table' && fragment.nodeId === blockId;
}

function expectSingleTableFragment(fragments: Fragment[], blockId: string): TableFragment {
  const matches = fragments.filter(isTableFragmentFor(blockId));
  expect(matches).toHaveLength(1);
  const fragment = matches[0];
  if (!fragment) {
    throw new Error(`Expected one table fragment for ${blockId}`);
  }
  return fragment;
}

function para(id: string, height: number): { block: ParagraphBlock; measure: ParagraphMetrics } {
  return {
    block: {
      kind: 'paragraph',
      id,
      docFrom: 0,
      docTo: 0,
      runs: [{ kind: 'text', text: id }],
      attrs: {},
    },
    measure: {
      kind: 'paragraph',
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: 0,
          width: 100,
          ascent: 10,
          descent: 3,
          lineHeight: height,
        },
      ],
      totalHeight: height,
    },
  };
}

function paraLines(
  id: string,
  count: number,
  lineHeight: number
): { block: ParagraphBlock; measure: ParagraphMetrics } {
  return {
    block: {
      kind: 'paragraph',
      id,
      docFrom: 0,
      docTo: count,
      runs: [{ kind: 'text', text: id.repeat(count) }],
      attrs: {},
    },
    measure: {
      kind: 'paragraph',
      lines: Array.from({ length: count }, (_, i) => ({
        fromRun: 0,
        fromChar: i,
        toRun: 0,
        toChar: i + 1,
        width: 100,
        ascent: 10,
        descent: 3,
        lineHeight,
      })),
      totalHeight: count * lineHeight,
    },
  };
}

function twoRowTable(): { block: TableBlock; measure: TableMetrics } {
  const first = para('row-one', 40);
  const second = para('row-two', 40);
  const nestedParagraph = para('nested', 20);
  const nestedBlock: TableBlock = {
    kind: 'table',
    id: 'nested-table',
    columnWidths: [80],
    rows: [{ id: 'nested-row', cells: [{ id: 'nested-cell', nodes: [nestedParagraph.block] }] }],
  };
  const nestedMeasure: TableMetrics = {
    kind: 'table',
    columnWidths: [80],
    totalWidth: 80,
    totalHeight: 20,
    rows: [{ height: 20, cells: [{ metrics: [nestedParagraph.measure], width: 80, height: 20 }] }],
  };
  return {
    block: {
      kind: 'table',
      id: 'two-row-table',
      columnWidths: [90, 90],
      rows: [
        {
          id: 'row-one',
          cells: [{ id: 'cell-one', colSpan: 2, nodes: [first.block] }],
        },
        {
          id: 'row-two',
          cells: [
            { id: 'cell-two-a', nodes: [nestedBlock] },
            { id: 'cell-two-b', nodes: [second.block] },
          ],
        },
      ],
    },
    measure: {
      kind: 'table',
      columnWidths: [90, 90],
      totalWidth: 180,
      totalHeight: 80,
      rows: [
        { height: 40, cells: [{ metrics: [first.measure], width: 180, height: 40 }] },
        {
          height: 40,
          cells: [
            { metrics: [nestedMeasure], width: 90, height: 40 },
            { metrics: [second.measure], width: 90, height: 40 },
          ],
        },
      ],
    },
  };
}

describe('continuous section break geometry', () => {
  test('current page keeps OLD section geometry; only the next created page picks up the new size', () => {
    // Half-page of content, then a continuous break that swaps to landscape.
    // The page containing the break stays portrait; overflow lands in landscape.
    const A = para('a', 200);
    const sb: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'sb',
      type: 'continuous',
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    };
    const B = para('b', 200);
    // C is taller than the new section's content area (landscape 700h with
    // 50/50 margins → 600). Exercises the paginator's oversized-fragment
    // guard across a deferred geometry swap: without the in-loop re-check,
    // `ensureFits` looped forever creating empty pages.
    const C = para('c', 800);

    const blocks: ContentNode[] = [A.block, sb, B.block, C.block];
    const measures = [A.measure, { kind: 'sectionBreak' }, B.measure, C.measure] as never;

    const result = layOutPages(blocks, measures, {
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 1200, h: 700 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    // First page started before the break — must keep the OLD geometry.
    expect(result.pages[0].size.w).toBe(800);
    // Last page (created from overflow after the break) — NEW geometry.
    const lastPage = result.pages[result.pages.length - 1];
    expect(lastPage.size.w).toBe(1200);
    expect(lastPage.size.h).toBe(700);
  });

  test("next overflow page uses the continuous section's page size", () => {
    const A = para('a', 700); // fills first portrait page
    const sb: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'sb',
      type: 'continuous',
      pageSize: { w: 1200, h: 700 }, // landscape
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    };
    const B = para('b', 500); // forces a second page after the section break
    const C = para('c', 500); // overflows to a third page (landscape)

    const blocks: ContentNode[] = [A.block, sb, B.block, C.block];
    const measures = [A.measure, { kind: 'sectionBreak' }, B.measure, C.measure] as never;

    const result = layOutPages(blocks, measures, {
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 1200, h: 700 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    // Pages after the continuous break must adopt the new geometry.
    const lastPage = result.pages[result.pages.length - 1];
    expect(lastPage.size.w).toBe(1200);
    expect(lastPage.size.h).toBe(700);
  });

  test('tags pages with section index and section-local page number', () => {
    const A = para('first-section', 100);
    const sb: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'sb',
      type: 'nextPage',
    };
    const B = para('second-section-page-1', 300);
    const C = para('second-section-page-2', 300);

    const blocks: ContentNode[] = [A.block, sb, B.block, C.block];
    const measures = [A.measure, { kind: 'sectionBreak' }, B.measure, C.measure] as never;

    const result = layOutPages(blocks, measures, {
      pageSize: { w: 500, h: 500 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 500, h: 500 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(result.pages.map((page) => page.sectionIndex)).toEqual([0, 1, 1]);
    expect(result.pages.map((page) => page.sectionPageNumber)).toEqual([1, 1, 2]);
  });

  test('leaves a terminal multi-column section in normal sequential flow', () => {
    const A = para('intro', 80);
    const sb: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'sb',
      type: 'continuous',
    };
    const B = paraLines('two-column', 6, 20);

    const blocks: ContentNode[] = [A.block, sb, B.block];
    const measures = [A.measure, { kind: 'sectionBreak' }, B.measure] as never;

    const result = layOutPages(blocks, measures, {
      pageSize: { w: 500, h: 500 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      columns: { count: 2, gap: 20 },
      bodyBreakType: 'continuous',
    });

    const balancedFragments = result.pages[0].fragments.filter(
      (f): f is ParagraphFragment => f.kind === 'paragraph' && f.nodeId === 'two-column'
    );

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].columns?.count).toBe(2);
    expect(balancedFragments).toHaveLength(1);
    expect(balancedFragments.map((f) => [f.fromLine, f.toLine])).toEqual([[0, 6]]);
    expect(balancedFragments.map((f) => f.x)).toEqual([50]);
  });

  test('balances a fitting nested table at a legal row boundary', () => {
    const intro = para('intro', 40);
    const firstBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'first-break',
      type: 'continuous',
    };
    const lead = para('lead', 20);
    const table = twoRowTable();
    const trail = para('trail', 20);
    const secondBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'second-break',
      type: 'continuous',
      columns: { count: 2, gap: 20 },
    };
    const final = paraLines('final', 3, 20);
    const blocks: ContentNode[] = [
      intro.block,
      firstBreak,
      lead.block,
      table.block,
      trail.block,
      secondBreak,
      final.block,
    ];
    const measures = [
      intro.measure,
      { kind: 'sectionBreak' },
      lead.measure,
      table.measure,
      trail.measure,
      { kind: 'sectionBreak' },
      final.measure,
    ] as never;

    const result = layOutPages(blocks, measures, {
      pageSize: { w: 500, h: 500 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      columns: { count: 3, gap: 10 },
      bodyBreakType: 'continuous',
    });
    const tableFragments = result.pages[0].fragments.filter(isTableFragmentFor('two-row-table'));

    expect(tableFragments.map((fragment) => [fragment.fromRow, fragment.toRow])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(tableFragments.map((fragment) => fragment.x)).toEqual([50, 260]);
    expect(tableFragments[0]?.continuesOnNext).toBe(true);
    expect(tableFragments[1]?.continuesFromPrev).toBe(true);

    const leadFragment = result.pages[0].fragments.find((fragment) => fragment.nodeId === 'lead');
    const trailFragment = result.pages[0].fragments.find((fragment) => fragment.nodeId === 'trail');
    const finalFragments = result.pages[0].fragments.filter(
      (fragment): fragment is ParagraphFragment =>
        fragment.kind === 'paragraph' && fragment.nodeId === 'final'
    );
    expect(leadFragment?.x).toBe(50);
    expect(trailFragment?.x).toBe(260);
    expect(trailFragment?.y).toBe(130);
    expect(result.pages).toHaveLength(1);
    expect(finalFragments.map((fragment) => Math.round(fragment.x))).toEqual([50]);
    expect(finalFragments.map((fragment) => fragment.y)).toEqual([150]);
  });

  test('ignores floating tables when choosing the balanced flow boundary', () => {
    const intro = para('intro', 20);
    const floating = twoRowTable();
    floating.block = { ...floating.block, id: 'floating-table', floating: {} };
    const trailing = para('trailing', 20);
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'section-break',
      type: 'continuous',
    };
    const closingBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'closing-break',
      type: 'continuous',
      columns: { count: 2, gap: 20 },
    };

    const result = layOutPages(
      [sectionBreak, intro.block, floating.block, trailing.block, closingBreak],
      [
        { kind: 'sectionBreak' },
        intro.measure,
        floating.measure,
        trailing.measure,
        { kind: 'sectionBreak' },
      ] as never,
      {
        pageSize: { w: 500, h: 500 },
        margins: { top: 50, right: 50, bottom: 50, left: 50 },
        columns: { count: 2, gap: 20 },
        bodyBreakType: 'continuous',
      }
    );

    const introFragment = result.pages[0].fragments.find((fragment) => fragment.nodeId === 'intro');
    const trailingFragment = result.pages[0].fragments.find(
      (fragment) => fragment.nodeId === 'trailing'
    );
    expect(introFragment?.x).toBe(50);
    expect(trailingFragment?.x).toBe(260);
    expect(trailingFragment?.y).toBe(50);
  });

  test('balances with paginator-style collapsed paragraph spacing', () => {
    const first = para('first', 20);
    first.block.attrs = {
      spacing: { after: 30 },
      spacingOverrides: { after: true },
    };
    first.measure.totalHeight = 50;
    const second = para('second', 20);
    second.block.attrs = {
      spacing: { before: 10, after: 30 },
      spacingOverrides: { before: true, after: true },
    };
    second.measure.totalHeight = 60;
    const table = twoRowTable();
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'section-break',
      type: 'continuous',
    };
    const closingBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'closing-break',
      type: 'continuous',
      columns: { count: 2, gap: 20 },
    };

    const result = layOutPages(
      [sectionBreak, first.block, second.block, table.block, closingBreak],
      [
        { kind: 'sectionBreak' },
        first.measure,
        second.measure,
        table.measure,
        { kind: 'sectionBreak' },
      ] as never,
      {
        pageSize: { w: 500, h: 500 },
        margins: { top: 50, right: 50, bottom: 50, left: 50 },
        columns: { count: 2, gap: 20 },
        bodyBreakType: 'continuous',
      }
    );
    const firstFragment = result.pages[0].fragments.find((fragment) => fragment.nodeId === 'first');
    const secondFragment = result.pages[0].fragments.find(
      (fragment) => fragment.nodeId === 'second'
    );
    const tableFragment = result.pages[0].fragments.find(
      (fragment) => fragment.nodeId === 'two-row-table'
    );

    expect(firstFragment?.y).toBe(50);
    expect(secondFragment?.y).toBe(100);
    expect(tableFragment?.x).toBe(260);
    expect(tableFragment?.y).toBe(50);
  });

  test('fragments an oversized balanced table only at measured row boundaries', () => {
    const table = twoRowTable();
    table.measure.rows[0].height = 220;
    table.measure.rows[1].height = 220;
    table.measure.totalHeight = 440;
    const trailing = para('trailing', 20);
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'section-break',
      type: 'continuous',
    };
    const closingBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'closing-break',
      type: 'continuous',
      columns: { count: 2, gap: 20 },
    };

    const result = layOutPages(
      [sectionBreak, table.block, trailing.block, closingBreak],
      [
        { kind: 'sectionBreak' },
        table.measure,
        trailing.measure,
        { kind: 'sectionBreak' },
      ] as never,
      {
        pageSize: { w: 500, h: 500 },
        margins: { top: 50, right: 50, bottom: 50, left: 50 },
        columns: { count: 2, gap: 20 },
        bodyBreakType: 'continuous',
      }
    );
    const fragments = result.pages[0].fragments.filter(isTableFragmentFor('two-row-table'));

    expect(fragments.map((fragment) => [fragment.fromRow, fragment.toRow])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(fragments.map((fragment) => fragment.x)).toEqual([50, 260]);
    expect(fragments.every((fragment) => fragment.topClip === undefined)).toBe(true);
    expect(fragments.every((fragment) => fragment.bottomClip === undefined)).toBe(true);
  });

  test('does not balance between a keepNext heading and its table anchor', () => {
    const intro = para('intro', 40);
    const heading = para('heading', 20);
    heading.block.attrs = { keepNext: true };
    const table = twoRowTable();
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'section-break',
      type: 'continuous',
    };
    const closingBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'closing-break',
      type: 'continuous',
      columns: { count: 2, gap: 20 },
    };

    const result = layOutPages(
      [sectionBreak, intro.block, heading.block, table.block, closingBreak],
      [
        { kind: 'sectionBreak' },
        intro.measure,
        heading.measure,
        table.measure,
        { kind: 'sectionBreak' },
      ] as never,
      {
        pageSize: { w: 500, h: 500 },
        margins: { top: 50, right: 50, bottom: 50, left: 50 },
        columns: { count: 2, gap: 20 },
        bodyBreakType: 'continuous',
      }
    );
    const headingFragment = result.pages[0].fragments.find(
      (fragment): fragment is ParagraphFragment =>
        fragment.kind === 'paragraph' && fragment.nodeId === 'heading'
    );
    const tableFragment = expectSingleTableFragment(result.pages[0].fragments, 'two-row-table');

    expect(headingFragment?.x).toBe(260);
    expect(tableFragment.x).toBe(260);
    expect(tableFragment.y).toBe(70);
    expect([tableFragment.fromRow, tableFragment.toRow]).toEqual([0, 2]);
  });

  test('treats a keepLines paragraph as one legal balancing unit', () => {
    const intro = para('intro', 40);
    const kept = paraLines('kept', 4, 20);
    kept.block.attrs = { keepLines: true };
    const trailing = para('trailing', 20);
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'section-break',
      type: 'continuous',
    };
    const closingBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'closing-break',
      type: 'continuous',
      columns: { count: 2, gap: 20 },
    };

    const result = layOutPages(
      [sectionBreak, intro.block, kept.block, trailing.block, closingBreak],
      [
        { kind: 'sectionBreak' },
        intro.measure,
        kept.measure,
        trailing.measure,
        { kind: 'sectionBreak' },
      ] as never,
      {
        pageSize: { w: 500, h: 500 },
        margins: { top: 50, right: 50, bottom: 50, left: 50 },
        columns: { count: 2, gap: 20 },
        bodyBreakType: 'continuous',
      }
    );
    const keptFragments = result.pages[0].fragments.filter(
      (fragment): fragment is ParagraphFragment =>
        fragment.kind === 'paragraph' && fragment.nodeId === 'kept'
    );

    expect(keptFragments).toHaveLength(1);
    expect(keptFragments[0]?.x).toBe(260);
    expect([keptFragments[0]?.fromLine, keptFragments[0]?.toLine]).toEqual([0, 4]);
  });

  test('continuous orientation change keeps the current page; next overflow picks up new size', () => {
    // portrait A → [continuous → landscape] → B (fits) → C (overflows).
    // Geometry stays deferred: A+B share the portrait sheet; only the page
    // created by C's overflow adopts landscape.
    const PORTRAIT = { w: 800, h: 1000 };
    const LANDSCAPE = { w: 1200, h: 700 };
    const M = { top: 50, right: 50, bottom: 50, left: 50 };

    const A = para('a', 100);
    const sb: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'sb',
      type: 'continuous',
      pageSize: PORTRAIT,
      margins: M,
    };
    const B = para('b', 100);
    // Content area on portrait is 900px; A+B leave ~700. C forces overflow onto
    // a newly created page that must use the pending landscape geometry.
    const C = para('c', 800);

    const blocks: ContentNode[] = [A.block, sb, B.block, C.block];
    const measures = [A.measure, { kind: 'sectionBreak' }, B.measure, C.measure] as never;

    const result = layOutPages(blocks, measures, {
      pageSize: PORTRAIT,
      margins: M,
      finalPageSize: LANDSCAPE,
      finalMargins: M,
      bodyBreakType: 'continuous',
    });

    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    expect(result.pages[0].size).toEqual(PORTRAIT);
    expect(result.pages[0].fragments.some((f) => f.nodeId === 'a')).toBe(true);
    expect(result.pages[0].fragments.some((f) => f.nodeId === 'b')).toBe(true);
    const lastPage = result.pages[result.pages.length - 1];
    expect(lastPage.size).toEqual(LANDSCAPE);
    expect(lastPage.fragments.some((f) => f.nodeId === 'c')).toBe(true);
  });
});
