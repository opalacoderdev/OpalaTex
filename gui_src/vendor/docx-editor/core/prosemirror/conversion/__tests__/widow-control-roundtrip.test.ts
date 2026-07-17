import { describe, expect, test } from 'bun:test';

import type { Document, Paragraph } from '../../../types/document';
import { serializeParagraph } from '../../../docx/serializer/paragraphSerializer';
import { toProseDoc } from '../toProseDoc';
import { fromProseDoc } from '../fromProseDoc';

function documentWithWidowControl(widowControl?: boolean): Document {
  return {
    package: {
      document: {
        content: [
          {
            type: 'paragraph',
            formatting: widowControl === undefined ? undefined : { widowControl },
            content: [{ type: 'run', content: [{ type: 'text', text: 'four lines' }] }],
          },
        ],
      },
    },
  };
}

describe('widowControl ProseMirror round-trip', () => {
  test.each([
    ['enabled explicitly', true],
    ['disabled explicitly', false],
  ] as const)('%s', (_label, widowControl) => {
    const input = documentWithWidowControl(widowControl);
    const pmDoc = toProseDoc(input);

    expect(pmDoc.firstChild?.attrs.widowControl).toBe(widowControl);

    const output = fromProseDoc(pmDoc, input);
    const paragraph = output.package.document.content[0] as Paragraph;
    expect(paragraph.formatting?.widowControl).toBe(widowControl);

    const xml = serializeParagraph(paragraph);
    expect(xml).toContain(widowControl ? '<w:widowControl/>' : '<w:widowControl w:val="0"/>');
  });

  test('undefined remains absent while layout keeps its enabled default', () => {
    const input = documentWithWidowControl();
    const pmDoc = toProseDoc(input);
    expect(pmDoc.firstChild?.attrs.widowControl).toBeNull();

    const output = fromProseDoc(pmDoc, input);
    const paragraph = output.package.document.content[0] as Paragraph;
    expect(paragraph.formatting?.widowControl).toBeUndefined();
    expect(serializeParagraph(paragraph)).not.toContain('w:widowControl');
  });
});
