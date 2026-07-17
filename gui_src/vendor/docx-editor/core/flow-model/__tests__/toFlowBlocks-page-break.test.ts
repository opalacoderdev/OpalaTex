import { describe, expect, test } from 'bun:test';
import type { ParagraphBlock } from '../../pagination-model/types';
import { paragraphLayout } from '../metrics/paragraphLayout';
import { schema } from '../../prosemirror/schema';
import { buildBoxTree } from '../buildBoxTree';

describe('buildBoxTree — page-break paragraphs', () => {
  test('turns empty pageBreakBefore paragraphs into structural page breaks', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Before')]),
      schema.node('paragraph', { pageBreakBefore: true }, []),
      schema.node('paragraph', null, [schema.text('After')]),
    ]);

    const blocks = buildBoxTree(doc, {});

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
  });

  test('keeps an empty continuous-section carrier as a zero-height PM anchor', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', {
        sectionBreakType: 'continuous',
        _sectionProperties: { sectionStart: 'continuous' },
      }),
    ]);
    const blocks = buildBoxTree(doc, {});
    const carrier = blocks[0] as ParagraphBlock;

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'sectionBreak']);
    expect(carrier.docFrom).toBe(0);
    expect(carrier.docTo).toBe(2);
    expect(carrier.attrs?.suppressEmptyParagraphHeight).toBe(true);
    expect(paragraphLayout(carrier, 600).totalHeight).toBe(0);
  });

  test('keeps next/even/odd-page section carriers visible and structural', () => {
    for (const type of ['nextPage', 'evenPage', 'oddPage'] as const) {
      const doc = schema.node('doc', null, [
        schema.node('paragraph', {
          sectionBreakType: type,
          _sectionProperties: { sectionStart: type },
        }),
      ]);
      const blocks = buildBoxTree(doc);
      expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'sectionBreak']);
      expect((blocks[0] as ParagraphBlock).attrs?.suppressEmptyParagraphHeight).toBeUndefined();
      expect(paragraphLayout(blocks[0] as ParagraphBlock, 600).totalHeight).toBeGreaterThan(0);
    }
  });

  test('keeps a deleted section carrier reviewable without applying its section break', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', {
        sectionBreakType: 'nextPage',
        _sectionProperties: { sectionStart: 'nextPage' },
        pPrDel: { revisionId: 804, author: 'Author', date: null },
      }),
    ]);
    const blocks = buildBoxTree(doc);
    const carrier = blocks[0] as ParagraphBlock;

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph']);
    expect(carrier.attrs?.pPrDel?.revisionId).toBe(804);
    expect(carrier.attrs?.suppressEmptyParagraphHeight).toBe(true);
    expect(paragraphLayout(carrier, 600).totalHeight).toBe(0);
  });

  test('collapses ordinary revision-only empty paragraphs', () => {
    for (const revisionAttrs of [
      { pPrIns: { revisionId: 1, author: 'Author', date: null } },
      { pPrDel: { revisionId: 2, author: 'Author', date: null } },
    ]) {
      const doc = schema.node('doc', null, [schema.node('paragraph', revisionAttrs)]);
      const paragraph = buildBoxTree(doc)[0] as ParagraphBlock;
      expect(paragraph.attrs?.suppressEmptyParagraphHeight).toBe(true);
      expect(paragraphLayout(paragraph, 600).totalHeight).toBe(0);
    }
  });

  test('never suppresses authored visual decorations', () => {
    const visualAttrs = [
      { shading: { fill: { rgb: 'FFFF00' } } },
      { borders: { top: { style: 'single', size: 8, color: { rgb: '000000' } } } },
      { borders: { bottom: { style: 'single', size: 8, color: { rgb: '000000' } } } },
      { borders: { left: { style: 'single', size: 8, color: { rgb: '000000' } } } },
      { borders: { right: { style: 'single', size: 8, color: { rgb: '000000' } } } },
      { borders: { between: { style: 'single', size: 8, color: { rgb: '000000' } } } },
      { borders: { bar: { style: 'single', size: 8, color: { rgb: '000000' } } } },
    ];

    for (const attrs of visualAttrs) {
      const doc = schema.node('doc', null, [
        schema.node('paragraph', {
          sectionBreakType: 'continuous',
          _sectionProperties: { sectionStart: 'continuous' },
          ...attrs,
        }),
      ]);
      const carrier = buildBoxTree(doc)[0] as ParagraphBlock;
      expect(carrier.attrs?.suppressEmptyParagraphHeight).toBeUndefined();
      expect(paragraphLayout(carrier, 600).totalHeight).toBeGreaterThan(0);
    }
  });
});
