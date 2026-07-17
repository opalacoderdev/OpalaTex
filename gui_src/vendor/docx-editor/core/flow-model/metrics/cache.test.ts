import { describe, expect, test } from 'bun:test';

import type { ImageRun, ParagraphBlock } from '../../pagination-model/types';
import { paragraphCacheKey } from './cache';

function imageParagraph(overrides: Partial<ImageRun> = {}): ParagraphBlock {
  return {
    kind: 'paragraph',
    id: 'cache-image-paragraph',
    runs: [
      {
        kind: 'image',
        src: 'data:image/png;base64,AA==',
        width: 80,
        height: 60,
        displayMode: 'inline',
        wrapType: 'inline',
        ...overrides,
      },
    ],
  };
}

describe('paragraphCacheKey', () => {
  test('changes when inline image transform changes', () => {
    const base = paragraphCacheKey(imageParagraph(), 180);
    const rotated = paragraphCacheKey(imageParagraph({ transform: 'rotate(90deg)' }), 180);

    expect(rotated).not.toBe(base);
  });

  test('changes when inline image wrap distances change', () => {
    const base = paragraphCacheKey(imageParagraph(), 180);
    const distTop = paragraphCacheKey(imageParagraph({ distTop: 4 }), 180);
    const distBottom = paragraphCacheKey(imageParagraph({ distBottom: 6 }), 180);

    expect(distTop).not.toBe(base);
    expect(distBottom).not.toBe(base);
  });
});
