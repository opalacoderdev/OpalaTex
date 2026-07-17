import { describe, test, expect } from 'bun:test';
import { EditorState, TextSelection } from 'prosemirror-state';
import { singletonManager } from '../../schema';
import { toggleBold } from '../../commands/formatting';

const schema = singletonManager.getSchema();

describe('toggleBold empty paragraph persistence', () => {
  test('survives a subsequent selection transaction', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph')]);
    let state = EditorState.create({
      doc,
      schema,
      plugins: singletonManager.getPlugins(),
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    toggleBold(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.storedMarks?.some((m) => m.type.name === 'bold')).toBe(true);
    expect(state.doc.firstChild!.attrs.defaultTextFormatting).toEqual({ bold: true });

    // Mimic toolbar/focus selection clear
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    expect(state.storedMarks?.some((m) => m.type.name === 'bold')).toBe(true);
    expect(state.doc.firstChild!.attrs.defaultTextFormatting).toEqual({ bold: true });
  });

  test('delete all bold text keeps stored marks for retype', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Initial', [schema.marks.bold.create()])]),
    ]);
    let state = EditorState.create({
      doc,
      schema,
      plugins: singletonManager.getPlugins(),
    });
    // Select all text inside the paragraph and delete
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, 1 + 'Initial'.length))
    );
    state = state.apply(state.tr.deleteSelection());

    expect(state.selection.$from.parent.textContent).toBe('');
    expect(state.storedMarks?.some((m) => m.type.name === 'bold')).toBe(true);
    expect(state.doc.firstChild!.attrs.defaultTextFormatting).toEqual({ bold: true });

    // Selection clear (layout settle) must not drop the formatting
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    expect(state.storedMarks?.some((m) => m.type.name === 'bold')).toBe(true);
  });

  test('bold on empty para with font DTF merges instead of replacing', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', {
        defaultTextFormatting: {
          fontSize: 22,
          fontFamily: { ascii: 'Arial', hAnsi: 'Arial' },
        },
      }),
    ]);
    let state = EditorState.create({
      doc,
      schema,
      plugins: singletonManager.getPlugins(),
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    // Simulate toolbar focus leaving an empty storedMarks array
    state = state.apply(state.tr.setStoredMarks([]));

    toggleBold(state, (tr) => {
      state = state.apply(tr);
    });

    const dtf = state.doc.firstChild!.attrs.defaultTextFormatting as {
      bold?: boolean;
      fontSize?: number;
      fontFamily?: { ascii: string };
    };
    expect(dtf.bold).toBe(true);
    expect(dtf.fontSize).toBe(22);
    expect(dtf.fontFamily?.ascii).toBe('Arial');
    expect(state.storedMarks?.some((m) => m.type.name === 'bold')).toBe(true);
    expect(state.storedMarks?.some((m) => m.type.name === 'fontFamily')).toBe(true);
  });
});
