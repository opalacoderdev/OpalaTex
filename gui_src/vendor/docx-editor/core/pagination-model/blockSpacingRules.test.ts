import { describe, expect, test } from 'bun:test';
import { collapsedGap, bordersFormGroup } from './blockSpacingRules';
import { layOutPages } from './pageComposer';
import type {
  ParagraphBlock,
  ParagraphMetrics,
  ParagraphBorders,
  ParagraphFragment,
} from './types';

const LINE = 20;

function paragraph(id: string, attrs?: ParagraphBlock['attrs']): ParagraphBlock {
  return { kind: 'paragraph', id, runs: [{ kind: 'text', text: id }], attrs };
}

function paragraphMetrics(lines = 1): ParagraphMetrics {
  return {
    kind: 'paragraph',
    totalHeight: lines * LINE,
    lines: Array.from({ length: lines }, (_, index) => ({
      fromRun: 0,
      fromChar: index,
      toRun: 0,
      toChar: index + 1,
      width: 20,
      ascent: 15,
      descent: 5,
      lineHeight: LINE,
    })),
  };
}

/** The callout-box shape: full box border with a `w:space` inset, in px. */
function boxBorders(color: string, width = 1, space = 5): ParagraphBorders {
  const edge = { style: 'solid', width, color, space };
  return { top: edge, bottom: edge, left: edge, right: edge };
}

describe('collapsedGap spacing collapse', () => {
  test('adjacent spacing collapses to the larger value', () => {
    const prev = paragraph('a', { spacing: { after: 13 } });
    const next = paragraph('b', { spacing: { before: 5 } });
    expect(collapsedGap(prev, next)).toBe(13);
  });

  test('top of flow uses spacing.before alone', () => {
    expect(collapsedGap(null, paragraph('b', { spacing: { before: 7 } }))).toBe(7);
  });
});

describe('paragraph border flow height (§17.3.1.24)', () => {
  test('borders with different colors keep the spacing gap PLUS both border extents', () => {
    // Two boxed callouts (e.g. INFO / WARNING with different border colors):
    // Word draws prev's bottom rule and next's top rule inside the gap, each
    // `w:space` px away from its text. The flow gap must grow by rule + inset
    // on both sides or the boxes paint into the spacing and visually touch.
    const prev = paragraph('info', {
      spacing: { after: 13 },
      borders: boxBorders('#2E75B6', 1, 5),
    });
    const next = paragraph('warning', {
      spacing: { before: 0 },
      borders: boxBorders('#CC6600', 1, 5),
    });
    expect(collapsedGap(prev, next)).toBe(13 + (1 + 5) + (1 + 5));
  });

  test('identical borders form a group — no boundary extents inside the box', () => {
    const borders = boxBorders('#2E75B6', 1, 5);
    const prev = paragraph('a', { spacing: { after: 13 }, borders });
    const next = paragraph('b', { borders });
    expect(bordersFormGroup(borders, borders)).toBe(true);
    expect(collapsedGap(prev, next)).toBe(13);
  });

  test('only the drawn edges count: bottom-only prev, borderless next', () => {
    const prev = paragraph('rule', {
      spacing: { after: 10 },
      borders: { bottom: { style: 'solid', width: 2, color: '#000', space: 3 } },
    });
    const next = paragraph('plain');
    expect(collapsedGap(prev, next)).toBe(10 + 2 + 3);
  });

  test('borderless neighbours are unaffected', () => {
    const prev = paragraph('a', { spacing: { after: 10 } });
    const next = paragraph('b');
    expect(collapsedGap(prev, next)).toBe(10);
  });

  test('composed pages separate boxed callouts by spacing + extents', () => {
    const blocks = [
      paragraph('info', { spacing: { after: 13 }, borders: boxBorders('#2E75B6') }),
      paragraph('warning', { spacing: { after: 13 }, borders: boxBorders('#CC6600') }),
    ];
    const layout = layOutPages(blocks, [paragraphMetrics(), paragraphMetrics()], {
      pageSize: { w: 816, h: 1056 },
      margins: { top: 96, right: 96, bottom: 96, left: 96 },
    });
    const frags = layout.pages[0].fragments.filter(
      (f): f is ParagraphFragment => f.kind === 'paragraph'
    );
    expect(frags).toHaveLength(2);
    // 13px collapsed spacing + (1+5) bottom extent + (1+5) top extent
    expect(frags[1].y - (frags[0].y + frags[0].height)).toBe(25);
  });
});
