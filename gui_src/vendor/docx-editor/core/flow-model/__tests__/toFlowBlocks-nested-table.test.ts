import { describe, expect, test } from 'bun:test';
import { toProseDoc } from '../../prosemirror/conversion/toProseDoc';
import type { Document, Paragraph, Table, TableCell } from '../../types/document';
import type { ParagraphBlock, TableBlock } from '../../pagination-model/types';
import { buildBoxTree } from '../buildBoxTree';

function emptyParagraph(): Paragraph {
  return { type: 'paragraph', content: [] };
}

function textParagraph(text: string): Paragraph {
  return { type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text }] }] };
}

function cell(content: TableCell['content']): TableCell {
  return { type: 'tableCell', content };
}

function table(content: TableCell['content']): Table {
  return { type: 'table', rows: [{ type: 'tableRow', cells: [cell(content)] }] };
}

describe('buildBoxTree — nested table structural paragraphs', () => {
  test('marks an empty paragraph immediately after a nested table as zero-height', () => {
    const inner = table([textParagraph('inner')]);
    const outer = table([textParagraph('outer'), inner, emptyParagraph()]);
    const doc: Document = { package: { document: { content: [outer] } } };

    const [outerBlock] = buildBoxTree(toProseDoc(doc), {}) as [TableBlock];
    const outerCellBlocks = outerBlock.rows[0].cells[0].nodes;
    const trailing = outerCellBlocks[2] as ParagraphBlock;

    expect(outerCellBlocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(trailing.attrs?.suppressEmptyParagraphHeight).toBe(true);
  });
});
