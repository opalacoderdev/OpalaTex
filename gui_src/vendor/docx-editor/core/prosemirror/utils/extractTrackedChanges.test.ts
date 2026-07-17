/** Inline revisions are independently actionable by OOXML `w:id`. */

import { describe, test, expect } from 'bun:test';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { extractTrackedChanges } from './extractTrackedChanges';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: {
        pPrIns: { default: null },
        pPrDel: { default: null },
        _originalRunBoundaries: { default: null },
      },
      toDOM: () => ['p', 0],
    },
    tableRow: {
      content: 'tableCell+',
      attrs: { trIns: { default: null }, trDel: { default: null } },
      toDOM: () => ['tr', 0],
    },
    tableCell: {
      content: 'paragraph+',
      attrs: { cellMarker: { default: null } },
      toDOM: () => ['td', 0],
    },
    table: { content: 'tableRow+', group: 'block', toDOM: () => ['table', 0] },
    text: { group: 'inline' },
  },
  marks: {
    insertion: {
      attrs: { revisionId: { default: 0 }, author: { default: '' }, date: { default: null } },
      toDOM: () => ['ins', 0],
    },
    deletion: {
      attrs: { revisionId: { default: 0 }, author: { default: '' }, date: { default: null } },
      toDOM: () => ['del', 0],
    },
    comment: {
      attrs: { commentId: { default: 0 } },
      toDOM: () => ['span', 0],
    },
  },
});

const AUTHOR = 'Docx Editor User 960';
const DATE = '2026-05-28T20:28:35.944Z';

function makeState(doc: ReturnType<typeof schema.node>): EditorState {
  return EditorState.create({ doc });
}

