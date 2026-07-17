import { describe, expect, test } from 'bun:test';
import { parseDocumentBody } from '../documentParser';
import { serializeParagraph } from '../serializer/paragraphSerializer';
import { toProseDoc } from '../../prosemirror/conversion/toProseDoc';
import { fromProseDoc } from '../../prosemirror/conversion/fromProseDoc';
import type { Document, Paragraph, Run, TabContent } from '../../types/document';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function wrapBody(bodyContent: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${bodyContent}</w:body></w:document>`;
}

function docOf(content: Paragraph[]): Document {
  return { package: { document: { content } } };
}

function findTabContent(paragraph: Paragraph): TabContent | undefined {
  for (const child of paragraph.content ?? []) {
    if (child.type !== 'run') continue;
    for (const item of (child as Run).content ?? []) {
      if (item.type === 'tab') return item as TabContent;
    }
  }
  return undefined;
}

describe('w:ptab round-trip', () => {
  test('preserves positional tab attributes through PM conversion and serialization', () => {
    const body = parseDocumentBody(
      wrapBody(
        `<w:p>
          <w:r><w:t>Chapter 1</w:t></w:r>
          <w:r><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="dot"/></w:r>
          <w:r><w:t>7</w:t></w:r>
        </w:p>`
      )
    );
    const input = docOf(body.content as Paragraph[]);

    const pmDoc = toProseDoc(input);
    let positionalAttr: unknown;
    pmDoc.descendants((node) => {
      if (node.type.name === 'tab' && node.attrs?.positional) {
        positionalAttr = node.attrs.positional;
      }
      return true;
    });
    expect(positionalAttr).toEqual({ alignment: 'right', relativeTo: 'margin', leader: 'dot' });

    const roundTripped = fromProseDoc(pmDoc, input);
    const paragraph = roundTripped.package.document.content[0] as Paragraph;
    const tab = findTabContent(paragraph);
    expect(tab?.positional).toEqual({ alignment: 'right', relativeTo: 'margin', leader: 'dot' });

    const xml = serializeParagraph(paragraph);
    expect(xml).toContain('<w:ptab w:alignment="right" w:relativeTo="margin" w:leader="dot"/>');
    expect(xml).not.toContain('<w:tab/>');
  });

  test('keeps plain tabs as w:tab', () => {
    const body = parseDocumentBody(
      wrapBody(`<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t></w:r></w:p>`)
    );
    const input = docOf(body.content as Paragraph[]);

    const roundTripped = fromProseDoc(toProseDoc(input), input);
    const xml = serializeParagraph(roundTripped.package.document.content[0] as Paragraph);

    expect(xml).toContain('<w:tab/>');
    expect(xml).not.toContain('<w:ptab');
  });
});
