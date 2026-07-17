import { describe, expect, test } from 'bun:test';
import type { ParagraphBlock } from '../../pagination-model/types';
import { schema } from '../../prosemirror/schema';
import { buildBoxTree } from '../buildBoxTree';

describe('unresolved image layout', () => {
  test('keeps an unresolved image in PM without emitting a layout run', () => {
    const image = schema.node('image', {
      src: '',
      rId: 'rId35',
      width: 583,
      height: 382,
      wrapType: 'inline',
      displayMode: 'inline',
    });
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [image])]);

    const paragraph = buildBoxTree(doc)[0] as ParagraphBlock;
    expect(paragraph.runs).toEqual([]);
    expect(doc.child(0).child(0).attrs.rId).toBe('rId35');
  });
});
