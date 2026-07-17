import { describe, expect, test } from 'bun:test';
import {
  buildFootnoteContentMap,
  collectFootnoteRefs,
  createWidthSpecificFootnoteContentResolver,
  mapFootnotesToPages,
  stabilizeFootnoteLayout,
  stabilizeFootnoteLayoutWithPageContent,
  type FootnoteRefLocation,
} from '../footnoteLayout';
import { buildEndnoteFlowBlocks, collectEndnoteRefs } from '../endnoteLayout';
import { takeFootnoteSlice } from '../footnoteSlices';
import { layOutPages } from '../../pagination-model';
import type {
  ContentNode,
  FootnoteContent,
  LayoutConfig,
  MeasuredLine,
  Page,
  ParagraphBlock,
  ParagraphMetrics,
  SectionMarkerBlock,
  TableBlock,
  TableMetrics,
} from '../../pagination-model/types';
import type { Endnote, Footnote } from '../../types/document';

const layoutConfig: LayoutConfig = {
  pageSize: { w: 200, h: 140 },
  margins: { top: 10, right: 10, bottom: 10, left: 10 },
};

function line(lineHeight = 40): MeasuredLine {
  return {
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 1,
    width: 10,
    ascent: lineHeight * 0.75,
    descent: lineHeight * 0.25,
    lineHeight,
  };
}

function paragraph(id: string, docFrom: number, footnoteRefId?: number): ParagraphBlock {
  return {
    kind: 'paragraph',
    id,
    docFrom,
    docTo: docFrom + 2,
    runs: [
      {
        kind: 'text',
        text: 'x',
        docFrom,
        docTo: docFrom + 1,
        ...(footnoteRefId != null ? { footnoteRefId } : {}),
      },
    ],
  };
}

function paragraphMeasure(count: number, lineHeight = 40): ParagraphMetrics {
  return {
    kind: 'paragraph',
    lines: Array.from({ length: count }, (_, index) => ({
      ...line(lineHeight),
      fromChar: index,
      toChar: index + 1,
    })),
    totalHeight: count * lineHeight,
  };
}

function textParagraph(id: string, text: string): ParagraphBlock {
  return {
    kind: 'paragraph',
    id,
    runs: [{ kind: 'text', text }],
  };
}

function wrappedParagraphMeasure(
  textLength: number,
  charsPerLine: number,
  lineHeight: number
): ParagraphMetrics {
  const lines = Array.from({ length: Math.ceil(textLength / charsPerLine) }, (_, index) => {
    const fromChar = index * charsPerLine;
    return {
      ...line(lineHeight),
      fromChar,
      toChar: Math.min(textLength, fromChar + charsPerLine),
    };
  });
  return {
    kind: 'paragraph',
    lines,
    totalHeight: lines.length * lineHeight,
  };
}

function bodyFixture() {
  const block = paragraph('body', 1, 7);
  const measure = paragraphMeasure(1, 20);
  const initialLayout = layOutPages([block], [measure], layoutConfig);
  const refs: FootnoteRefLocation[] = [{ footnoteId: 7, pmPos: 1 }];
  return { block, measure, initialLayout, refs };
}

describe('endnote document-end rendering helpers', () => {
  test('collects endnote refs and builds lower-roman endnote blocks', () => {
    const nodes: ContentNode[] = [
      {
        kind: 'paragraph',
        id: 'p1',
        runs: [
          { kind: 'text', text: 'first', endnoteRefId: 1 },
          { kind: 'text', text: 'second', endnoteRefId: 2 },
        ],
      },
    ];
    const endnotes: Endnote[] = [
      {
        type: 'endnote',
        id: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'run', content: [{ type: 'text', text: 'Alpha' }] }],
          },
        ],
      },
      {
        type: 'endnote',
        id: 2,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'run', content: [{ type: 'text', text: 'Beta' }] }],
          },
        ],
      },
    ];

    const refs = collectEndnoteRefs(nodes);
    const out = buildEndnoteFlowBlocks(endnotes, refs, {
      numFmt: 'lowerRoman',
      contentWidth: 600,
    });

    expect(refs).toEqual([{ endnoteId: 1 }, { endnoteId: 2 }]);
    expect((out[0] as ParagraphBlock).attrs?.borders?.top).toMatchObject({
      style: 'solid',
      width: 1,
    });
    expect((out[0] as ParagraphBlock).attrs?.indent?.right).toBeCloseTo(400, 4);
    expect((out[1] as ParagraphBlock).runs[0]).toMatchObject({
      text: 'i  ',
      superscript: true,
    });
    expect((out[2] as ParagraphBlock).runs[0]).toMatchObject({
      text: 'ii  ',
      superscript: true,
    });
  });
});

