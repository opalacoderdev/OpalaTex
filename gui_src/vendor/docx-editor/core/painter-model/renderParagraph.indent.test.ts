import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { paragraphLayout } from '../flow-model/metrics/paragraphLayout';
import type { ImageRun, ParagraphBlock, ParagraphFragment } from '../pagination-model/types';
import { paintParagraphFragment } from './renderParagraph';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function inlineImage(index: number): ImageRun {
  return {
    kind: 'image',
    src: '',
    width: 30,
    height: 10,
    displayMode: 'inline',
    docFrom: index,
    docTo: index + 1,
  };
}

describe('zero-left hanging indent parity', () => {
  test('metrics and paints only the first line with the negative hanging offset', () => {
    const measuredBlock: ParagraphBlock = {
      kind: 'paragraph',
      id: 'hanging',
      attrs: { indent: { left: 0, hanging: 20 } },
      runs: [inlineImage(1), inlineImage(2), inlineImage(3), inlineImage(4)],
    };
    const measured = paragraphLayout(measuredBlock, 50);

    // The first line starts at -20px and therefore has 70px available, while
    // continuation lines remain at x=0 with the original 50px width.
    expect(measured.lines.map((line) => [line.fromRun, line.toRun])).toEqual([
      [0, 1],
      [2, 2],
      [3, 3],
    ]);

    const paintedBlock: ParagraphBlock = {
      kind: 'paragraph',
      id: 'hanging-text',
      attrs: { indent: { left: 0, hanging: 20 } },
      runs: [
        { kind: 'text', text: 'first' },
        { kind: 'lineBreak' },
        { kind: 'text', text: 'second' },
      ],
    };
    const paintedMeasure = paragraphLayout(paintedBlock, 50);
    const fragment: ParagraphFragment = {
      kind: 'paragraph',
      nodeId: paintedBlock.id,
      x: 0,
      y: 0,
      width: 50,
      height: paintedMeasure.totalHeight,
      fromLine: 0,
      toLine: paintedMeasure.lines.length,
    };
    const painted = paintParagraphFragment(
      fragment,
      paintedBlock,
      paintedMeasure,
      { pageNumber: 1, totalPages: 1, section: 'body', contentWidth: 50 },
      { document }
    );
    const lines = painted.querySelectorAll<HTMLElement>('.layout-line');

    expect(lines).toHaveLength(2);
    expect(lines[0].style.textIndent).toBe('-20px');
    expect(lines[0].style.paddingLeft).toBe('');
    expect(lines[1].style.textIndent).toBe('');
    expect(lines[1].style.paddingLeft).toBe('');
  });
});
