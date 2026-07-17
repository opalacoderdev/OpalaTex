import { describe, expect, test } from 'bun:test';
import { EditorState, TextSelection } from 'prosemirror-state';

import { schema } from '../../schema';
import { handleSuggestionEnter } from './handlers/structural';
import { createSuggestionModePlugin, suggestionModeKey } from './index';

describe('handleSuggestionEnter', () => {
  test('sets pPrIns on the first paragraph after a mid-paragraph split', () => {
    const plugin = createSuggestionModePlugin(true, 'Jane');
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Hello world')]),
    ]);
    const state = EditorState.create({
      doc,
      plugins: [plugin],
      selection: TextSelection.create(doc, 6),
    });

    expect(suggestionModeKey.getState(state)?.active).toBe(true);
    expect(state.schema.marks.insertion).toBeTruthy();
    expect(state.schema.nodes.paragraph.spec.attrs?.pPrIns).toBeTruthy();

    let newState = state;
    const ok = handleSuggestionEnter(state, (tr) => {
      newState = state.apply(tr);
    });
    expect(ok).toBe(true);

    const p0 = newState.doc.child(0);
    const p1 = newState.doc.child(1);
    expect(p0.textContent).toBe('Hello');
    expect(p1.textContent).toBe(' world');
    expect(p0.attrs.pPrIns).toEqual(
      expect.objectContaining({ author: 'Jane', revisionId: expect.any(Number) })
    );
    expect(p1.attrs.pPrIns).toBeNull();
  });
});