describe('footnote continuation planning', () => {
  test('slices paragraphs at line boundaries and continues beyond the body', () => {
    const { block, measure, initialLayout, refs } = bodyFixture();
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      nodes: [paragraph('footnote-p', 100)],
      metrics: [paragraphMeasure(7)],
      height: 280,
    };

    const result = stabilizeFootnoteLayout({
      nodes: [block],
      metrics: [measure],
      layoutConfig,
      footnoteRefs: refs,
      footnoteContentMap: new Map([[7, content]]),
      initialLayout,
    });

    expect(result.converged).toBe(true);
    expect(result.layout.pages.length).toBe(4);
    expect(result.layout.pages[0].footnoteFragments?.[0]).toMatchObject({
      footnoteId: 7,
      continuesOnNext: true,
      nodes: [{ kind: 'paragraph', fromLine: 0, toLine: 2 }],
    });
    expect(result.layout.pages[1].footnoteFragments?.[0]).toMatchObject({
      continuesFromPrev: true,
      continuesOnNext: true,
      nodes: [{ kind: 'paragraph', fromLine: 2, toLine: 4 }],
    });
    expect(result.layout.pages[3].footnoteFragments?.[0]).toMatchObject({
      continuesFromPrev: true,
      nodes: [{ kind: 'paragraph', fromLine: 6, toLine: 7 }],
    });
    expect(result.layout.pages[3].footnoteFragments?.[0].continuesOnNext).toBeUndefined();
  });

  test('remaps a continuation cursor from 10-character lines to 5-character lines', () => {
    const text = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
    const block = textParagraph('remeasured-footnote', text);
    const wideContent: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      nodes: [block],
      metrics: [wrappedParagraphMeasure(text.length, 10, 10)],
      height: 40,
    };
    const narrowContent: FootnoteContent = {
      ...wideContent,
      metrics: [wrappedParagraphMeasure(text.length, 5, 10)],
      height: 80,
    };

    const wideSlice = takeFootnoteSlice(wideContent, { nodeIndex: 0, unitIndex: 0 }, 20, 0, true);
    expect(wideSlice.fragment?.nodes[0]).toMatchObject({
      kind: 'paragraph',
      fromLine: 0,
      toLine: 2,
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 20,
    });
    expect(wideSlice.cursor.paragraphPosition).toEqual({ runIndex: 0, charOffset: 20 });

    const narrowSlice = takeFootnoteSlice(
      narrowContent,
      wideSlice.cursor,
      Number.POSITIVE_INFINITY,
      0,
      true
    );
    expect(narrowSlice.fragment?.nodes[0]).toMatchObject({
      kind: 'paragraph',
      fromLine: 4,
      toLine: 8,
      fromRun: 0,
      fromChar: 20,
      toRun: 0,
      toChar: 40,
    });
    const ranges = [wideSlice.fragment, narrowSlice.fragment].map((fragment) => {
      const slice = fragment?.nodes[0];
      if (!slice || slice.kind !== 'paragraph') return '';
      return text.slice(slice.fromChar, slice.toChar);
    });
    expect(ranges.join('')).toBe(text);
    expect(narrowSlice.done).toBe(true);
  });

  test('slices tables only between complete rows', () => {
    const { block, measure, initialLayout, refs } = bodyFixture();
    const table: TableBlock = {
      kind: 'table',
      id: 'footnote-table',
      rows: Array.from({ length: 5 }, (_, row) => ({
        id: `row-${row}`,
        cells: [{ id: `cell-${row}`, nodes: [] }],
      })),
    };
    const tableMeasure: TableMetrics = {
      kind: 'table',
      rows: Array.from({ length: 5 }, () => ({
        height: 45,
        cells: [{ metrics: [], width: 180 }],
      })),
      columnWidths: [180],
      totalWidth: 180,
      totalHeight: 225,
    };
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      nodes: [table],
      metrics: [tableMeasure],
      height: 225,
    };

    const result = stabilizeFootnoteLayout({
      nodes: [block],
      metrics: [measure],
      layoutConfig,
      footnoteRefs: refs,
      footnoteContentMap: new Map([[7, content]]),
      initialLayout,
    });

    expect(result.layout.pages.map((page) => page.footnoteFragments?.[0]?.nodes[0])).toEqual([
      expect.objectContaining({ kind: 'table', fromRow: 0, toRow: 2 }),
      expect.objectContaining({ kind: 'table', fromRow: 2, toRow: 4 }),
      expect.objectContaining({ kind: 'table', fromRow: 4, toRow: 5 }),
    ]);
  });

  test('continues an oversized table row at safe line boundaries', () => {
    const cellParagraph = paragraph('long-cell', 100);
    const cellMeasure = paragraphMeasure(5);
    const table: TableBlock = {
      kind: 'table',
      id: 'long-row-table',
      rows: [{ id: 'row', cells: [{ id: 'cell', nodes: [cellParagraph] }] }],
    };
    const tableMeasure: TableMetrics = {
      kind: 'table',
      rows: [
        {
          height: 200,
          cells: [{ metrics: [cellMeasure], width: 180, height: 200 }],
        },
      ],
      columnWidths: [180],
      totalWidth: 180,
      totalHeight: 200,
    };
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      nodes: [table],
      metrics: [tableMeasure],
      height: 200,
    };

    const first = takeFootnoteSlice(content, { nodeIndex: 0, unitIndex: 0 }, 90, 0, true);
    expect(first.fragment?.nodes[0]).toMatchObject({
      kind: 'table',
      height: 80,
      fromRow: 0,
      toRow: 1,
      bottomClip: 120,
    });
    expect(first.cursor).toEqual({ nodeIndex: 0, unitIndex: 0, unitOffset: 80 });

    const second = takeFootnoteSlice(content, first.cursor, 90, 0, true);
    expect(second.fragment?.nodes[0]).toMatchObject({
      kind: 'table',
      height: 80,
      topClip: 80,
      bottomClip: 40,
    });
    expect(second.cursor).toEqual({ nodeIndex: 0, unitIndex: 0, unitOffset: 160 });

    const last = takeFootnoteSlice(content, second.cursor, 90, 0, true);
    expect(last.fragment?.nodes[0]).toMatchObject({
      kind: 'table',
      height: 40,
      topClip: 160,
    });
    expect(last.done).toBe(true);
  });

  test('materializes a requested minimum page count', () => {
    const block = paragraph('body', 1);
    const layout = layOutPages([block], [paragraphMeasure(1, 20)], {
      ...layoutConfig,
      minimumPageCount: 4,
    });

    expect(layout.pages).toHaveLength(4);
    expect(layout.pages.slice(1).every((page) => page.fragments.length === 0)).toBe(true);
  });

  test('converges to the same continuation plan on repeated runs', () => {
    const { block, measure, initialLayout, refs } = bodyFixture();
    const content: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      nodes: [paragraph('footnote-p', 100)],
      metrics: [paragraphMeasure(5)],
      height: 200,
    };
    const args = {
      nodes: [block],
      metrics: [measure],
      layoutConfig,
      footnoteRefs: refs,
      footnoteContentMap: new Map([[7, content]]),
      initialLayout,
    };

    const first = stabilizeFootnoteLayout(args);
    const second = stabilizeFootnoteLayout({ ...args, initialLayout: first.layout });

    expect(first.converged).toBe(true);
    expect(second.converged).toBe(true);
    expect(
      second.layout.pages.map((page) => ({
        reserved: page.footnoteReservedHeight,
        fragments: page.footnoteFragments,
      }))
    ).toEqual(
      first.layout.pages.map((page) => ({
        reserved: page.footnoteReservedHeight,
        fragments: page.footnoteFragments,
      }))
    );
  });

  test('resolves footnote columns independently for each physical page', () => {
    const nodes = [paragraph('page-one', 1, 1), paragraph('page-two', 11, 2)];
    const metrics = [paragraphMeasure(1, 80), paragraphMeasure(1, 80)];
    const initialLayout = layOutPages(nodes, metrics, layoutConfig);
    const contentMap = new Map<number, FootnoteContent>([
      [
        1,
        {
          id: 1,
          displayNumber: 1,
          nodes: [paragraph('footnote-one', 101)],
          metrics: [paragraphMeasure(1, 20)],
          height: 20,
        },
      ],
      [
        2,
        {
          id: 2,
          displayNumber: 2,
          nodes: [paragraph('footnote-two', 201)],
          metrics: [paragraphMeasure(1, 20)],
          height: 20,
        },
      ],
    ]);
    const result = stabilizeFootnoteLayout({
      nodes,
      metrics,
      layoutConfig,
      footnoteRefs: [
        { footnoteId: 1, pmPos: 1 },
        { footnoteId: 2, pmPos: 11 },
      ],
      footnoteContentMap: contentMap,
      initialLayout,
      resolveFootnoteColumns: (pageNumber: number) => (pageNumber === 2 ? 2 : 1),
    });

    expect(result.layout.pages.map((page) => page.footnoteColumns)).toEqual([undefined, 2]);
  });

  test('moves dense reference lines until every footnote starts beside its reference', () => {
    const nodes = Array.from({ length: 5 }, (_, index) =>
      paragraph(`body-${index + 1}`, index * 10 + 1, index + 1)
    );
    const metrics = nodes.map(() => paragraphMeasure(1, 5));
    const initialLayout = layOutPages(nodes, metrics, layoutConfig);
    const footnoteContentMap = new Map<number, FootnoteContent>(
      nodes.map((_, index) => {
        const id = index + 1;
        return [
          id,
          {
            id,
            displayNumber: id,
            nodes: [paragraph(`footnote-${id}`, 100 + id * 10)],
            metrics: [paragraphMeasure(1, 60)],
            height: 60,
          },
        ];
      })
    );
    const result = stabilizeFootnoteLayout({
      nodes,
      metrics,
      layoutConfig,
      footnoteRefs: nodes.map((_, index) => ({
        footnoteId: index + 1,
        pmPos: index * 10 + 1,
      })),
      footnoteContentMap,
      initialLayout,
    });

    expect(result.converged).toBe(true);
    for (let id = 1; id <= nodes.length; id++) {
      const referencePage = result.layout.pages.find((page) =>
        page.fragments.some((fragment) => fragment.nodeId === `body-${id}`)
      );
      const startPage = result.layout.pages.find((page) =>
        page.footnoteFragments?.some((fragment) => fragment.footnoteId === id)
      );
      const firstFragment = startPage?.footnoteFragments?.find(
        (fragment) => fragment.footnoteId === id
      );
      expect(startPage?.number).toBe(referencePage?.number);
      expect(firstFragment?.continuesFromPrev).toBeUndefined();
    }
  });

  test('uses the new physical page width after stabilization moves a reference', () => {
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'old-section-end',
      pageSize: layoutConfig.pageSize,
      margins: layoutConfig.margins,
    };
    const ref = paragraph('moved-reference', 11, 7);
    const nodes = [paragraph('preamble', 1, 1), sectionBreak, ref];
    const metrics = [
      paragraphMeasure(1, 60),
      { kind: 'sectionBreak' as const },
      paragraphMeasure(1, 20),
    ];
    const config: LayoutConfig = {
      ...layoutConfig,
      finalPageSize: { w: 110, h: 140 },
      finalMargins: layoutConfig.margins,
      bodyBreakType: 'continuous',
    };
    const initialLayout = layOutPages(nodes, metrics, config);
    const wideContent: FootnoteContent = {
      id: 7,
      displayNumber: 2,
      nodes: [paragraph('wide-note', 100)],
      metrics: [paragraphMeasure(1, 40)],
      height: 40,
    };
    const narrowContent: FootnoteContent = {
      id: 7,
      displayNumber: 2,
      nodes: [paragraph('narrow-note', 100)],
      metrics: [paragraphMeasure(2, 20)],
      height: 40,
    };
    const anchoringContent: FootnoteContent = {
      id: 1,
      displayNumber: 1,
      nodes: [paragraph('anchoring-note', 90)],
      metrics: [paragraphMeasure(1, 40)],
      height: 40,
    };
    const resolvedPageWidths: number[] = [];

    const result = stabilizeFootnoteLayoutWithPageContent({
      nodes,
      metrics,
      layoutConfig: config,
      footnoteRefs: [
        { footnoteId: 1, pmPos: 1 },
        { footnoteId: 7, pmPos: 11 },
      ],
      footnoteContentMap: new Map(),
      initialLayout,
      resolveFootnoteColumns: (_pageNumber, page) => (page?.size.w === 110 ? 2 : 1),
      resolveFootnoteContent: (footnoteId, _pageNumber, page) => {
        resolvedPageWidths.push(page?.size.w ?? 0);
        if (footnoteId === 1) return anchoringContent;
        return page?.size.w === 110 ? narrowContent : wideContent;
      },
    });

    const referencePage = result.layout.pages.find((page) =>
      page.fragments.some((fragment) => fragment.nodeId === ref.id)
    );
    expect(referencePage?.number).toBe(2);
    expect(referencePage?.size.w).toBe(110);
    expect(referencePage?.footnoteColumns).toBe(2);
    expect(referencePage?.footnoteFragments?.[0]?.nodes[0]).toMatchObject({
      kind: 'paragraph',
      fromLine: 0,
      toLine: 2,
    });
    expect(resolvedPageWidths).toContain(200);
    expect(resolvedPageWidths).toContain(110);
  });

  test('switches measurement variants when a continuation enters a narrower page', () => {
    const sectionBreak: SectionMarkerBlock = {
      kind: 'sectionBreak',
      id: 'old-section-end',
      pageSize: layoutConfig.pageSize,
      margins: layoutConfig.margins,
    };
    const ref = paragraph('continued-reference', 1, 7);
    const nodes = [ref, sectionBreak];
    const metrics = [paragraphMeasure(1, 20), { kind: 'sectionBreak' as const }];
    const config: LayoutConfig = {
      ...layoutConfig,
      finalPageSize: { w: 110, h: 140 },
      finalMargins: layoutConfig.margins,
      bodyBreakType: 'continuous',
    };
    const initialLayout = layOutPages(nodes, metrics, config);
    const text = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567';
    const noteBlock = textParagraph('continued-footnote', text);
    const wideContent: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      nodes: [noteBlock],
      metrics: [wrappedParagraphMeasure(text.length, 10, 25)],
      height: 150,
    };
    const narrowContent: FootnoteContent = {
      id: 7,
      displayNumber: 1,
      nodes: [noteBlock],
      metrics: [wrappedParagraphMeasure(text.length, 5, 10)],
      height: 120,
    };

    const result = stabilizeFootnoteLayoutWithPageContent({
      nodes,
      metrics,
      layoutConfig: config,
      footnoteRefs: [{ footnoteId: 7, pmPos: 1 }],
      footnoteContentMap: new Map(),
      initialLayout,
      resolveFootnoteContent: (_footnoteId, _pageNumber, page) =>
        page?.size.w === 110 ? narrowContent : wideContent,
    });

    expect(result.layout.pages[0].size.w).toBe(200);
    expect(result.layout.pages[0].footnoteFragments?.[0]).toMatchObject({
      continuesOnNext: true,
      nodes: [
        {
          kind: 'paragraph',
          fromLine: 0,
          toLine: 3,
          fromChar: 0,
          toChar: 30,
        },
      ],
    });
    expect(result.layout.pages[1].size.w).toBe(110);
    expect(result.layout.pages[1].footnoteFragments?.[0]).toMatchObject({
      continuesFromPrev: true,
      nodes: [
        {
          kind: 'paragraph',
          fromLine: 6,
          toLine: 12,
          fromChar: 30,
          toChar: 60,
        },
      ],
    });
    const paintedText = result.layout.pages
      .flatMap((page) => page.footnoteFragments ?? [])
      .flatMap((fragment) => fragment.nodes)
      .filter((slice) => slice.kind === 'paragraph')
      .map((slice) => text.slice(slice.fromChar, slice.toChar))
      .join('');
    expect(paintedText).toBe(text);
  });
});

