import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { paragraphLayout } from '../flow-model/metrics/paragraphLayout';
import type {
  Page,
  ParagraphBlock,
  ParagraphFragment,
  TableBlock,
  TextBoxBlock,
} from '../pagination-model/types';
import { calculateHeaderFooterVisualBounds } from '../flow-model/headerFooterLayout';
import { paintPage } from './paintPage';
import { renderHeaderFooterContent } from './paintPage/headerFooter';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('anchored object paint parity', () => {
  test('paints a page-anchored topAndBottom image at its resolved band', () => {
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'image-anchor',
      runs: [
        {
          kind: 'image',
          src: '',
          width: 80,
          height: 20,
          displayMode: 'float',
          wrapType: 'topAndBottom',
          distTop: 3,
          distBottom: 5,
          position: {
            horizontal: { relativeTo: 'margin', align: 'center' },
            vertical: { relativeTo: 'page', align: 'center' },
          },
        },
        { kind: 'text', text: 'body text' },
      ],
    };
    const measure = paragraphLayout(block, 300);
    const fragment: ParagraphFragment = {
      kind: 'paragraph',
      nodeId: block.id,
      x: 50,
      y: 50,
      width: 300,
      height: measure.totalHeight,
      fromLine: 0,
      toLine: measure.lines.length,
    };
    const page: Page = {
      number: 1,
      size: { w: 400, h: 120 },
      margins: { top: 10, right: 50, bottom: 10, left: 50 },
      fragments: [fragment],
    };

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        nodeLookup: new Map([[String(block.id), { node: block, metrics: measure }]]),
      }
    );

    const image = painted.querySelector<HTMLElement>('.layout-page-floating-image');
    const line = painted.querySelector<HTMLElement>('.layout-line');
    expect(image?.style.top).toBe('40px');
    expect(line?.style.marginTop).toBe('25px');
  });

  test('uses asymmetric right and bottom margins for body anchors', () => {
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'asymmetric-body-anchor',
      runs: [
        {
          kind: 'image',
          src: '',
          width: 20,
          height: 10,
          displayMode: 'float',
          wrapType: 'square',
          position: {
            horizontal: { relativeTo: 'rightMargin', align: 'center' },
            vertical: { relativeTo: 'bottomMargin', align: 'bottom' },
          },
        },
      ],
    };
    const measure = paragraphLayout(block, 380);
    const page: Page = {
      number: 1,
      size: { w: 500, h: 300 },
      margins: { top: 20, right: 80, bottom: 60, left: 40 },
      fragments: [
        {
          kind: 'paragraph',
          nodeId: block.id,
          x: 40,
          y: 20,
          width: 380,
          height: measure.totalHeight,
          fromLine: 0,
          toLine: measure.lines.length,
        },
      ],
    };

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        nodeLookup: new Map([[String(block.id), { node: block, metrics: measure }]]),
      }
    );

    const image = painted.querySelector<HTMLElement>('.layout-page-floating-image');
    expect(image?.style.left).toBe('410px');
    expect(image?.style.top).toBe('270px');
  });

  test('positions floating header text boxes from positionV like floating images', () => {
    const position = {
      horizontal: { relativeTo: 'page', align: 'left' },
      vertical: { relativeTo: 'page', posOffset: 80 * 9_525 },
    };
    const imageParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'header-image-anchor',
      runs: [
        {
          kind: 'image',
          src: '',
          width: 80,
          height: 20,
          displayMode: 'float',
          wrapType: 'square',
          position,
        },
      ],
    };
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'header-textbox',
      width: 80,
      height: 20,
      content: [],
      displayMode: 'float',
      wrapType: 'square',
      position,
    };

    const painted = renderHeaderFooterContent(
      {
        nodes: [imageParagraph, textBox],
        metrics: [
          { kind: 'paragraph', lines: [], totalHeight: 0 },
          { kind: 'textBox', width: 80, height: 20, innerMetrics: [] },
        ],
        height: 20,
      },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 300 },
      { document },
      {
        flowTop: 20,
        flowLeft: 50,
        contentWidth: 300,
        pageWidth: 400,
        pageHeight: 200,
        margins: { top: 40, right: 50, bottom: 40, left: 50 },
      }
    );

    expect(painted.querySelector('img')?.style.top).toBe('60px');
    expect(painted.querySelector<HTMLElement>('.layout-textbox')?.style.top).toBe('60px');
  });

  test('uses asymmetric right and bottom margins for header/footer anchors', () => {
    const position = {
      horizontal: { relativeTo: 'rightMargin', align: 'center' },
      vertical: { relativeTo: 'bottomMargin', align: 'bottom' },
    };
    const imageParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'asymmetric-header-image',
      runs: [
        {
          kind: 'image',
          src: '',
          width: 20,
          height: 10,
          displayMode: 'float',
          wrapType: 'square',
          position,
        },
      ],
    };
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'asymmetric-header-textbox',
      width: 20,
      height: 10,
      content: [],
      displayMode: 'float',
      wrapType: 'square',
      position,
    };

    const painted = renderHeaderFooterContent(
      {
        nodes: [imageParagraph, textBox],
        metrics: [
          { kind: 'paragraph', lines: [], totalHeight: 0 },
          { kind: 'textBox', width: 20, height: 10, innerMetrics: [] },
        ],
        height: 10,
      },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 380 },
      { document },
      {
        flowTop: 30,
        flowLeft: 40,
        contentWidth: 380,
        pageWidth: 500,
        pageHeight: 300,
        margins: { top: 20, right: 80, bottom: 60, left: 40 },
      }
    );

    const image = painted.querySelector<HTMLElement>('img');
    const paintedTextBox = painted.querySelector<HTMLElement>('.layout-textbox');
    expect(image?.style.left).toBe('410px');
    expect(image?.style.top).toBe('260px');
    expect(paintedTextBox?.style.left).toBe('410px');
    expect(paintedTextBox?.style.top).toBe('260px');
  });

  test('keeps the positioned header image as the sole revision sidebar anchor', () => {
    const imageParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'tracked-header-image',
      runs: [
        {
          kind: 'image',
          src: '',
          width: 20,
          height: 10,
          displayMode: 'float',
          wrapType: 'square',
          position: {
            horizontal: { relativeTo: 'rightMargin', align: 'center' },
            vertical: { relativeTo: 'bottomMargin', align: 'bottom' },
          },
          isInsertion: true,
          changeAuthor: 'Jane',
          changeDate: '2026-07-16T20:00:00Z',
          changeRevisionId: 303,
        },
      ],
    };

    const painted = renderHeaderFooterContent(
      {
        nodes: [imageParagraph],
        metrics: [{ kind: 'paragraph', lines: [], totalHeight: 0 }],
        height: 10,
      },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 380 },
      { document },
      {
        flowTop: 30,
        flowLeft: 40,
        contentWidth: 380,
        pageWidth: 500,
        pageHeight: 300,
        margins: { top: 20, right: 80, bottom: 60, left: 40 },
      }
    );
    const wrapper = painted.querySelector<HTMLElement>('.layout-header-footer-floating-image');
    const anchors = painted.querySelectorAll<HTMLElement>(
      '.docx-insertion[data-revision-id="303"]'
    );
    const image = anchors[0];
    const bar = painted.querySelector<HTMLElement>(
      '.layout-revision-change-bar[data-revision-id="303"]'
    );

    expect(wrapper?.classList.contains('docx-insertion')).toBe(true);
    expect(wrapper?.dataset.revisionId).toBeUndefined();
    expect(anchors).toHaveLength(1);
    expect(image?.tagName).toBe('IMG');
    expect(image?.style.left).toBe('410px');
    expect(image?.style.top).toBe('260px');
    expect(image?.style.width).toBe('20px');
    expect(image?.style.height).toBe('10px');
    expect(bar?.style.top).toBe('260px');
    expect(bar?.style.height).toBe('10px');
  });

  test('positions topAndBottom header text boxes without advancing following content', () => {
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'header-top-and-bottom',
      width: 80,
      height: 20,
      content: [],
      displayMode: 'block',
      wrapType: 'topAndBottom',
      position: {
        horizontal: { relativeTo: 'page', alignment: 'center' },
        vertical: { relativeTo: 'page', posOffset: 80 * 9_525 },
      },
    };
    const followingParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-header-content',
      runs: [],
    };

    const painted = renderHeaderFooterContent(
      {
        nodes: [textBox, followingParagraph],
        metrics: [
          { kind: 'textBox', width: 80, height: 20, innerMetrics: [] },
          { kind: 'paragraph', lines: [], totalHeight: 16 },
        ],
        height: 36,
        flowHeight: 16,
      },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 300 },
      { document },
      {
        flowTop: 20,
        flowLeft: 50,
        contentWidth: 300,
        pageWidth: 400,
        pageHeight: 200,
        margins: { top: 40, right: 50, bottom: 40, left: 50 },
      }
    );

    const paintedTextBox = painted.querySelector<HTMLElement>(
      '[data-block-id="header-top-and-bottom"]'
    );
    const followingContent = painted.querySelector<HTMLElement>(
      '[data-block-id="following-header-content"]'
    );
    expect(paintedTextBox?.style.top).toBe('60px');
    expect(paintedTextBox?.style.left).toBe('110px');
    expect(followingContent?.style.top).toBe('0px');
  });

  test('positions a floating header table without advancing following content', () => {
    const table: TableBlock = {
      kind: 'table',
      id: 'floating-header-table',
      rows: [],
      floating: {
        horzAnchor: 'page',
        vertAnchor: 'page',
        tblpX: 50,
        tblpY: 80,
      },
    };
    const followingParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-floating-table',
      runs: [],
    };

    const painted = renderHeaderFooterContent(
      {
        nodes: [table, followingParagraph],
        metrics: [
          {
            kind: 'table',
            rows: [],
            columnWidths: [100],
            totalWidth: 100,
            totalHeight: 96,
          },
          { kind: 'paragraph', lines: [], totalHeight: 16 },
        ],
        height: 112,
        flowHeight: 16,
      },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 300 },
      { document },
      {
        flowTop: 20,
        flowLeft: 50,
        contentWidth: 300,
        pageWidth: 400,
        pageHeight: 300,
        margins: { top: 40, right: 50, bottom: 40, left: 50 },
      }
    );

    const paintedTable = painted.querySelector<HTMLElement>(
      '[data-block-id="floating-header-table"]'
    );
    const followingContent = painted.querySelector<HTMLElement>(
      '[data-block-id="following-floating-table"]'
    );
    expect(paintedTable?.style.top).toBe('60px');
    expect(paintedTable?.style.left).toBe('0px');
    expect(followingContent?.style.top).toBe('0px');
  });

  test('positions a floating header table revision bar at the resolved table top', () => {
    const table: TableBlock = {
      kind: 'table',
      id: 'tracked-floating-header-table',
      rows: [
        {
          id: 'tracked-row',
          trackedIns: {
            revisionId: 91,
            author: 'Jane',
            date: '2026-07-16T17:00:00Z',
          },
          cells: [{ id: 'tracked-cell', nodes: [] }],
        },
      ],
      floating: {
        horzAnchor: 'page',
        vertAnchor: 'page',
        tblpX: 50,
        tblpY: 80,
      },
    };

    const painted = renderHeaderFooterContent(
      {
        nodes: [table],
        metrics: [
          {
            kind: 'table',
            rows: [{ height: 20, cells: [{ metrics: [], width: 100, height: 20 }] }],
            columnWidths: [100],
            totalWidth: 100,
            totalHeight: 20,
          },
        ],
        height: 20,
        flowHeight: 0,
      },
      { pageNumber: 1, totalPages: 1, section: 'header', contentWidth: 300 },
      { document },
      {
        flowTop: 20,
        flowLeft: 50,
        contentWidth: 300,
        pageWidth: 400,
        pageHeight: 300,
        margins: { top: 40, right: 50, bottom: 40, left: 50 },
      }
    );

    const paintedTable = painted.querySelector<HTMLElement>(
      '[data-block-id="tracked-floating-header-table"]'
    );
    const revisionBar = painted.querySelector<HTMLElement>(
      '.layout-revision-change-bar[data-revision-id="91"]'
    );
    expect(paintedTable?.style.top).toBe('60px');
    expect(revisionBar?.style.top).toBe('60px');
    expect(revisionBar?.style.height).toBe('20px');
  });

  test('keeps a page-relative footer text box at its authored page y', () => {
    const textBox: TextBoxBlock = {
      kind: 'textBox',
      id: 'footer-page-relative',
      width: 80,
      height: 20,
      content: [],
      displayMode: 'float',
      wrapType: 'square',
      position: {
        horizontal: { relativeTo: 'margin', align: 'left' },
        vertical: { relativeTo: 'page', posOffset: 100 * 9_525 },
      },
    };
    const followingParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-footer-content',
      runs: [],
    };
    const nodes = [textBox, followingParagraph];
    const metrics = [
      { kind: 'textBox' as const, width: 80, height: 20, innerMetrics: [] },
      { kind: 'paragraph' as const, lines: [], totalHeight: 16 },
    ];
    const page: Page = {
      number: 1,
      size: { w: 400, h: 300 },
      margins: { top: 40, right: 50, bottom: 70, left: 50, footer: 30 },
      fragments: [],
    };
    const bounds = calculateHeaderFooterVisualBounds(nodes, metrics, 16, {
      section: 'footer',
      pageSize: page.size,
      margins: page.margins,
    });

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        footerDistance: 30,
        footerContent: {
          nodes,
          metrics,
          height: 36,
          flowHeight: 16,
          ...bounds,
        },
      }
    );

    const footer = painted.querySelector<HTMLElement>('.layout-page-footer');
    const content = footer?.firstElementChild as HTMLElement | null;
    const paintedTextBox = footer?.querySelector<HTMLElement>(
      '[data-block-id="footer-page-relative"]'
    );
    const followingContent = footer?.querySelector<HTMLElement>(
      '[data-block-id="following-footer-content"]'
    );
    const pageY =
      parseFloat(footer?.style.top ?? '') +
      parseFloat(content?.style.top ?? '') +
      parseFloat(paintedTextBox?.style.top ?? '');
    const followingPageY =
      parseFloat(footer?.style.top ?? '') +
      parseFloat(content?.style.top ?? '') +
      parseFloat(followingContent?.style.top ?? '');

    expect(bounds).toEqual({ visualTop: -154, visualBottom: 16 });
    expect(pageY).toBe(100);
    expect(followingPageY).toBe(254);
  });

  test('does not clip asymmetric top and bottom margin-relative text boxes', () => {
    const margins = {
      top: 40,
      right: 80,
      bottom: 70,
      left: 30,
      header: 20,
      footer: 30,
    };
    const page: Page = {
      number: 1,
      size: { w: 500, h: 300 },
      margins,
      fragments: [],
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
        vertical: { relativeTo, alignment: 'bottom' },
      },
    });
    const headerTextBox = makeTextBox('header-top-margin', 'topMargin');
    const footerTextBox = makeTextBox('footer-bottom-margin', 'bottomMargin');
    const headerParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-header-margin-content',
      runs: [],
    };
    const footerParagraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'following-footer-margin-content',
      runs: [],
    };
    const metrics = [
      { kind: 'textBox' as const, width: 20, height: 10, innerMetrics: [] },
      { kind: 'paragraph' as const, lines: [], totalHeight: 16 },
    ];
    const headerNodes = [headerTextBox, headerParagraph];
    const footerNodes = [footerTextBox, footerParagraph];
    const headerBounds = calculateHeaderFooterVisualBounds(headerNodes, metrics, 16, {
      section: 'header',
      pageSize: page.size,
      margins,
    });
    const footerBounds = calculateHeaderFooterVisualBounds(footerNodes, metrics, 16, {
      section: 'footer',
      pageSize: page.size,
      margins,
    });

    const painted = paintPage(
      page,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        headerDistance: 20,
        footerDistance: 30,
        headerContent: {
          nodes: headerNodes,
          metrics,
          height: 26,
          flowHeight: 16,
          ...headerBounds,
        },
        footerContent: {
          nodes: footerNodes,
          metrics,
          height: 26,
          flowHeight: 16,
          ...footerBounds,
        },
      }
    );

    const header = painted.querySelector<HTMLElement>('.layout-page-header');
    const footer = painted.querySelector<HTMLElement>('.layout-page-footer');
    const headerContent = header?.firstElementChild as HTMLElement | null;
    const footerContent = footer?.firstElementChild as HTMLElement | null;
    const headerBox = header?.querySelector<HTMLElement>('[data-block-id="header-top-margin"]');
    const footerBox = footer?.querySelector<HTMLElement>('[data-block-id="footer-bottom-margin"]');
    const followingHeader = header?.querySelector<HTMLElement>(
      '[data-block-id="following-header-margin-content"]'
    );
    const followingFooter = footer?.querySelector<HTMLElement>(
      '[data-block-id="following-footer-margin-content"]'
    );
    const resolvedPageY = (
      wrapper: HTMLElement | null | undefined,
      content: HTMLElement | null,
      child: HTMLElement | null | undefined
    ): number =>
      parseFloat(wrapper?.style.top ?? '') +
      parseFloat(content?.style.top ?? '') +
      parseFloat(child?.style.top ?? '');

    expect(headerBounds).toEqual({ visualTop: 0, visualBottom: 20 });
    expect(footerBounds).toEqual({ visualTop: 0, visualBottom: 46 });
    expect(resolvedPageY(header, headerContent, headerBox)).toBe(30);
    expect(resolvedPageY(header, headerContent, followingHeader)).toBe(20);
    expect(resolvedPageY(footer, footerContent, footerBox)).toBe(290);
    expect(resolvedPageY(footer, footerContent, followingFooter)).toBe(254);
    expect(header?.style.overflow).toBe('visible');
    expect(footer?.style.overflow).toBe('');
  });
});
