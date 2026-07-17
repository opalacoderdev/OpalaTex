import { describe, expect, test } from 'bun:test';
import { layOutPages } from '../../../pagination-model';
import type { LayoutMetrics } from '../../../pagination-model/types';
import type { Document, Paragraph } from '../../../types/document';
import { serializeParagraph } from '../../../docx/serializer/paragraphSerializer';
import { buildBoxTree } from '../../../flow-model/buildBoxTree';
import { fromProseDoc } from '../fromProseDoc';
import { toProseDoc } from '../toProseDoc';

function docOf(...content: Paragraph[]): Document {
  return { package: { document: { content } } };
}

function textParagraph(text: string): Paragraph {
  return {
    type: 'paragraph',
    content: [{ type: 'run', content: [{ type: 'text', text }] }],
  };
}

function childTypes(doc: ReturnType<typeof toProseDoc>): string[] {
  const types: string[] = [];
  doc.forEach((node) => {
    types.push(node.type.name);
  });
  return types;
}

describe('issue #830 leading hard page break round-trip', () => {
  test('converts literal tab characters inside text runs to PM tab nodes', () => {
    const input = docOf(textParagraph('Left\tRight'));

    const pmDoc = toProseDoc(input);
    const paragraph = pmDoc.child(0);

    expect(paragraph.childCount).toBe(3);
    expect(paragraph.child(0).textContent).toBe('Left');
    expect(paragraph.child(1).type.name).toBe('tab');
    expect(paragraph.child(2).textContent).toBe('Right');
  });

  test('does not export a leading hard page break as an extra empty paragraph', () => {
    const leadingBreakParagraph: Paragraph = {
      type: 'paragraph',
      renderedPageBreakBefore: true,
      formatting: { styleId: 'CenterSingle' },
      content: [
        { type: 'run', content: [{ type: 'break', breakType: 'page' }] },
        { type: 'run', content: [{ type: 'text', text: 'After hard break' }] },
      ],
    };
    const input = docOf(textParagraph('Before'), leadingBreakParagraph);

    const pmDoc = toProseDoc(input);
    expect(childTypes(pmDoc)).toEqual(['paragraph', 'paragraph']);
    expect(pmDoc.child(1).attrs.pageBreakBefore).toBe(true);
    expect(pmDoc.child(1).attrs.renderedPageBreakBefore).toBe(true);

    const roundTripped = fromProseDoc(pmDoc, input);
    expect(roundTripped.package.document.content).toHaveLength(2);

    const outputParagraph = roundTripped.package.document.content[1];
    expect(outputParagraph?.type).toBe('paragraph');
    if (outputParagraph?.type !== 'paragraph') {
      throw new Error('Expected second body block to remain a paragraph');
    }

    const xml = serializeParagraph(outputParagraph);
    expect(xml).toContain('<w:pageBreakBefore/>');
    // The lastRenderedPageBreak marker survives and the text survives. The
    // marker may ride its own run rather than the text run, since run-boundary
    // preservation keeps the empty leading-break run distinct; both layouts are
    // valid OOXML (Word itself commonly emits the marker on a standalone run).
    expect(xml).toMatch(/<w:r[^>]*><w:lastRenderedPageBreak\/>/);
    expect(xml).toContain('<w:t>After hard break</w:t>');
  });

  test('preserves a break-only paragraph with no direct formatting', () => {
    const leadingBreakParagraph: Paragraph = {
      type: 'paragraph',
      content: [{ type: 'run', content: [{ type: 'break', breakType: 'page' }] }],
    };

    const pmDoc = toProseDoc(docOf(leadingBreakParagraph));
    expect(childTypes(pmDoc)).toEqual(['paragraph']);
    expect(pmDoc.child(0).attrs.pageBreakBefore).toBe(true);

    const roundTripped = fromProseDoc(pmDoc, docOf(leadingBreakParagraph));
    const outputParagraph = roundTripped.package.document.content[0];
    expect(outputParagraph?.type).toBe('paragraph');
    if (outputParagraph?.type !== 'paragraph') {
      throw new Error('Expected body block to remain a paragraph');
    }

    const xml = serializeParagraph(outputParagraph);
    expect(xml).toContain('<w:pageBreakBefore/>');
  });

  test('keeps non-leading hard page breaks as explicit PM page break blocks', () => {
    const midParagraph: Paragraph = {
      type: 'paragraph',
      content: [
        { type: 'run', content: [{ type: 'text', text: 'Before break' }] },
        { type: 'run', content: [{ type: 'break', breakType: 'page' }] },
        { type: 'run', content: [{ type: 'text', text: 'After break' }] },
      ],
    };

    const pmDoc = toProseDoc(docOf(midParagraph));
    expect(childTypes(pmDoc)).toEqual(['paragraph', 'pageBreak']);
  });

  test('keeps hard column breaks as explicit PM column break blocks', () => {
    const midParagraph: Paragraph = {
      type: 'paragraph',
      content: [
        { type: 'run', content: [{ type: 'text', text: 'Before column' }] },
        { type: 'run', content: [{ type: 'break', breakType: 'column' }] },
        { type: 'run', content: [{ type: 'text', text: 'After column' }] },
      ],
    };

    const input = docOf(midParagraph);
    const pmDoc = toProseDoc(input);
    expect(childTypes(pmDoc)).toEqual(['paragraph', 'columnBreak', 'paragraph']);

    const blocks = buildBoxTree(pmDoc);
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'columnBreak', 'paragraph']);

    const measures: LayoutMetrics[] = blocks.map((block) =>
      block.kind === 'paragraph'
        ? {
            kind: 'paragraph',
            lines: [
              {
                fromRun: 0,
                fromChar: 0,
                toRun: 0,
                toChar: 1,
                width: 80,
                ascent: 10,
                descent: 3,
                lineHeight: 20,
              },
            ],
            totalHeight: 20,
          }
        : { kind: 'columnBreak' }
    );
    const layout = layOutPages(blocks, measures, {
      pageSize: { w: 500, h: 700 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      columns: { count: 2, gap: 20, separator: true },
    });
    const fragments = layout.pages[0]?.fragments ?? [];
    expect(fragments[1].x).toBeGreaterThan(fragments[0].x);

    const roundTripped = fromProseDoc(pmDoc, input);
    const outputBreak = roundTripped.package.document.content[1];
    expect(outputBreak?.type).toBe('paragraph');
    if (outputBreak?.type !== 'paragraph') {
      throw new Error('Expected column break to export as a paragraph');
    }
    expect(serializeParagraph(outputBreak)).toContain('<w:br w:type="column"/>');
  });

  test('keeps the empty paragraph mark after a trailing column break', () => {
    const breakAtParagraphEnd: Paragraph = {
      type: 'paragraph',
      content: [
        { type: 'run', content: [{ type: 'text', text: 'Before column' }] },
        { type: 'run', content: [{ type: 'break', breakType: 'column' }] },
      ],
    };
    const input = docOf(breakAtParagraphEnd, textParagraph('After column'));

    const pmDoc = toProseDoc(input);
    expect(childTypes(pmDoc)).toEqual(['paragraph', 'columnBreak', 'paragraph', 'paragraph']);
    expect(pmDoc.child(2).textContent).toBe('');

    const blocks = buildBoxTree(pmDoc);
    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'columnBreak',
      'paragraph',
      'paragraph',
    ]);
    expect(blocks[2].kind).toBe('paragraph');
    if (blocks[2].kind !== 'paragraph') {
      throw new Error('Expected the post-column-break paragraph mark to survive');
    }
    expect(blocks[2].runs).toHaveLength(0);

    const measures: LayoutMetrics[] = blocks.map((block) =>
      block.kind === 'paragraph'
        ? {
            kind: 'paragraph',
            lines: [
              {
                fromRun: 0,
                fromChar: 0,
                toRun: 0,
                toChar: 0,
                width: 80,
                ascent: 10,
                descent: 3,
                lineHeight: 20,
              },
            ],
            totalHeight: 20,
          }
        : { kind: 'columnBreak' }
    );
    const layout = layOutPages(blocks, measures, {
      pageSize: { w: 500, h: 700 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      columns: { count: 2, gap: 20, separator: true },
    });

    const fragments = layout.pages[0]?.fragments ?? [];
    expect(fragments).toHaveLength(3);
    expect(fragments[1].x).toBeGreaterThan(fragments[0].x);
    expect(fragments[2].x).toBe(fragments[1].x);
    expect(fragments[2].y).toBe(fragments[1].y + 20);
  });
});
