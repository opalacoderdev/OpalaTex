import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EditorView } from 'prosemirror-view';
import type {
  ContentNode,
  LayoutMetrics,
  ParagraphBlock,
  TextBoxBlock,
} from '../pagination-model/types';
import { schema } from '../prosemirror/schema';
import { extendMarginsForHeaderFooter } from './headerFooterMargins';
import {
  calculateHeaderFooterVisualBounds,
  computeHfCaretRectFromView,
  contributesToHeaderFooterFlowHeight,
  convertHeaderFooterPmDocToContent,
  invalidateHfDomCache,
} from './headerFooterLayout';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('header/footer overlay story scoping', () => {
  test('resolves the caret only against hosts for the active relationship', () => {
    document.body.replaceChildren();
    for (const [rId, left] of [
      ['rId-first', 10],
      ['rId-second', 200],
    ] as const) {
      const host = document.createElement('div');
      host.className = 'layout-page-header';
      host.dataset.hfRId = rId;
      const ranged = document.createElement('div');
      ranged.dataset.docFrom = '0';
      ranged.dataset.docTo = '5';
      ranged.getBoundingClientRect = () =>
        ({ top: 20, left, right: left + 50, bottom: 40, width: 50, height: 20 }) as DOMRect;
      host.appendChild(ranged);
      document.body.appendChild(host);
    }

    const view = {
      state: { selection: { empty: true, head: 1 } },
    } as unknown as EditorView;
    invalidateHfDomCache();

    expect(computeHfCaretRectFromView(view, 'header', document, 'rId-second')).toEqual({
      top: 20,
      left: 201,
      height: 20,
    });
  });
});

describe('header/footer positioned text-box layout', () => {
  test('keeps a page-positioned topAndBottom box out of following header flow', () => {
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'header-top-and-bottom',
      width: 80,
      height: 20,
      content: [],
      displayMode: 'block',
      wrapType: 'topAndBottom',
      position: {
        vertical: { relativeTo: 'page', posOffset: 80 * 9_525 },
      },
    };
    const followingParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-header-content',
      runs: [],
    };

    expect(contributesToHeaderFooterFlowHeight(textBox)).toBe(false);
    expect(contributesToHeaderFooterFlowHeight(followingParagraph)).toBe(true);
    expect(
      calculateHeaderFooterVisualBounds(
        [textBox, followingParagraph],
        [
          { kind: 'textBox', width: 80, height: 20, innerMetrics: [] },
          { kind: 'paragraph', lines: [], totalHeight: 70 },
        ],
        70,
        {
          section: 'header',
          pageSize: { w: 400, h: 200 },
          margins: { top: 40, right: 50, bottom: 40, left: 50, header: 20 },
        }
      )
    ).toEqual({ visualTop: 0, visualBottom: 80 });
  });

  test('uses the in-flow footer height for a page-relative text box', () => {
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'footer-page-relative',
      width: 80,
      height: 20,
      content: [],
      displayMode: 'float',
      wrapType: 'square',
      position: {
        vertical: { relativeTo: 'page', posOffset: 100 * 9_525 },
      },
    };
    const followingParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-footer-content',
      runs: [],
    };

    expect(
      calculateHeaderFooterVisualBounds(
        [textBox, followingParagraph],
        [
          { kind: 'textBox', width: 80, height: 20, innerMetrics: [] },
          { kind: 'paragraph', lines: [], totalHeight: 16 },
        ],
        16,
        {
          section: 'footer',
          pageSize: { w: 400, h: 300 },
          margins: { top: 40, right: 50, bottom: 70, left: 50, footer: 30 },
        }
      )
    ).toEqual({ visualTop: -154, visualBottom: 16 });
  });

  test('resolves asymmetric top and bottom margin anchor bands', () => {
    const followingParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-margin-content',
      runs: [],
    };
    const makeTextBox = (id: string, relativeTo: 'topMargin' | 'bottomMargin'): TextBoxBlock => ({
      kind: 'textBox',
      id,
      width: 20,
      height: 10,
      content: [],
      displayMode: 'float',
      wrapType: 'square',
      position: {
        vertical: { relativeTo, align: 'bottom' },
      },
    });
    const metrics = [
      { kind: 'textBox' as const, width: 20, height: 10, innerMetrics: [] },
      { kind: 'paragraph' as const, lines: [], totalHeight: 16 },
    ];
    const margins = { top: 40, right: 80, bottom: 70, left: 30, header: 20, footer: 30 };

    expect(
      calculateHeaderFooterVisualBounds(
        [makeTextBox('header-top-margin', 'topMargin'), followingParagraph],
        metrics,
        16,
        {
          section: 'header',
          pageSize: { w: 500, h: 300 },
          margins,
        }
      )
    ).toEqual({ visualTop: 0, visualBottom: 20 });

    expect(
      calculateHeaderFooterVisualBounds(
        [makeTextBox('footer-bottom-margin', 'bottomMargin'), followingParagraph],
        metrics,
        16,
        {
          section: 'footer',
          pageSize: { w: 500, h: 300 },
          margins,
        }
      )
    ).toEqual({ visualTop: 0, visualBottom: 46 });
  });
});