test('metrics each footnote at its reference section column width', () => {
  const footnotes: Footnote[] = [
    { type: 'footnote', id: 1, content: [] },
    { type: 'footnote', id: 2, content: [] },
  ];
  const measuredWidths: number[] = [];

  buildFootnoteContentMap(
    footnotes,
    [{ footnoteId: 1 }, { footnoteId: 2 }],
    (footnoteId) => (footnoteId === 1 ? 180 : 78),
    {
      measureBlocks: (nodes, contentWidth) => {
        measuredWidths.push(contentWidth);
        return nodes.map(() => paragraphMeasure(1, 10));
      },
    }
  );

  expect(measuredWidths).toEqual([180, 78]);
});

test('memoizes each footnote measurement by width', () => {
  const measuredWidths: number[] = [];
  const resolve = createWidthSpecificFootnoteContentResolver(
    [{ type: 'footnote', id: 1, content: [] }],
    [{ footnoteId: 1 }],
    {
      measureBlocks: (nodes, contentWidth) => {
        measuredWidths.push(contentWidth);
        return nodes.map(() => paragraphMeasure(1, 10));
      },
    }
  );

  const wide = resolve(1, 180);
  expect(resolve(1, 180)).toBe(wide);
  const narrow = resolve(1, 78);
  expect(resolve(1, 78)).toBe(narrow);
  expect(narrow).not.toBe(wide);
  expect(measuredWidths).toEqual([180, 78]);
});