describe('extractTrackedChanges: inline revision identity', () => {
  test('non-adjacent insertions with distinct w:ids and one timestamp stay independent', () => {
    const ins = (id: number, text: string) =>
      schema.text(text, [
        schema.marks.insertion.create({ revisionId: id, author: AUTHOR, date: DATE }),
      ]);
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [ins(1388975360, 'fdsfsd')]),
      schema.nodes.paragraph.create({}, [ins(47262383, 'fdsfsdf')]),
      schema.nodes.paragraph.create({}, [ins(1323221525, 'dsfsd')]),
      schema.nodes.paragraph.create({}, [ins(737865714, 'fds')]),
      schema.nodes.paragraph.create({}, [ins(186027604, 'fsd')]),
      schema.nodes.paragraph.create({}, [ins(902100301, 'last')]),
    ]);
    const { entries } = extractTrackedChanges(makeState(doc));
    expect(entries).toHaveLength(6);
    expect(entries.map((entry) => entry.revisionId)).toEqual([
      1388975360, 47262383, 1323221525, 737865714, 186027604, 902100301,
    ]);
    expect(entries.every((entry) => entry.coalescedRevisionIds == null)).toBe(true);
  });

  test('paragraph-mark insertions sharing each inline id hide behind their inline cards', () => {
    const ins = (id: number, text: string) =>
      schema.text(text, [
        schema.marks.insertion.create({ revisionId: id, author: AUTHOR, date: DATE }),
      ]);
    const pPrIns = (id: number) => ({ revisionId: id, author: AUTHOR, date: DATE });
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({ pPrIns: pPrIns(1388975360) }, [ins(1388975360, 'fdsfsd')]),
      schema.nodes.paragraph.create({ pPrIns: pPrIns(47262383) }, [ins(47262383, 'fdsfsdf')]),
    ]);
    const { entries } = extractTrackedChanges(makeState(doc));
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.type === 'insertion')).toBe(true);
  });

  test('adjacent deletion and insertion with distinct ids stay separate', () => {
    const deletion = schema.text('old', [
      schema.marks.deletion.create({ revisionId: 11, author: AUTHOR, date: DATE }),
    ]);
    const insertion = schema.text('new', [
      schema.marks.insertion.create({ revisionId: 12, author: AUTHOR, date: DATE }),
    ]);
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [deletion, insertion]),
    ]);
    const { entries } = extractTrackedChanges(makeState(doc));
    expect(entries.map((entry) => entry.type)).toEqual(['deletion', 'insertion']);
    expect(entries.map((entry) => entry.revisionId)).toEqual([11, 12]);
  });

  test('adjacent deletion and insertion with the same id form a replacement', () => {
    const deletion = schema.text('old', [
      schema.marks.deletion.create({ revisionId: 20, author: AUTHOR, date: DATE }),
    ]);
    const insertion = schema.text('new', [
      schema.marks.insertion.create({ revisionId: 20, author: AUTHOR, date: DATE }),
    ]);
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [deletion, insertion]),
    ]);
    const { entries } = extractTrackedChanges(makeState(doc));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'replacement',
      revisionId: 20,
      deletedText: 'old',
      text: 'new',
    });
  });

  test('extracts one exact run-property entry per source boundary change', () => {
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create(
        {
          _originalRunBoundaries: [
            {
              text: 'first',
              propertyChanges: [
                {
                  type: 'runPropertyChange',
                  info: { id: 31, author: 'A', date: DATE },
                  previousFormatting: { bold: false },
                },
              ],
            },
            {
              text: ' second',
              propertyChanges: [
                {
                  type: 'runPropertyChange',
                  info: { id: 32, author: 'B', date: DATE },
                  previousFormatting: { italic: false },
                },
              ],
            },
          ],
        },
        [schema.text('first second')]
      ),
    ]);
    const { entries } = extractTrackedChanges(makeState(doc));
    expect(entries).toEqual([
      {
        type: 'runPropertiesChanged',
        text: 'first',
        author: 'A',
        date: DATE,
        from: 1,
        to: 6,
        revisionId: 31,
      },
      {
        type: 'runPropertiesChanged',
        text: ' second',
        author: 'B',
        date: DATE,
        from: 6,
        to: 13,
        revisionId: 32,
      },
    ]);
  });

  test('whole-table insert: rows with distinct trIns ids but same (author, date) surface "Inserted table"', () => {
    const trIns = (id: number) => ({ revisionId: id, author: AUTHOR, date: DATE });
    const emptyCell = () =>
      schema.nodes.tableCell.create({}, [schema.nodes.paragraph.create({}, [])]);
    const row = (id: number) =>
      schema.nodes.tableRow.create({ trIns: trIns(id) }, [emptyCell(), emptyCell()]);
    const table = schema.nodes.table.create({}, [row(844706625), row(694611694)]);
    const doc = schema.nodes.doc.create({}, [table]);
    const { entries } = extractTrackedChanges(makeState(doc));
    const tableEntry = entries.find((e) => e.type === 'tableInserted');
    expect(tableEntry).toBeTruthy();
    // The two row ids should both be reachable from the card.
    const allIds = new Set([tableEntry!.revisionId, ...(tableEntry!.coalescedRevisionIds ?? [])]);
    expect(allIds).toEqual(new Set([844706625, 694611694]));
  });

  test('distinct (author, date) bursts stay as separate cards (we are not over-coalescing)', () => {
    const ins = (id: number, author: string, date: string, text: string) =>
      schema.text(text, [schema.marks.insertion.create({ revisionId: id, author, date })]);
    const doc = schema.nodes.doc.create({}, [
      schema.nodes.paragraph.create({}, [ins(1, 'Jane', '2026-05-28T20:28:35.944Z', 'foo')]),
      schema.nodes.paragraph.create({}, [ins(2, 'Jane', '2026-05-28T20:30:00.000Z', 'bar')]),
      schema.nodes.paragraph.create({}, [ins(3, 'Bob', '2026-05-28T20:28:35.944Z', 'baz')]),
    ]);
    const { entries } = extractTrackedChanges(makeState(doc));
    expect(entries).toHaveLength(3);
  });
});