describe('header/footer floating-table layout', () => {
  test('keeps a floating table out of header and footer body-margin flow', () => {
    const cellParagraph = schema.nodes.paragraph.create();
    const cell = schema.nodes.tableCell.create({}, cellParagraph);
    const row = schema.nodes.tableRow.create({}, cell);
    const table = schema.nodes.table.create(
      {
        columnWidths: [1_500],
        floating: {
          horzAnchor: 'page',
          vertAnchor: 'page',
          tblpX: 0,
          tblpY: 1_200,
        },
      },
      row
    );
    const followingParagraph = schema.nodes.paragraph.create(
      {},
      schema.text('following header/footer paragraph')
    );
    const pmDoc = schema.nodes.doc.create({}, [table, followingParagraph]);
    const measureBlocks = (nodes: ContentNode[]): LayoutMetrics[] =>
      nodes.map((block) => {
        if (block.kind === 'table') {
          return {
            kind: 'table',
            rows: [],
            columnWidths: [100],
            totalWidth: 100,
            totalHeight: 96,
          };
        }
        if (block.kind === 'paragraph') {
          return { kind: 'paragraph', lines: [], totalHeight: 16 };
        }
        throw new Error(`Unexpected header/footer block: ${block.kind}`);
      });
    const pageSize = { w: 400, h: 300 };
    const margins = {
      top: 40,
      right: 50,
      bottom: 40,
      left: 50,
      header: 20,
      footer: 20,
    };
    const header = convertHeaderFooterPmDocToContent(
      pmDoc,
      300,
      {
        section: 'header',
        pageSize,
        margins,
      },
      {
        measureBlocks,
      }
    );
    const footer = convertHeaderFooterPmDocToContent(
      pmDoc,
      300,
      {
        section: 'footer',
        pageSize,
        margins,
      },
      {
        measureBlocks,
      }
    );

    expect(header?.nodes[0]?.kind).toBe('table');
    expect(header?.nodes[0] && contributesToHeaderFooterFlowHeight(header.nodes[0])).toBe(false);
    expect(header?.flowHeight).toBe(16);
    expect(footer?.flowHeight).toBe(16);
    // The page-positioned table contributes to visual bounds at its authored
    // Y, while the following paragraph remains at the zero story cursor.
    expect({ visualTop: header?.visualTop, visualBottom: header?.visualBottom }).toEqual({
      visualTop: 0,
      visualBottom: 156,
    });
    expect({ visualTop: footer?.visualTop, visualBottom: footer?.visualBottom }).toEqual({
      visualTop: -184,
      visualBottom: 16,
    });

    const extended = extendMarginsForHeaderFooter({
      pageSize,
      margins,
      finalMargins: margins,
      headers: [header],
      footers: [footer],
    });
    expect(extended).toEqual({ margins, finalMargins: margins });
  });
});
