import { describe, test, expect } from 'bun:test';
import { parseNumbering } from '../numberingParser';
import { parseParagraph } from '../paragraphParser';
import { parseXmlDocument, type XmlElement } from '../xmlParser';
import { serializeParagraph } from '../serializer/paragraphSerializer';
import { toProseDoc } from '../../prosemirror/conversion/toProseDoc';
import { fromProseDoc } from '../../prosemirror/conversion/fromProseDoc';
import type { Document, Paragraph } from '../../types/document';

const NUMBERING_MULTI_LEVEL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="upperRoman"/>
      <w:lvlText w:val="%1."/>
    </w:lvl>
    <w:lvl w:ilvl="1">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1.%2."/>
    </w:lvl>
    <w:lvl w:ilvl="2">
      <w:start w:val="1"/>
      <w:numFmt w:val="lowerLetter"/>
      <w:lvlText w:val="%3)"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="0"/>
  </w:num>
</w:numbering>`;

function parseParagraphXml(xml: string, numbering: ReturnType<typeof parseNumbering>) {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) throw new Error('Failed to parse paragraph XML');
  return parseParagraph(root, null, null, numbering, null, null);
}

function pmAttrs(paragraph: Paragraph): Record<string, unknown> {
  const document: Document = { package: { document: { content: [paragraph] } } };
  return toProseDoc(document).child(0).attrs;
}

describe('paragraphParser populates listRendering.levelNumFmts', () => {
  const numbering = parseNumbering(NUMBERING_MULTI_LEVEL);

  test('captures numFmt for level 0 only when ilvl=0', () => {
    const para = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      </w:p>`,
      numbering
    );
    expect(para.listRendering?.levelNumFmts).toEqual(['upperRoman']);
    expect(para.listRendering?.marker).toBe('%1.');
  });

  test('captures numFmts for levels 0..1 when ilvl=1', () => {
    const para = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
      </w:p>`,
      numbering
    );
    expect(para.listRendering?.levelNumFmts).toEqual(['upperRoman', 'decimal']);
    expect(para.listRendering?.marker).toBe('%1.%2.');
  });

  test('captures numFmts for levels 0..2 when ilvl=2', () => {
    const para = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr></w:pPr>
      </w:p>`,
      numbering
    );
    expect(para.listRendering?.levelNumFmts).toEqual(['upperRoman', 'decimal', 'lowerLetter']);
    expect(para.listRendering?.marker).toBe('%3)');
  });
});

describe('paragraphParser applies numbering indentation defaults', () => {
  const numbering = parseNumbering(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:pPr>
        <w:ind w:left="360" w:hanging="360"/>
      </w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="0"/>
  </w:num>
</w:numbering>`);

  test('keeps level hanging indent when paragraph writes neutral firstLine zero', () => {
    const para = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:firstLine="0"/>
        </w:pPr>
      </w:p>`,
      numbering
    );

    expect(para.formatting?.indentLeft).toBeUndefined();
    expect(para.formatting?.indentFirstLine).toBe(0);
    expect(pmAttrs(para)).toMatchObject({
      indentLeft: 360,
      indentFirstLine: -360,
      hangingIndent: true,
    });
  });

  test('keeps level hanging indent when paragraph writes neutral hanging zero', () => {
    const para = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:hanging="0"/>
        </w:pPr>
      </w:p>`,
      numbering
    );

    expect(para.formatting?.indentLeft).toBeUndefined();
    expect(para.formatting?.indentFirstLine).toBe(-0);
    expect(para.formatting?.hangingIndent).toBe(true);
    expect(pmAttrs(para)).toMatchObject({
      indentLeft: 360,
      indentFirstLine: -360,
      hangingIndent: true,
    });
  });

  test('all-zero direct indent keeps both numbering indent groups', () => {
    const para = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:left="0" w:firstLine="0"/>
        </w:pPr>
      </w:p>`,
      numbering
    );

    expect(para.formatting?.indentLeft).toBe(0);
    expect(para.formatting?.indentFirstLine).toBe(0);
    expect(pmAttrs(para)).toMatchObject({
      indentLeft: 360,
      indentFirstLine: -360,
      hangingIndent: true,
    });

    const input: Document = { package: { document: { content: [para] } } };
    const roundTripped = fromProseDoc(toProseDoc(input), input);
    const output = roundTripped.package.document.content[0] as Paragraph;
    const xml = serializeParagraph(output);
    expect(xml).toContain('<w:ind w:left="0" w:firstLine="0"/>');
    expect(xml).not.toContain('w:left="360"');
    expect(xml).not.toContain('w:hanging="360"');

    for (const transported of [
      structuredClone(para),
      JSON.parse(JSON.stringify(para)) as Paragraph,
    ]) {
      expect(pmAttrs(transported)).toMatchObject({
        indentLeft: 360,
        indentFirstLine: -360,
        hangingIndent: true,
      });
      const transportedInput: Document = {
        package: { document: { content: [transported] } },
      };
      const transportedOutput = fromProseDoc(toProseDoc(transportedInput), transportedInput).package
        .document.content[0] as Paragraph;
      const transportedXml = serializeParagraph(transportedOutput);
      expect(transportedXml).toContain('<w:ind w:left="0" w:firstLine="0"/>');
      expect(transportedXml).not.toContain('w:left="360"');
      expect(transportedXml).not.toContain('w:hanging="360"');
    }

    const mutations: Array<Partial<NonNullable<Paragraph['formatting']>>> = [
      { styleId: 'ChangedStyle' },
      { indentLeft: 720 },
      { indentRight: 240 },
      { indentFirstLine: 180 },
      { indentFirstLine: -180, hangingIndent: true },
    ];
    for (const patch of mutations) {
      const mutated = structuredClone(para);
      Object.assign(mutated.formatting!, patch);
      const attrs = pmAttrs(mutated);
      expect(attrs.indentLeft).not.toBe(360);
      expect(attrs.indentFirstLine).not.toBe(-360);
    }
  });

  test('non-zero direct firstLine still overrides the level hanging indent', () => {
    const para = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:firstLine="180"/>
        </w:pPr>
      </w:p>`,
      numbering
    );

    // Direct firstLine="180" wins over the level's hanging — the
    // paragraph keeps the level's left indent and the direct positive
    // first-line offset, with no hanging flag inherited.
    expect(para.formatting?.indentLeft).toBeUndefined();
    expect(para.formatting?.indentFirstLine).toBe(180);
    expect(para.formatting?.hangingIndent).toBeUndefined();
    expect(pmAttrs(para)).toMatchObject({
      indentLeft: 360,
      indentFirstLine: 180,
    });
  });
});
