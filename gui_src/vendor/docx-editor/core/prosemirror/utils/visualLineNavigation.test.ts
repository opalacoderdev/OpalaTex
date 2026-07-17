/**
 * Unit tests for grapheme-safe horizontal arrow movement in
 * visualLineNavigation — caret must never land inside a surrogate pair
 * or combining cluster. Visual-line Up/Down and CellSelection bail-out
 * stay covered at the handleVisualLineKeyDown boundary.
 */

import { describe, expect, test } from 'bun:test';
import { Schema } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { createVisualLineState, handleVisualLineKeyDown } from './visualLineNavigation';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
});

function makeDoc(text: string) {
  return schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
}

/** Absolute PM position at `parentOffset` inside the first paragraph. */
function posAt(parentOffset: number): number {
  return 1 + parentOffset;
}

function makeView(doc: ReturnType<typeof makeDoc>, head: number) {
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, head),
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
  };
  return view as unknown as EditorView & { state: EditorState };
}

function arrow(key: 'ArrowLeft' | 'ArrowRight', shiftKey = false): KeyboardEvent {
  return { key, shiftKey, ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent;
}

function press(view: EditorView, key: 'ArrowLeft' | 'ArrowRight'): boolean {
  return handleVisualLineKeyDown(createVisualLineState(), view, arrow(key), null);
}

describe('handleVisualLineKeyDown — grapheme-safe ArrowLeft/Right', () => {
  const emoji = '😀'; // U+1F600 — one grapheme, two UTF-16 code units
  const combining = 'e\u0301'; // e + combining acute — one grapheme, two units
  const flag = '🇵🇱'; // two regional indicators — one grapheme, four units
  const zwj = '👩‍👩‍👧‍👦'; // ZWJ family — one grapheme

  test('ArrowRight skips a full emoji surrogate pair', () => {
    const view = makeView(makeDoc(`a${emoji}b`), posAt(1));
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(1 + emoji.length));
  });

  test('ArrowLeft skips a full emoji surrogate pair', () => {
    const view = makeView(makeDoc(`a${emoji}b`), posAt(1 + emoji.length));
    expect(press(view, 'ArrowLeft')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(1));
  });

  test('ArrowRight skips a combining mark sequence', () => {
    const view = makeView(makeDoc(`x${combining}y`), posAt(1));
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(1 + combining.length));
  });

  test('ArrowLeft skips a combining mark sequence', () => {
    const view = makeView(makeDoc(`x${combining}y`), posAt(1 + combining.length));
    expect(press(view, 'ArrowLeft')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(1));
  });

  test('ArrowRight skips a flag emoji (two regional indicators)', () => {
    const view = makeView(makeDoc(flag), posAt(0));
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(flag.length));
  });

  test('ArrowLeft skips a flag emoji', () => {
    const view = makeView(makeDoc(flag), posAt(flag.length));
    expect(press(view, 'ArrowLeft')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(0));
  });

  test('ArrowRight skips a ZWJ emoji sequence', () => {
    const view = makeView(makeDoc(zwj), posAt(0));
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(zwj.length));
  });

  test('ArrowLeft skips a ZWJ emoji sequence', () => {
    const view = makeView(makeDoc(zwj), posAt(zwj.length));
    expect(press(view, 'ArrowLeft')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(0));
  });

  test('ASCII still advances one code unit', () => {
    const view = makeView(makeDoc('abc'), posAt(1));
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(2));
    expect(press(view, 'ArrowLeft')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(1));
  });

  test('crosses into the next paragraph at the textblock edge', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('ab')]),
      schema.node('paragraph', null, [schema.text('cd')]),
    ]);
    const view = makeView(doc, posAt(2));
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(5); // before 'c'
  });

  test('snaps out of a mid-surrogate caret on ArrowRight', () => {
    const view = makeView(makeDoc(`a${emoji}b`), posAt(1) + 1);
    expect(press(view, 'ArrowRight')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(1 + emoji.length));
  });

  test('snaps out of a mid-surrogate caret on ArrowLeft', () => {
    const view = makeView(makeDoc(`a${emoji}b`), posAt(1) + 1);
    expect(press(view, 'ArrowLeft')).toBe(true);
    expect(view.state.selection.head).toBe(posAt(1));
  });

  test('fallback segmentation (no Intl.Segmenter) still skips emoji and combining', () => {
    const intl = Intl as unknown as { Segmenter?: unknown };
    const original = intl.Segmenter;
    intl.Segmenter = undefined;
    try {
      const emojiView = makeView(makeDoc(`a${emoji}b`), posAt(1));
      expect(press(emojiView, 'ArrowRight')).toBe(true);
      expect(emojiView.state.selection.head).toBe(posAt(1 + emoji.length));
      expect(press(emojiView, 'ArrowLeft')).toBe(true);
      expect(emojiView.state.selection.head).toBe(posAt(1));

      const combiningView = makeView(makeDoc(combining), posAt(0));
      expect(press(combiningView, 'ArrowRight')).toBe(true);
      expect(combiningView.state.selection.head).toBe(posAt(combining.length));
      expect(press(combiningView, 'ArrowLeft')).toBe(true);
      expect(combiningView.state.selection.head).toBe(posAt(0));
    } finally {
      intl.Segmenter = original;
    }
  });

  test('leaves CellSelection to other handlers', () => {
    const fakeView = {
      state: {
        selection: { $anchorCell: {}, empty: true, head: 2 },
        doc: makeDoc('ab'),
      },
      dispatch() {
        throw new Error('should not dispatch for CellSelection');
      },
    } as unknown as EditorView;

    expect(
      handleVisualLineKeyDown(createVisualLineState(), fakeView, arrow('ArrowRight'), null)
    ).toBe(false);
  });

  test('collapse non-empty selection without Shift moves to the near edge', () => {
    const doc = makeDoc('abcdef');
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posAt(1), posAt(4)),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(tr: Transaction) {
        state = state.apply(tr);
      },
    } as unknown as EditorView;

    const navState = createVisualLineState();
    expect(handleVisualLineKeyDown(navState, view, arrow('ArrowRight'), null)).toBe(true);
    expect(view.state.selection.head).toBe(posAt(4));
    expect(view.state.selection.empty).toBe(true);
    expect(navState.stickyX).toBeNull();
  });
});