test('maps a final-line table reference to its clipped row fragment', () => {
  const cellParagraph: ParagraphBlock = {
    kind: 'paragraph',
    id: 'split-cell-paragraph',
    docFrom: 10,
    docTo: 15,
    runs: Array.from({ length: 5 }, (_, runIndex) => ({
      kind: 'text' as const,
      text: 'x',
      docFrom: 10 + runIndex,
      docTo: 11 + runIndex,
      ...(runIndex === 4 ? { footnoteRefId: 7 } : {}),
    })),
  };
  const cellParagraphMeasure: ParagraphMetrics = {
    kind: 'paragraph',
    lines: Array.from({ length: 5 }, (_, runIndex) => ({
      ...line(40),
      fromRun: runIndex,
      toRun: runIndex,
    })),
    totalHeight: 200,
  };
  const table: TableBlock = {
    kind: 'table',
    id: 'split-row-table',
    docFrom: 1,
    docTo: 20,
    rows: [{ id: 'split-row', cells: [{ id: 'split-cell', nodes: [cellParagraph] }] }],
  };
  const tableMeasure: TableMetrics = {
    kind: 'table',
    rows: [
      {
        height: 200,
        cells: [{ metrics: [cellParagraphMeasure], width: 180, height: 200 }],
      },
    ],
    columnWidths: [180],
    totalWidth: 180,
    totalHeight: 200,
  };
  const initialLayout = layOutPages([table], [tableMeasure], layoutConfig);
  const refs = collectFootnoteRefs([table], [tableMeasure]);

  expect(
    initialLayout.pages.map((page) =>
      page.fragments.map((fragment) =>
        fragment.kind === 'table'
          ? {
              fromRow: fragment.fromRow,
              toRow: fragment.toRow,
              topClip: fragment.topClip,
              bottomClip: fragment.bottomClip,
            }
          : fragment
      )
    )
  ).toEqual([
    [{ fromRow: 0, toRow: 1, topClip: undefined, bottomClip: 80 }],
    [{ fromRow: 0, toRow: 1, topClip: 120, bottomClip: undefined }],
  ]);
  expect(refs).toEqual([
    expect.objectContaining({
      footnoteId: 7,
      tableNodeId: 'split-row-table',
      rowIndex: 0,
      rowOffset: 180,
      rowHeight: 200,
    }),
  ]);
  expect(mapFootnotesToPages(initialLayout.pages, refs)).toEqual(new Map([[2, [7]]]));

  const footnoteContent: FootnoteContent = {
    id: 7,
    displayNumber: 1,
    nodes: [paragraph('footnote-7', 100)],
    metrics: [paragraphMeasure(1, 20)],
    height: 20,
  };
  const stabilized = stabilizeFootnoteLayout({
    nodes: [table],
    metrics: [tableMeasure],
    layoutConfig,
    footnoteRefs: refs,
    footnoteContentMap: new Map([[7, footnoteContent]]),
    initialLayout,
  });

  expect(stabilized.converged).toBe(true);
  expect(stabilized.pageFootnoteMap).toEqual(new Map([[2, [7]]]));
  expect(stabilized.layout.pages[0].footnoteFragments).toBeUndefined();
  expect(stabilized.layout.pages[1].footnoteFragments?.[0]?.footnoteId).toBe(7);
});

