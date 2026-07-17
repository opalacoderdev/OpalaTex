import { describe, expect, test } from 'bun:test';
import { parseDocumentBody } from '../../../docx/documentParser';
import { serializeParagraph } from '../../../docx/serializer/paragraphSerializer';
import type { Deletion, Document, Insertion, Paragraph } from '../../../types/document';
import { fromProseDoc } from '../fromProseDoc';
import { toProseDoc } from '../toProseDoc';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docOf(...content: Document['package']['document']['content']): Document {
  return { package: { document: { content } } };
}

describe('nested tracked changes', () => {
  test('preserves a deletion nested inside an insertion through PM and save', () => {
    const body = parseDocumentBody(`<w:document ${W}><w:body><w:p>
      <w:ins w:id="10" w:author="Author">
        <w:del w:id="11" w:author="Jonathan Melke">
          <w:r><w:delText xml:space="preserve">Amended </w:delText></w:r>
        </w:del>
        <w:r><w:t>Agreement</w:t></w:r>
      </w:ins>
    </w:p></w:body></w:document>`);
    const paragraph = body.content[0] as Paragraph;
    const insertion = paragraph.content[0] as Insertion;
    const deletion = insertion.content[0] as Deletion;

    expect(insertion.type).toBe('insertion');
    expect(deletion.type).toBe('deletion');

    const source = docOf(...body.content);
    const pm = toProseDoc(source);
    expect(pm.textContent).toBe('Amended Agreement');
    const amended = pm.child(0).child(0);
    expect(amended.marks.map((mark) => mark.type.name)).toEqual(['insertion', 'deletion']);

    const xml = serializeParagraph(
      fromProseDoc(pm, source).package.document.content[0] as Paragraph
    );
    expect(xml).toContain('<w:ins w:id="10"');
    expect(xml).toContain('<w:del w:id="11"');
    expect(xml).toContain('<w:delText xml:space="preserve">Amended </w:delText>');
    expect(xml.indexOf('<w:ins')).toBeLessThan(xml.indexOf('<w:del'));
  });
});
