import { describe, expect, test } from 'bun:test';
import type { ImageBlock } from '../../pagination-model/types';
import { schema } from '../../prosemirror/schema';
import { buildBoxTree } from '../buildBoxTree';

describe('tracked block image layout', () => {
  test('deletion metadata wins when an image carries insertion and deletion marks', () => {
    const insertion = schema.marks.insertion.create({
      revisionId: 11,
      author: 'Inserter',
      date: '2026-07-16T10:00:00Z',
    });
    const deletion = schema.marks.deletion.create({
      revisionId: 12,
      author: 'Deleter',
      date: '2026-07-16T11:00:00Z',
    });
    const image = schema.node(
      'image',
      {
        src: 'data:image/png;base64,AA==',
        width: 80,
        height: 60,
        wrapType: 'inFront',
        displayMode: 'float',
      },
      undefined,
      [insertion, deletion]
    );
    // BuildBoxTree supports standalone image nodes for synthetic/layout callers
    // even though the editor schema normally nests images in paragraphs.
    const doc = schema.nodes.doc.create(null, [image]);

    const block = buildBoxTree(doc)[0] as ImageBlock;

    expect(block.kind).toBe('image');
    expect(block.isInsertion).toBeUndefined();
    expect(block.isDeletion).toBe(true);
    expect(block.changeRevisionId).toBe(12);
    expect(block.changeAuthor).toBe('Deleter');
    expect(block.changeDate).toBe('2026-07-16T11:00:00Z');
  });
});