test('maps a nested-table reference after an outer-row split to the continuation page', () => {
  const beforeNested = paragraph('before-nested-table', 10);
  const nestedReference = paragraph('nested-reference', 20, 7);
  const nestedTable: TableBlock = {
    kind: 'table',
    id: 'nested-table',
    docFrom: 18,
    docTo: 25,
    rows: [
      {
        id: 'nested-row',
        cells: [{ id: 'nested-cell', nodes: [nestedReference] }],
      },
    ],
  };
  const nestedTableMeasure: TableMetrics = {
    kind: 'table',
    rows: [
      {
        height: 80,
        cells: [{ metrics: [paragraphMeasure(1)], width: 180, height: 40 }],
      },
    ],
    columnWidths: [180],
    totalWidth: 180,
    totalHeight: 80,
  };
  const outerTable: TableBlock = {
    kind: 'table',
    id: 'outer-split-table',
    docFrom: 1,
    docTo: 30,
    rows: [
      {
        id: 'outer-row',
        cells: [{ id: 'outer-cell', nodes: [beforeNested, nestedTable] }],
      },
    ],
  };
  const outerTableMeasure: TableMetrics = {
    kind: 'table',
    rows: [
      {
        height: 160,
        cells: [
          {
            metrics: [paragraphMeasure(2), nestedTableMeasure],
            width: 180,
            height: 160,
          },
        ],
      },
    ],
    columnWidths: [180],
    totalWidth: 180,
    totalHeight: 160,
  };

  const layout = layOutPages([outerTable], [outerTableMeasure], layoutConfig);
  const refs = collectFootnoteRefs([outerTable], [outerTableMeasure]);

  expect(
    layout.pages.map((page) =>
      page.fragments.map((fragment) =>
        fragment.kind === 'table'
          ? { topClip: fragment.topClip, bottomClip: fragment.bottomClip }
          : fragment
      )
    )
  ).toEqual([[{ topClip: undefined, bottomClip: 80 }], [{ topClip: 80, bottomClip: undefined }]]);
  expect(refs).toEqual([
    expect.objectContaining({
      footnoteId: 7,
      tableNodeId: 'outer-split-table',
      rowIndex: 0,
      rowOffset: 100,
      rowHeight: 160,
    }),
  ]);
  expect(mapFootnotesToPages(layout.pages, refs)).toEqual(new Map([[2, [7]]]));
});

test('footnote page lookup indexes pages once for many references', () => {
  const rawPages: Page[] = Array.from({ length: 200 }, (_, index) => ({
    number: index + 1,
    size: { w: 200, h: 140 },
    margins: layoutConfig.margins,
    fragments: [
      {
        kind: 'paragraph',
        nodeId: `p-${index}`,
        x: 0,
        y: 0,
        width: 180,
        height: 20,
        docFrom: index * 10,
        docTo: index * 10 + 10,
        fromLine: 0,
        toLine: 1,
      },
    ],
  }));
  let numericPageReads = 0;
  const pages = new Proxy(rawPages, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) numericPageReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const refs: FootnoteRefLocation[] = Array.from({ length: 5_000 }, (_, index) => ({
    footnoteId: index,
    pmPos: 1995,
  }));

  const mapped = mapFootnotesToPages(pages, refs);

  expect(mapped.get(200)).toHaveLength(5_000);
  expect(numericPageReads).toBeLessThan(250);
});
