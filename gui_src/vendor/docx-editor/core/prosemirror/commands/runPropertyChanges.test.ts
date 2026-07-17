import { describe, expect, test } from 'bun:test';
import { EditorState } from 'prosemirror-state';
import type { Document, Paragraph, Run } from '../../types/document';
import { serializeParagraph } from '../../docx/serializer/paragraphSerializer';
import { schema } from '../schema';
import { fromProseDoc } from '../conversion/fromProseDoc';
import { toProseDoc } from '../conversion/toProseDoc';
import { acceptChangeById, rejectChangeById } from './comments';

function docOf(paragraph: Paragraph): Document {
  return { package: { document: { content: [paragraph] } } };
}

describe('run-property tracked changes', () => {
  test('accept keeps current formatting and reject restores the exact prior run', () => {
    const input: Paragraph = {
      type: 'paragraph',
      content: [
        {
          type: 'run',
          formatting: { bold: true },
          propertyChanges: [
            {
              type: 'runPropertyChange',
              info: { id: 88, author: 'Reviewer', date: '2026-07-14T09:00:00Z' },
              previousFormatting: { italic: true },
              currentFormatting: { bold: true },
            },
          ],
          content: [{ type: 'text', text: 'changed' }],
        },
        {
          type: 'run',
          formatting: { underline: { style: 'single' } },
          content: [{ type: 'text', text: ' untouched' }],
        },
      ],
    };

    const resolve = (mode: 'accept' | 'reject'): Paragraph => {
      let state = EditorState.create({ schema, doc: toProseDoc(docOf(input)) });
      const command = mode === 'accept' ? acceptChangeById(88) : rejectChangeById(88);
      expect(
        command(state, (transaction) => {
          state = state.apply(transaction);
        })
      ).toBe(true);
      return fromProseDoc(state.doc).package.document.content[0] as Paragraph;
    };

    const accepted = resolve('accept');
    const acceptedFirst = accepted.content[0] as Run;
    expect(acceptedFirst.formatting?.bold).toBe(true);
    expect(acceptedFirst.propertyChanges).toBeUndefined();
    expect(serializeParagraph(accepted)).not.toContain('<w:rPrChange');

    const rejected = resolve('reject');
    const rejectedFirst = rejected.content[0] as Run;
    const rejectedSecond = rejected.content[1] as Run;
    expect(rejectedFirst.formatting?.bold).toBeUndefined();
    expect(rejectedFirst.formatting?.italic).toBe(true);
    expect(rejectedFirst.propertyChanges).toBeUndefined();
    expect(rejectedSecond.formatting?.underline?.style).toBe('single');
    expect(serializeParagraph(rejected)).not.toContain('<w:rPrChange');
  });
});
