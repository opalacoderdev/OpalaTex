/**
 * Regression test for #729 — a numbered list whose direct paragraph indent has
 * `hanging` greater than `left` must hang its marker into the left margin (as
 * Word does), not clamp it to the content edge.
 *
 * The marker line keeps `text-indent: 0` (Chrome folds a negative text-indent
 * into the marker inline-block and breaks its min-width slot), so the hang
 * comes from padding-left. CSS padding can't be negative, so when
 * `left - hanging < 0` the negative portion rides on the marker's own
 * `margin-left` — without it the old `Math.max(0, left - hanging)` clamp pinned
 * the marker to the content edge, shifting the numbers right of the text above.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { paintParagraphFragment } from '../renderParagraph';
import type {
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMetrics,
} from '../../pagination-model/types';
import type { RenderContext } from '../paintPage';
import {
  measureRun,
  measureTextWidth,
  resetCanvasContext,
} from '../../flow-model/metrics/textMetrics';
import { paragraphLayout } from '../../flow-model/metrics/paragraphLayout';
import { getListMarkerInlineWidth } from '../../flow-model/metrics/listMarkerWidth';
import { resolveParagraphFirstLineGeometry } from '../../flow-model/metrics/paragraphFirstLineGeometry';

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext | undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(type: string) {
    if (type === '2d') {
      return {
        font: '',
        measureText: (text: string) => ({ width: text.length * 4 }),
      } as unknown as CanvasRenderingContext2D;
    }
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;
  resetCanvasContext();
});

afterAll(() => {
  if (originalGetContext) HTMLCanvasElement.prototype.getContext = originalGetContext;
  resetCanvasContext();
  GlobalRegistrator.unregister();
});

const ctx: RenderContext = { pageNumber: 1, totalPages: 1, section: 'body' };

function renderListItem(indent: { left: number; hanging: number }): HTMLElement {
  const block: ParagraphBlock = {
    kind: 'paragraph',
    id: 'p1',
    runs: [{ kind: 'text', text: 'TEST1' }],
    attrs: {
      numPr: { numId: 2, ilvl: 0 },
      listMarker: '1.',
      indent,
    },
  };
  const measure: ParagraphMetrics = {
    kind: 'paragraph',
    lines: [
      {
        fromRun: 0,
        fromChar: 0,
        toRun: 0,
        toChar: 5,
        width: 40,
        ascent: 10,
        descent: 3,
        lineHeight: 14,
      },
    ],
    totalHeight: 14,
  };
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    nodeId: 'p1',
    x: 0,
    y: 0,
    width: 400,
    height: 14,
    fromLine: 0,
    toLine: 1,
  };
  return paintParagraphFragment(fragment, block, measure, ctx);
}

function renderJustifiedLongListItem(): HTMLElement {
  const block: ParagraphBlock = {
    kind: 'paragraph',
    id: 'long-list',
    runs: [
      { kind: 'text', text: 'A long justified first line ', bold: true },
      { kind: 'text', text: 'split across tracked-style run boundaries' },
      { kind: 'text', text: ' before wrapping.' },
    ],
    attrs: {
      alignment: 'justify',
      numPr: { numId: 2, ilvl: 0 },
      listMarker: '1.',
      indent: { left: 96, right: 24, hanging: 48 },
    },
  };
  const measure: ParagraphMetrics = {
    kind: 'paragraph',
    lines: [
      {
        fromRun: 0,
        fromChar: 0,
        toRun: 1,
        toChar: 41,
        width: 590,
        ascent: 10,
        descent: 3,
        lineHeight: 14,
      },
      {
        fromRun: 2,
        fromChar: 0,
        toRun: 2,
        toChar: 17,
        width: 100,
        ascent: 10,
        descent: 3,
        lineHeight: 14,
      },
    ],
    totalHeight: 28,
  };
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    nodeId: 'long-list',
    x: 0,
    y: 0,
    width: 713,
    height: 14,
    fromLine: 0,
    toLine: 1,
  };
  return paintParagraphFragment(fragment, block, measure, ctx);
}

function measureAndRender(
  block: ParagraphBlock,
  width: number
): { element: HTMLElement; measure: ParagraphMetrics } {
  const measure = paragraphLayout(block, width);
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    nodeId: block.id,
    x: 0,
    y: 0,
    width,
    height: measure.totalHeight,
    fromLine: 0,
    toLine: measure.lines.length,
  };
  return {
    element: paintParagraphFragment(fragment, block, measure, ctx),
    measure,
  };
}

function styledOuterWidth(lineEl: HTMLElement): number {
  return (
    parseFloat(lineEl.style.width || '0') +
    parseFloat(lineEl.style.paddingLeft || '0') +
    parseFloat(lineEl.style.paddingRight || '0')
  );
}

function marker(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>('[class*="marker"]');
}
function line(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>('.layout-line')!;
}

describe('Issue #729 — list hanging indent exceeding left indent', () => {
  test('hanging > left: marker hangs into the margin via negative margin-left', () => {
    // 15px left, 38px hanging — marker should start at 15 - 38 = -23px.
    const el = renderListItem({ left: 15, hanging: 38 });
    const m = marker(el);
    expect(m).not.toBeNull();
    expect(parseFloat(m!.style.marginLeft)).toBeCloseTo(-23, 1);
    // padding clamps to 0 (can't be negative); text-indent stays 0.
    expect(line(el).style.paddingLeft).toBe('0px');
    expect(line(el).style.textIndent).toBe('0px');
  });

  test('hanging <= left: existing path unchanged (padding, no marker margin)', () => {
    // 48px left, 24px hanging — marker starts at 48 - 24 = 24px via padding.
    const el = renderListItem({ left: 48, hanging: 24 });
    const m = marker(el);
    expect(m!.style.marginLeft).toBe('');
    expect(line(el).style.paddingLeft).toBe('24px');
    expect(line(el).style.textIndent).toBe('0px');
  });

  test('left == 0 with hanging: no negative margin (continuation lines sit at hanging)', () => {
    // Gating on indentLeft > 0 avoids misaligning the first line with the
    // continuation lines, which the body-line branch places at `hanging`.
    const el = renderListItem({ left: 0, hanging: 24 });
    const m = marker(el);
    expect(m!.style.marginLeft).toBe('');
    expect(line(el).style.paddingLeft).toBe('0px');
  });

  test('justified first line uses marker slot plus measured text width', () => {
    const el = renderJustifiedLongListItem();
    const firstLine = line(el);

    // The content box spans x=48 through x=689; its 48px marker leaves 593px
    // for text. Padding sits outside it, so the full line still spans 713px.
    expect(firstLine.style.boxSizing).toBe('content-box');
    expect(firstLine.style.paddingLeft).toBe('48px');
    expect(firstLine.style.width).toBe('641px');
    expect(marker(el)!.style.minWidth).toBe('48px');
    expect(firstLine.style.textAlign).toBe('justify');
    expect(firstLine.querySelectorAll('.layout-run')).toHaveLength(2);
  });

  test('measure + paint clamps the line box when the marker starts before x=0', () => {
    const width = 400;
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'negative-marker-start',
      runs: [{ kind: 'text', text: 'word '.repeat(120) }],
      attrs: {
        alignment: 'justify',
        listMarker: '1.',
        listMarkerSuffix: 'nothing',
        indent: { left: 15, right: 10, hanging: 38 },
      },
    };
    const markerWidth = getListMarkerInlineWidth(block);
    const geometry = resolveParagraphFirstLineGeometry(width, block.attrs?.indent, markerWidth);
    const { element, measure } = measureAndRender(block, width);
    const firstLine = line(element);

    expect(measure.lines.length).toBeGreaterThan(1);
    expect(measure.lines[0].width).toBeLessThanOrEqual(geometry.textWidth);
    expect(geometry.markerStart).toBe(-23);
    expect(geometry.painterLineWidth).toBe(390);
    expect(firstLine.style.width).toBe('390px');
    expect(marker(element)!.style.marginLeft).toBe('-23px');
    expect(styledOuterWidth(firstLine)).toBe(width);
  });

  test('measure + paint reserves a marker wider than its hanging slot', () => {
    const width = 400;
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'wide-marker',
      runs: [{ kind: 'text', text: 'word '.repeat(120) }],
      attrs: {
        alignment: 'justify',
        listMarker: '1234567890.',
        listMarkerSuffix: 'tab',
        defaultTabMarkTwips: 720,
        indent: { left: 40, right: 10, hanging: 20 },
      },
    };
    const markerWidth = getListMarkerInlineWidth(block);
    const geometry = resolveParagraphFirstLineGeometry(width, block.attrs?.indent, markerWidth);
    const { element, measure } = measureAndRender(block, width);
    const firstLine = line(element);

    expect(markerWidth).toBe(76);
    expect(markerWidth).toBeGreaterThan(block.attrs!.indent!.hanging!);
    expect(measure.lines[0].width).toBeLessThanOrEqual(geometry.textWidth);
    expect(marker(element)!.style.minWidth).toBe('76px');
    expect(styledOuterWidth(firstLine)).toBe(width);

    const ordinary: ParagraphBlock = {
      ...block,
      attrs: {
        ...block.attrs,
        listMarker: '1.',
        indent: { left: 96, right: 10, hanging: 48 },
      },
    };
    expect(getListMarkerInlineWidth(ordinary)).toBe(48);
  });

  test('measure + paint wraps tracked fragmented letter-spaced runs within the line box', () => {
    const width = 200;
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'tracked-fragments',
      runs: [
        { kind: 'text', text: 'alpha' },
        { kind: 'text', text: ' ', letterSpacing: 7, isDeletion: true },
        { kind: 'text', text: 'beta '.repeat(30), letterSpacing: 2 },
      ],
      attrs: {
        alignment: 'justify',
        listMarker: '1.',
        listMarkerSuffix: 'nothing',
        indent: { left: 36, right: 8, hanging: 18 },
      },
    };
    const markerWidth = getListMarkerInlineWidth(block);
    const geometry = resolveParagraphFirstLineGeometry(width, block.attrs?.indent, markerWidth);
    const { element, measure } = measureAndRender(block, width);
    const firstLine = line(element);

    expect(measure.lines.length).toBeGreaterThan(1);
    expect(measure.lines[0].width).toBeLessThanOrEqual(geometry.textWidth);
    expect(firstLine.querySelector('.docx-deletion')).not.toBeNull();
    expect(styledOuterWidth(firstLine)).toBe(width);
  });

  test('measures trailing letter spacing on fragmented one-character runs', () => {
    const plainStyle = { fontFamily: 'Times New Roman', fontSize: 12 };
    const spacedStyle = { ...plainStyle, letterSpacing: 7 };
    const plainWidth = measureTextWidth(' ', plainStyle);
    const spacedWidth = measureTextWidth(' ', spacedStyle);
    const measuredRun = measureRun(' ', spacedStyle);

    expect(spacedWidth - plainWidth).toBeCloseTo(7, 4);
    expect(measuredRun.charWidths[0] - plainWidth).toBeCloseTo(7, 4);
  });
});
