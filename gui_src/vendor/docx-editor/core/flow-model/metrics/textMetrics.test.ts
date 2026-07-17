import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { TextRun } from '../../pagination-model/types';
import { paintTextRun } from '../../painter-model/renderParagraph/runs';
import { paragraphLayout } from './paragraphLayout';
import {
  charIndexAtX,
  getXForCharacter,
  graphemeBoundaries,
  measureTextWidth,
  prefixAdvances,
  resetCanvasContext,
  resolveFontStyle,
  type FontStyle,
} from './textMetrics';

const canvasContext = {
  font: '',
  measureText(text: string): TextMetrics {
    return { width: fakeGlyphWidth(text, this.font) } as TextMetrics;
  },
};

let originalGetContext: PropertyDescriptor | undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => canvasContext,
  });
});

afterAll(() => {
  if (originalGetContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext);
  }
  GlobalRegistrator.unregister();
});

beforeEach(() => resetCanvasContext());

const baseStyle: FontStyle = {
  fontFamily: 'Test',
  fontSize: 11,
};

function fakeGlyphWidth(text: string, font: string): number {
  const smallCaps = font.includes('small-caps');
  let width = 0;
  for (const character of Array.from(text)) {
    if (/\p{Mark}/u.test(character) || character === '\u200d') continue;
    if (character === ' ') width += 4;
    else if (/\p{Lu}/u.test(character)) width += 10;
    else if (smallCaps && /\p{Ll}/u.test(character)) width += 8;
    else if (/\p{Ll}/u.test(character)) width += 6;
    else width += 12;
  }
  return width;
}

const widthCases: Array<{
  name: string;
  formatting: Partial<TextRun>;
  expected: number;
}> = [
  { name: 'letterSpacing', formatting: { letterSpacing: 2 }, expected: 16 },
  { name: 'allCaps', formatting: { allCaps: true }, expected: 20 },
  { name: 'smallCaps', formatting: { smallCaps: true }, expected: 16 },
  { name: 'horizontalScale', formatting: { horizontalScale: 150 }, expected: 18 },
];

describe('formatted text width parity', () => {
  for (const { name, formatting, expected } of widthCases) {
    test(`${name} matches measurement, wrap boundary, and painter flow width`, () => {
      const run: TextRun = { kind: 'text', text: 'ab', ...formatting };
      const style = resolveFontStyle(run);
      expect(measureTextWidth(run.text, style)).toBe(expected);

      const wrappingRun: TextRun = { ...run, text: 'abab' };
      const layout = paragraphLayout({ kind: 'paragraph', id: 'p', runs: [wrappingRun] }, expected);
      expect(layout.lines.map((line) => line.toChar)).toEqual([2, 4]);
      expect(layout.lines[0].width).toBe(expected);

      const element = paintTextRun(run, document);
      const cssText =
        element.style.textTransform === 'uppercase'
          ? (element.textContent ?? '').toUpperCase()
          : (element.textContent ?? '');
      const cssFont = element.style.fontVariant === 'small-caps' ? 'small-caps' : '';
      const spacing = Number.parseFloat(element.style.letterSpacing || '0');
      const naturalFlowWidth =
        fakeGlyphWidth(cssText, cssFont) + (graphemeBoundaries(cssText).length - 1) * spacing;
      const flowWidth = naturalFlowWidth + Number.parseFloat(element.style.marginRight || '0');
      expect(flowWidth).toBeCloseTo(expected, 6);
    });
  }
});

describe('formatted prefix advances and caret hit testing', () => {
  test('uses transformed, tracked, and scaled prefixes consistently', () => {
    const style: FontStyle = {
      ...baseStyle,
      allCaps: true,
      letterSpacing: 2,
      horizontalScale: 150,
    };

    expect(prefixAdvances('ab', style)).toEqual([18, 36]);
    expect(charIndexAtX('ab', style, 10)).toBe(1);
    expect(getXForCharacter('ab', style, 1)).toBe(18);
  });
});

describe('grapheme-safe advances, carets, and forced wrapping', () => {
  const graphemes = [
    { name: 'combining mark', text: 'e\u0301' },
    { name: 'flag', text: '🇵🇱' },
    { name: 'ZWJ emoji', text: '👩‍👩‍👧‍👦' },
  ];

  for (const { name, text } of graphemes) {
    test(`${name} remains indivisible`, () => {
      const boundaries = graphemeBoundaries(text);
      expect(boundaries).toEqual([0, text.length]);

      const width = measureTextWidth(text, baseStyle);
      const advances = prefixAdvances(text, baseStyle);
      expect(advances).toHaveLength(text.length);
      expect(advances.slice(0, -1).every((advance) => advance === 0)).toBe(true);
      expect(advances[advances.length - 1]).toBe(width);
      expect(charIndexAtX(text, baseStyle, width * 0.25)).toBe(0);
      expect(charIndexAtX(text, baseStyle, width * 0.75)).toBe(text.length);
      expect(getXForCharacter(text, baseStyle, 1)).toBe(0);

      const layout = paragraphLayout(
        { kind: 'paragraph', id: 'p', runs: [{ kind: 'text', text: `${text}${text}` }] },
        width
      );
      expect(layout.lines.map((line) => line.toChar)).toEqual([text.length, text.length * 2]);
    });
  }

  test('fallback segmentation preserves combining, flag, and ZWJ clusters', () => {
    const intl = Intl as unknown as { Segmenter?: unknown };
    const originalSegmenter = intl.Segmenter;
    intl.Segmenter = undefined;
    try {
      for (const { text } of graphemes) {
        expect(graphemeBoundaries(text)).toEqual([0, text.length]);
      }
    } finally {
      intl.Segmenter = originalSegmenter;
    }
  });
});
