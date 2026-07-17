import { describe, expect, test } from 'bun:test';
import { semanticDigest } from './semanticDigest';

describe('semanticDigest', () => {
  test('is deterministic across object, map, and set insertion order', () => {
    const first = {
      z: new Set([3, 1, 2]),
      a: new Map([
        ['footer', { text: 'same' }],
        ['header', { text: 'same' }],
      ]),
    };
    const second = {
      a: new Map([
        ['header', { text: 'same' }],
        ['footer', { text: 'same' }],
      ]),
      z: new Set([2, 3, 1]),
    };

    expect(semanticDigest(first)).toBe(semanticDigest(second));
  });

  test('invalidates every paint-relevant semantic class with unchanged geometry', () => {
    const base = {
      kind: 'paragraph',
      id: 'box-1',
      runs: [
        {
          kind: 'text',
          text: 'alpha',
          docFrom: 1,
          docTo: 6,
          commentIds: [1],
          changeRevisionId: 4,
        },
        {
          kind: 'image',
          src: 'data:image/png;base64,AAAA',
          width: 24,
          height: 24,
          docFrom: 6,
          docTo: 7,
        },
      ],
    };
    const measure = {
      kind: 'paragraph',
      totalHeight: 20,
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 1,
          toChar: 1,
          width: 100,
          ascent: 12,
          descent: 4,
          lineHeight: 20,
        },
      ],
    };
    const digest = semanticDigest(base, measure);

    const variants = [
      { ...base, runs: [{ ...base.runs[0], text: 'omega' }, base.runs[1]] },
      { ...base, runs: [{ ...base.runs[0], bold: true }, base.runs[1]] },
      { ...base, runs: [{ ...base.runs[0], commentIds: [2] }, base.runs[1]] },
      { ...base, runs: [{ ...base.runs[0], changeRevisionId: 5 }, base.runs[1]] },
      {
        ...base,
        runs: [base.runs[0], { ...base.runs[1], src: 'data:image/png;base64,BBBB' }],
      },
    ];

    for (const variant of variants) {
      expect(semanticDigest(variant, measure)).not.toBe(digest);
    }
  });
});
