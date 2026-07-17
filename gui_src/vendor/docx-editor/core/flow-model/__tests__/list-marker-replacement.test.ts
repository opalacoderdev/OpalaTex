import { describe, expect, test } from 'bun:test';
import type { ParagraphBlock } from '../../pagination-model/types';
import { schema } from '../../prosemirror/schema';
import { buildBoxTree } from '../buildBoxTree';

function deletionMark() {
  return schema.marks.deletion.create({
    revisionId: 319,
    author: 'Author',
    date: null,
    isMovePair: false,
  });
}

function spacedDeletionMarks() {
  return [
    deletionMark(),
    schema.marks.characterSpacing.create({
      spacing: 421,
      position: null,
      scale: null,
      kerning: null,
    }),
  ];
}

function listParagraph(deletedPrefix: string, withSpacedSeparator = false) {
  const content = [schema.text(deletedPrefix, [deletionMark()])];
  if (withSpacedSeparator) {
    content.push(schema.text(' ', spacedDeletionMarks()));
  }
  content.push(schema.text('“Labore”'));
  return schema.node(
    'paragraph',
    {
      numPr: { numId: 5, ilvl: 1 },
      listMarker: '(a)',
    },
    content
  );
}

describe('tracked list-marker replacements', () => {
  test('omits a matching deleted marker and spaced separator from layout runs', () => {
    const blocks = buildBoxTree(schema.node('doc', null, [listParagraph('(a)', true)]));
    const paragraph = blocks[0] as ParagraphBlock;

    expect(paragraph.attrs?.listMarker).toBe('(a)');
    expect(paragraph.attrs?.listMarkerRevision).toBe('del');
    expect(paragraph.runs.map((run) => (run.kind === 'text' ? run.text : run.kind))).toEqual([
      '“Labore”',
    ]);
  });

  test('retains deleted text that is not the resolved automatic marker', () => {
    const blocks = buildBoxTree(schema.node('doc', null, [listParagraph('(old)')]));
    const paragraph = blocks[0] as ParagraphBlock;

    expect(paragraph.runs.map((run) => (run.kind === 'text' ? run.text : run.kind))).toEqual([
      '(old)',
      '“Labore”',
    ]);
  });
});
