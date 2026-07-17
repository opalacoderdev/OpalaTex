import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { measureTextWidth, resetCanvasContext, toCssFont } from '../textMetrics';

const originalDocument = globalThis.document;
const measuredTexts: string[] = [];
const context = {
  font: '',
  measureText(text: string) {
    measuredTexts.push(text);
    return { width: text.length * 10 };
  },
};

beforeAll(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => context,
      }),
    },
  });
});

beforeEach(() => {
  measuredTexts.length = 0;
  resetCanvasContext();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  });
  resetCanvasContext();
});

describe('caps-aware text measurement', () => {
  test('measures all-caps text using the painted uppercase glyphs', () => {
    expect(measureTextWidth('Abc', { fontFamily: 'Calibri', fontSize: 11, allCaps: true })).toBe(
      30
    );
    expect(measuredTexts).toEqual(['ABC']);
  });

  test('includes small-caps in the canvas font shorthand', () => {
    expect(toCssFont({ fontFamily: 'Times New Roman', fontSize: 12, smallCaps: true })).toContain(
      'small-caps'
    );
  });
});
