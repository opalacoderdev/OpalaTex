import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { paintLine } from './renderParagraph';
import type { ImageRun, MeasuredLine, ParagraphBlock } from '../pagination-model/types';
import { getImagePaintGeometry } from '../utils/imagePaintGeometry';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function expectedSpan(run: ImageRun, line: MeasuredLine, runIndex: number, imageOnly: boolean) {
  const paintedWidth = line.atomAdvances?.[runIndex] ?? run.width;
  const geometry = getImagePaintGeometry(run, { paintedWidth });
  const marginTop = geometry.marginTop;
  const marginBottom = geometry.marginBottom;
  const top = imageOnly
    ? (line.lineHeight - geometry.boxHeight - marginTop - marginBottom) / 2 + marginTop
    : line.lineHeight - marginBottom - geometry.boxHeight;
  const visibleTop = Math.max(0, top);
  const visibleBottom = Math.min(line.lineHeight, top + geometry.boxHeight);
  return visibleBottom > visibleTop
    ? { top: visibleTop, height: visibleBottom - visibleTop }
    : null;
}

function trackedImageRun(overrides: Partial<ImageRun> = {}): ImageRun {
  return {
    kind: 'image',
    src: 'data:image/png;base64,AA==',
    width: 80,
    height: 60,
    displayMode: 'inline',
    transform: 'rotate(90deg)',
    isInsertion: true,
    changeRevisionId: 101,
    ...overrides,
  };
}

describe('paintLine inline revision image spans', () => {
  test('reports rotated inline image span from the rotated wrapper on mixed text lines', () => {
    const run = trackedImageRun();
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'mixed-rotated-inline-image',
      runs: [{ kind: 'text', text: 'before ' }, run, { kind: 'text', text: ' after' }],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 2,
      toChar: 6,
      width: 160,
      ascent: 70,
      descent: 20,
      lineHeight: 90,
      atomAdvances: { 1: 80 },
    };
    const spans: Array<{ top: number; height: number }> = [];

    paintLine(block, line, 'left', document, {
      availableWidth: 200,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      onInlineImageRendered: (_image, span) => spans.push(span),
    });

    expect(spans).toEqual([expectedSpan(run, line, 1, false)!]);
  });

  test('reports scaled rotated image-only span with wrap distances and line clipping', () => {
    const run = trackedImageRun({ width: 120, height: 40, distTop: 4, distBottom: 6 });
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'scaled-rotated-inline-image',
      runs: [run],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 60,
      ascent: 40,
      descent: 10,
      lineHeight: 50,
      atomAdvances: { 0: 60 },
    };
    const spans: Array<{ top: number; height: number }> = [];

    paintLine(block, line, 'left', document, {
      availableWidth: 80,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      onInlineImageRendered: (_image, span) => spans.push(span),
    });

    expect(spans).toEqual([expectedSpan(run, line, 0, true)!]);
  });

  test('preserves the no-geometry fast path for fully collapsed inline image spans', () => {
    const run = trackedImageRun({ width: 120, height: 40 });
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'collapsed-rotated-inline-image',
      runs: [run],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 0,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
      atomAdvances: { 0: 0 },
    };
    const spans: Array<{ top: number; height: number }> = [];

    paintLine(block, line, 'left', document, {
      availableWidth: 80,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      onInlineImageRendered: (_image, span) => spans.push(span),
    });

    expect(spans).toEqual([]);
  });
});
