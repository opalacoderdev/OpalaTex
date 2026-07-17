import { describe, expect, test } from 'bun:test';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import JSZip from 'jszip';
import { buildBoxTree } from '../../../flow-model/buildBoxTree';
import { parseDocumentBody } from '../../../docx/documentParser';
import { serializeDocumentBody } from '../../../docx/serializer/documentSerializer';
import { serializeParagraph } from '../../../docx/serializer/paragraphSerializer';
import { serializeSectionProperties } from '../../../docx/serializer/sectionPropertiesSerializer';
import { parseTableProperties } from '../../../docx/tableParser';
import { parseXml } from '../../../docx/xmlParser';
import { processNewImages } from '../../../docx/rezip/images';
import type {
  Document,
  Paragraph,
  ParagraphFormatting,
  Run,
  Hyperlink,
  Insertion,
  Deletion,
  Image,
  InlineSdt,
  BlockSdt,
} from '../../../types/document';
import { schema } from '../../schema';
import { rejectChangeById } from '../../commands/comments';
import { fromProseDoc } from '../fromProseDoc';
import { toProseDoc } from '../toProseDoc';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docOf(...content: Document['package']['document']['content']): Document {
  return { package: { document: { content } } };
}

function paragraph(content: Paragraph['content']): Paragraph {
  return { type: 'paragraph', content };
}

function imageParagraph(image: Image): Paragraph {
  return { type: 'paragraph', content: [{ type: 'run', content: [{ type: 'drawing', image }] }] };
}

function dataUrl(bytes: number[], mime = 'image/png'): string {
  return `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;
}

function image(overrides: Partial<Image> & { src: string }): Image {
  return {
    type: 'image',
    rId: '',
    size: { width: 1, height: 1 },
    wrap: { type: 'inline' },
    ...overrides,
  };
}

function IMAGE_REL(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
}

describe('DOCX round-trip fidelity fixes', () => {
  test('widowControl survives PM and defaults on only in layout', () => {
    for (const value of [false, true, undefined] as const) {
      const input: Paragraph = {
        type: 'paragraph',
        ...(value === undefined ? {} : { formatting: { widowControl: value } }),
        content: [{ type: 'run', content: [{ type: 'text', text: 'x' }] }],
      };
      const pm = toProseDoc(docOf(input));
      expect(pm.child(0).attrs.widowControl).toBe(value ?? null);

      const flow = buildBoxTree(pm)[0];
      expect(flow.kind).toBe('paragraph');
      if (flow.kind !== 'paragraph') throw new Error('expected paragraph');
      expect(flow.attrs?.widowControl).toBe(value !== false);

      const output = fromProseDoc(pm).package.document.content[0] as Paragraph;
      expect(output.formatting?.widowControl).toBe(value);
      const xml = serializeParagraph(output);
      expect(xml.includes('<w:widowControl')).toBe(value !== undefined);
      if (value === false) expect(xml).toContain('w:val="0"');
    }
  });

  test('serializes PM widowControl overrides without materializing an unchanged default', () => {
    const override = (source: boolean, current: boolean): Paragraph => {
      const pm = toProseDoc(
        docOf({
          type: 'paragraph',
          formatting: { widowControl: source },
          content: [{ type: 'run', content: [{ type: 'text', text: 'x' }] }],
        })
      );
      const sourceParagraph = pm.child(0);
      const changed = schema.node('doc', pm.attrs, [
        schema.node(
          'paragraph',
          { ...sourceParagraph.attrs, widowControl: current },
          sourceParagraph.content
        ),
      ]);
      return fromProseDoc(changed).package.document.content[0] as Paragraph;
    };

    const disabled = override(true, false);
    expect(disabled.formatting?.widowControl).toBe(false);
    expect(serializeParagraph(disabled)).toContain('<w:widowControl w:val="0"/>');

    const enabled = override(false, true);
    expect(enabled.formatting?.widowControl).toBe(true);
    expect(serializeParagraph(enabled)).toContain('<w:widowControl/>');

    const omitted = paragraph([{ type: 'run', content: [{ type: 'text', text: 'x' }] }]);
    const unchanged = fromProseDoc(toProseDoc(docOf(omitted))).package.document
      .content[0] as Paragraph;
    expect(unchanged.formatting?.widowControl).toBeUndefined();
    expect(serializeParagraph(unchanged)).not.toContain('<w:widowControl');
  });

  test('paragraph-property rejection restores and serializes widowControl', () => {
    const rejectWidowChange = (
      current: boolean,
      previousFormatting: ParagraphFormatting
    ): { paragraph: Paragraph; pmWidowControl: unknown } => {
      const input: Paragraph = {
        type: 'paragraph',
        formatting: { widowControl: current },
        propertyChanges: [
          {
            type: 'paragraphPropertyChange',
            info: { id: 77, author: 'Reviewer' },
            previousFormatting,
            currentFormatting: { widowControl: current },
          },
        ],
        content: [{ type: 'run', content: [{ type: 'text', text: 'x' }] }],
      };
      let state = EditorState.create({ schema, doc: toProseDoc(docOf(input)) });
      expect(
        rejectChangeById(77)(state, (transaction) => {
          state = state.apply(transaction);
        })
      ).toBe(true);
      return {
        paragraph: fromProseDoc(state.doc).package.document.content[0] as Paragraph,
        pmWidowControl: state.doc.child(0).attrs.widowControl,
      };
    };

    const { paragraph: output } = rejectWidowChange(false, { widowControl: true });
    expect(output.formatting?.widowControl).toBe(true);
    expect(output.propertyChanges).toBeUndefined();
    expect(serializeParagraph(output)).toContain('<w:widowControl/>');

    const { paragraph: restoredFalse } = rejectWidowChange(true, { widowControl: false });
    expect(restoredFalse.formatting?.widowControl).toBe(false);
    expect(restoredFalse.propertyChanges).toBeUndefined();
    expect(serializeParagraph(restoredFalse)).toContain('<w:widowControl w:val="0"/>');

    for (const current of [false, true]) {
      const restored = rejectWidowChange(current, {});
      expect(restored.pmWidowControl).toBeNull();
      expect(restored.paragraph.formatting?.widowControl).toBeUndefined();
      expect(restored.paragraph.propertyChanges).toBeUndefined();
      expect(serializeParagraph(restored.paragraph)).not.toContain('<w:widowControl');
    }
  });

  test('soft and no-break hyphens survive PM round trip in runs, hyperlinks, and insertions', () => {
    const plain: Run = {
      type: 'run',
      content: [
        { type: 'text', text: 'soft' },
        { type: 'softHyphen' },
        { type: 'text', text: 'non' },
        { type: 'noBreakHyphen' },
        { type: 'text', text: 'break' },
      ],
    };
    const hyperlink: Hyperlink = {
      type: 'hyperlink',
      href: 'https://example.com',
      children: [plain],
    };
    const insertion: Insertion = {
      type: 'insertion',
      info: { id: 1, author: 'A' },
      content: [plain],
    };

    const roundTripped = fromProseDoc(toProseDoc(docOf(paragraph([plain, hyperlink, insertion]))));
    const out = roundTripped.package.document.content[0] as Paragraph;

    expect(serializeParagraph(out)).toContain('<w:softHyphen/>');
    expect(serializeParagraph(out)).toContain('<w:noBreakHyphen/>');
  });

  test('w:sym survives as a symbol node and renders with its source font', () => {
    const input = paragraph([
      { type: 'run', content: [{ type: 'symbol', font: 'MS Gothic', char: '2612' }] },
    ]);
    const pm = toProseDoc(docOf(input));
    const symbol = pm.child(0).child(0);
    expect(symbol.type.name).toBe('symbol');

    const flows = buildBoxTree(pm);
    expect(flows[0].kind).toBe('paragraph');
    if (flows[0].kind !== 'paragraph') return;
    expect(flows[0].runs[0]).toMatchObject({ kind: 'text', text: '☒', fontFamily: 'MS Gothic' });

    const roundTripped = fromProseDoc(pm);
    expect(serializeParagraph(roundTripped.package.document.content[0] as Paragraph)).toContain(
      '<w:sym w:font="MS Gothic" w:char="2612"/>'
    );
  });

  test('w:sym keeps its original private-use-area char code while rendering the mapped glyph', () => {
    // Wingdings-style symbols store F0xx; display maps down to xx but the
    // serialized w:char must stay verbatim.
    const pm = toProseDoc(
      docOf(
        paragraph([{ type: 'run', content: [{ type: 'symbol', font: 'Wingdings', char: 'F0FC' }] }])
      )
    );
    const symbol = pm.child(0).child(0);
    expect(symbol.type.name).toBe('symbol');
    expect(symbol.attrs.text).toBe(String.fromCodePoint(0xfc));

    const xml = serializeParagraph(fromProseDoc(pm).package.document.content[0] as Paragraph);
    expect(xml).toContain('<w:sym w:font="Wingdings" w:char="F0FC"/>');
  });

  test('w:sym round-trips inside hyperlinks, tracked insertions, and inline SDTs', () => {
    const symbolRun: Run = {
      type: 'run',
      content: [{ type: 'symbol', font: 'MS Gothic', char: '2612' }],
      formatting: { bold: true },
    };
    const hyperlink: Hyperlink = {
      type: 'hyperlink',
      href: 'https://example.com',
      children: [symbolRun],
    };
    const insertion: Insertion = {
      type: 'insertion',
      info: { id: 7, author: 'A' },
      content: [symbolRun],
    };
    const inlineSdt: InlineSdt = {
      type: 'inlineSdt',
      properties: { sdtType: 'richText' },
      content: [symbolRun],
    };

    const out = fromProseDoc(toProseDoc(docOf(paragraph([hyperlink, insertion, inlineSdt]))))
      .package.document.content[0] as Paragraph;

    const link = out.content.find((c) => c.type === 'hyperlink') as Hyperlink;
    expect(link).toBeDefined();
    expect(serializeParagraph(paragraph([link]))).toContain(
      '<w:sym w:font="MS Gothic" w:char="2612"/>'
    );

    const ins = out.content.find((c) => c.type === 'insertion') as Insertion;
    expect(ins).toBeDefined();
    expect(ins.info).toMatchObject({ id: 7, author: 'A' });
    const insRun = ins.content[0] as Run;
    expect(insRun.content).toEqual([{ type: 'symbol', font: 'MS Gothic', char: '2612' }]);
    // Run formatting (bold) survives alongside the tracked-change wrapper.
    expect(insRun.formatting?.bold).toBe(true);

    const sdt = out.content.find((c) => c.type === 'inlineSdt') as InlineSdt;
    expect(sdt).toBeDefined();
    expect(serializeParagraph(paragraph([sdt]))).toContain(
      '<w:sym w:font="MS Gothic" w:char="2612"/>'
    );
  });

  test('w:sym inside a tracked deletion stays inside w:del on round trip', () => {
    const deletion: Deletion = {
      type: 'deletion',
      info: { id: 9, author: 'B' },
      content: [{ type: 'run', content: [{ type: 'symbol', font: 'Symbol', char: 'F0B7' }] }],
    };
    const out = fromProseDoc(toProseDoc(docOf(paragraph([deletion])))).package.document
      .content[0] as Paragraph;
    const del = out.content.find((c) => c.type === 'deletion') as Deletion;
    expect(del).toBeDefined();
    const xml = serializeParagraph(out);
    expect(xml).toContain('<w:del');
    expect(xml).toContain('<w:sym w:font="Symbol" w:char="F0B7"/>');
  });

  test('simple fields serialize as w:fldSimple, including self-closing fields', () => {
    const withResult = serializeParagraph(
      paragraph([
        {
          type: 'simpleField',
          instruction: 'TITLE',
          fieldType: 'TITLE',
          content: [{ type: 'run', content: [{ type: 'text', text: 'Cached' }] }],
        },
      ])
    );
    expect(withResult).toContain('<w:fldSimple w:instr="TITLE">');
    expect(withResult).toContain('<w:t>Cached</w:t></w:r></w:fldSimple>');
    expect(withResult).not.toContain('w:fldCharType="begin"');

    const selfClosing = serializeParagraph(
      paragraph([{ type: 'simpleField', instruction: 'PAGE', fieldType: 'PAGE', content: [] }])
    );
    expect(selfClosing).toContain('<w:fldSimple w:instr="PAGE"/>');
  });

  test('fldSimple w:instr is XML-escaped and fldLock/dirty attributes survive', () => {
    // instr is attacker-controlled file data — quotes/ampersands/angle brackets
    // must not break out of the attribute (garbage strings like "[object
    // Object]" must also pass through untouched).
    const xml = serializeParagraph(
      paragraph([
        {
          type: 'simpleField',
          instruction: 'DATE \\@ "d<d>" & [object Object]',
          fieldType: 'DATE',
          fldLock: true,
          dirty: true,
          content: [],
        },
      ])
    );
    expect(xml).toContain(
      '<w:fldSimple w:instr="DATE \\@ &quot;d&lt;d&gt;&quot; &amp; [object Object]" w:fldLock="true" w:dirty="true"/>'
    );
  });

  test('simple field keeps w:fldSimple form and attributes through the PM round-trip', () => {
    const input = paragraph([
      {
        type: 'simpleField',
        instruction: 'TITLE',
        fieldType: 'TITLE',
        fldLock: true,
        content: [{ type: 'run', content: [{ type: 'text', text: 'Cached' }] }],
      },
    ]);

    const out = fromProseDoc(toProseDoc(docOf(input))).package.document.content[0] as Paragraph;
    const field = out.content[0];
    expect(field).toMatchObject({ type: 'simpleField', instruction: 'TITLE', fldLock: true });
    if (field.type !== 'simpleField') return;
    expect(field.content).toEqual([{ type: 'run', content: [{ type: 'text', text: 'Cached' }] }]);

    const xml = serializeParagraph(out);
    expect(xml).toContain('<w:fldSimple w:instr="TITLE" w:fldLock="true">');
    expect(xml).toContain('<w:t>Cached</w:t>');
    expect(xml).not.toContain('<w:fldChar');
  });

  test('empty simple fields stay self-closing through the PM round-trip', () => {
    const input = paragraph([
      { type: 'simpleField', instruction: '[object Object]', fieldType: 'UNKNOWN', content: [] },
    ]);

    const out = fromProseDoc(toProseDoc(docOf(input))).package.document.content[0] as Paragraph;
    const xml = serializeParagraph(out);

    expect(xml).toContain('<w:fldSimple w:instr="[object Object]"/>');
    expect(xml).not.toContain('<w:t xml:space="preserve"> </w:t>');
  });

  test('complex fields still serialize as fldChar begin/separate/end', () => {
    const xml = serializeParagraph(
      paragraph([
        {
          type: 'complexField',
          instruction: 'PAGE',
          fieldType: 'PAGE',
          fieldCode: [],
          fieldResult: [{ type: 'run', content: [{ type: 'text', text: '3' }] }],
        },
      ])
    );
    expect(xml).toContain('w:fldCharType="begin"');
    expect(xml).toContain('w:fldCharType="separate"');
    expect(xml).toContain('w:fldCharType="end"');
    expect(xml).not.toContain('<w:fldSimple');

    const roundTripped = fromProseDoc(
      toProseDoc(
        docOf(
          paragraph([
            {
              type: 'complexField',
              instruction: 'PAGE',
              fieldType: 'PAGE',
              fieldCode: [],
              fieldResult: [{ type: 'run', content: [{ type: 'text', text: '3' }] }],
            },
          ])
        )
      )
    );
    const outXml = serializeParagraph(roundTripped.package.document.content[0] as Paragraph);
    expect(outXml).toContain('w:fldCharType="begin"');
    expect(outXml).not.toContain('<w:fldSimple');
  });

  describe('hard page break provenance (sourceLeadingPageBreak)', () => {
    function roundTripFirstParagraphXml(doc: Document): string {
      return serializeParagraph(
        fromProseDoc(toProseDoc(doc), doc).package.document.content[0] as Paragraph
      );
    }

    test('source leading hard page breaks serialize as w:br while pageBreakBefore remains distinct', () => {
      const hardBreakPara = paragraph([
        { type: 'run', content: [{ type: 'text', text: 'After' }] },
      ]);
      hardBreakPara.sourceLeadingPageBreak = true;
      hardBreakPara.content.unshift({
        type: 'run',
        content: [{ type: 'break', breakType: 'page' }],
      });

      const hardBreakXml = serializeParagraph(
        fromProseDoc(toProseDoc(docOf(hardBreakPara))).package.document.content[0] as Paragraph
      );
      expect(hardBreakXml).toContain('<w:br w:type="page"/>');
      expect(hardBreakXml).not.toContain('<w:pageBreakBefore/>');

      const pageBreakBeforePara = paragraph([
        { type: 'run', content: [{ type: 'text', text: 'After' }] },
      ]);
      pageBreakBeforePara.formatting = { pageBreakBefore: true };
      const pprBreakXml = serializeParagraph(
        fromProseDoc(toProseDoc(docOf(pageBreakBeforePara))).package.document
          .content[0] as Paragraph
      );
      expect(pprBreakXml).toContain('<w:pageBreakBefore/>');
      expect(pprBreakXml).not.toContain('<w:br w:type="page"/>');
    });

    test('parser flags a leading w:br page break and it round-trips as w:br', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>After hard break</w:t></w:r></w:p>
      </w:body></w:document>`);

      const para = body.content[0] as Paragraph;
      expect(para.sourceLeadingPageBreak).toBe(true);

      const doc = docOf(...body.content);
      const pm = toProseDoc(doc);
      expect(pm.child(0).attrs.pageBreakBefore).toBe(true);
      expect(pm.child(0).attrs.sourceLeadingPageBreak).toBe(true);

      const xml = roundTripFirstParagraphXml(doc);
      expect(xml).toContain('<w:br w:type="page"/>');
      expect(xml).not.toContain('<w:pageBreakBefore/>');
      expect(xml).toContain('<w:t>After hard break</w:t>');
    });

    test('parser skips empty w:t shells and non-content markers before the break', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p>
          <w:bookmarkStart w:id="1" w:name="anchor"/>
          <w:r><w:t></w:t></w:r>
          <w:r><w:br w:type="page"/></w:r>
          <w:bookmarkEnd w:id="1"/>
          <w:r><w:t>Text</w:t></w:r>
        </w:p>
      </w:body></w:document>`);
      expect((body.content[0] as Paragraph).sourceLeadingPageBreak).toBe(true);
    });

    test('parser does not flag explicit pageBreakBefore, mid-paragraph breaks, or plain text', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>pPr break</w:t></w:r></w:p>
        <w:p><w:r><w:t>Before</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>
        <w:p><w:r><w:t>Plain</w:t></w:r></w:p>
      </w:body></w:document>`);
      for (const block of body.content) {
        expect((block as Paragraph).sourceLeadingPageBreak).toBeUndefined();
      }
    });

    test('break-only paragraph keeps forcing a layout page break and round-trips as w:br', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:r><w:t>Before</w:t></w:r></w:p>
        <w:p><w:r><w:br w:type="page"/></w:r></w:p>
        <w:p><w:r><w:t>After</w:t></w:r></w:p>
      </w:body></w:document>`);
      const doc = docOf(...body.content);
      const pm = toProseDoc(doc);

      // Layout must still see the break-only paragraph as a structural page break.
      const blocks = buildBoxTree(pm);
      expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'pageBreak', 'paragraph']);

      const roundTripped = fromProseDoc(pm, doc);
      expect(roundTripped.package.document.content).toHaveLength(3);
      const breakXml = serializeParagraph(roundTripped.package.document.content[1] as Paragraph);
      expect(breakXml).toContain('<w:br w:type="page"/>');
      expect(breakXml).not.toContain('<w:pageBreakBefore/>');
    });

    test('deleted text and page breaks round-trip without entering effective layout', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:r><w:t>Before</w:t></w:r><w:del w:id="803" w:author="Author">
          <w:r><w:cr/></w:r><w:r><w:br w:type="page"/></w:r>
        </w:del></w:p>
        <w:p><w:r><w:t>After</w:t></w:r></w:p>
      </w:body></w:document>`);
      const doc = docOf(...body.content);
      const pm = toProseDoc(doc);

      const hardBreaks: PMNode[] = [];
      pm.child(0).forEach((node) => {
        if (node.type.name === 'hardBreak') hardBreaks.push(node);
      });
      expect(hardBreaks).toHaveLength(2);
      expect(
        hardBreaks.every((node) => node.marks.some((mark) => mark.type.name === 'deletion'))
      ).toBe(true);

      expect(buildBoxTree(pm).map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
      const firstFlow = buildBoxTree(pm)[0];
      expect(firstFlow.kind).toBe('paragraph');
      if (firstFlow.kind !== 'paragraph') return;
      expect(firstFlow.runs.some((run) => run.kind === 'lineBreak')).toBe(false);

      const xml = serializeParagraph(
        fromProseDoc(pm, doc).package.document.content[0] as Paragraph
      );
      expect(xml).toContain('<w:del w:id="803"');
      expect(xml).toContain('<w:br w:type="textWrapping"/>');
      expect(xml).toContain('<w:br w:type="page"/>');
    });

    test('paragraph with text keeps driving layout pagination via pageBreakBefore attr', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>Chapter</w:t></w:r></w:p>
      </w:body></w:document>`);
      const blocks = buildBoxTree(toProseDoc(docOf(...body.content)));
      expect(blocks[0].kind).toBe('paragraph');
      if (blocks[0].kind !== 'paragraph') return;
      expect(blocks[0].attrs?.pageBreakBefore).toBe(true);
    });

    test('explicit pPr pageBreakBefore parsed from XML still serializes as pageBreakBefore', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Chapter</w:t></w:r></w:p>
      </w:body></w:document>`);
      const xml = roundTripFirstParagraphXml(docOf(...body.content));
      expect(xml).toContain('<w:pageBreakBefore/>');
      expect(xml).not.toContain('<w:br w:type="page"/>');
    });

    test('source with BOTH pPr pageBreakBefore and a leading w:br keeps both on save', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:br w:type="page"/></w:r><w:r><w:t>Both</w:t></w:r></w:p>
      </w:body></w:document>`);
      const xml = roundTripFirstParagraphXml(docOf(...body.content));
      expect(xml).toContain('<w:pageBreakBefore/>');
      expect(xml).toContain('<w:br w:type="page"/>');
    });

    test('user-set pageBreakBefore on a fresh paragraph serializes as pPr, never as w:br', () => {
      const pmDoc = schema.node('doc', null, [
        schema.node('paragraph', { pageBreakBefore: true }, [schema.text('New chapter')]),
      ]);
      const xml = serializeParagraph(fromProseDoc(pmDoc).package.document.content[0] as Paragraph);
      expect(xml).toContain('<w:pageBreakBefore/>');
      expect(xml).not.toContain('<w:br w:type="page"/>');
    });

    test('new paragraphs default sourceLeadingPageBreak to null (no accidental provenance)', () => {
      const fresh = schema.node('paragraph', {}, [schema.text('plain')]);
      expect(fresh.attrs.sourceLeadingPageBreak).toBeNull();
      expect(fresh.attrs.pageBreakBefore).toBeNull();
    });

    test('provenance survives content edits: changed text still re-emits the hard break', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>Original</w:t></w:r></w:p>
      </w:body></w:document>`);
      const doc = docOf(...body.content);
      const pm = toProseDoc(doc);
      const para = pm.child(0);
      // Simulate a text edit: same attrs, different content.
      const edited = schema.node('doc', null, [
        schema.node('paragraph', para.attrs, [schema.text('Rewritten')]),
      ]);
      const xml = serializeParagraph(
        fromProseDoc(edited, doc).package.document.content[0] as Paragraph
      );
      expect(xml).toContain('<w:br w:type="page"/>');
      expect(xml).toContain('<w:t>Rewritten</w:t>');
      expect(xml).not.toContain('<w:pageBreakBefore/>');
    });

    test('stale provenance is ignored once pageBreakBefore is cleared (break removed by a command)', () => {
      const body = parseDocumentBody(`<w:document ${W}><w:body>
        <w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>Chapter</w:t></w:r></w:p>
      </w:body></w:document>`);
      const doc = docOf(...body.content);
      const pm = toProseDoc(doc);
      const para = pm.child(0);
      // Simulate a command (style application, tracked-change reject) that
      // clears the layout-driving attr but not the provenance flag.
      const cleared = schema.node('doc', null, [
        schema.node('paragraph', { ...para.attrs, pageBreakBefore: null }, para.content),
      ]);
      const xml = serializeParagraph(
        fromProseDoc(cleared, doc).package.document.content[0] as Paragraph
      );
      expect(xml).not.toContain('<w:br w:type="page"/>');
      expect(xml).not.toContain('<w:pageBreakBefore/>');
    });
  });

  test('section pgNumType parses, merges, and serializes before cols', () => {
    const body = parseDocumentBody(`<w:document ${W}><w:body><w:p/><w:sectPr>
      <w:lnNumType w:countBy="1"/>
      <w:pgNumType w:fmt="upperRoman" w:start="3" w:chapStyle="2" w:chapSep="hyphen"/>
      <w:cols w:num="2"/>
    </w:sectPr></w:body></w:document>`);

    expect(body.finalSectionProperties?.pageNumbers).toEqual({
      format: 'upperRoman',
      start: 3,
      chapterStyle: 2,
      chapterSeparator: 'hyphen',
    });

    const source: Document = { package: { document: body } };
    const pm = toProseDoc(source);
    const firstParagraph = pm.child(0);
    const edited = schema.node('doc', null, [
      schema.node('paragraph', firstParagraph.attrs, [schema.text('Edited before save')]),
    ]);
    const saved = fromProseDoc(edited, source);
    expect(saved.package.document.finalSectionProperties?.pageNumbers).toEqual({
      format: 'upperRoman',
      start: 3,
      chapterStyle: 2,
      chapterSeparator: 'hyphen',
    });
    expect(serializeDocumentBody(saved.package.document)).toContain(
      '<w:pgNumType w:fmt="upperRoman" w:start="3" w:chapStyle="2" w:chapSep="hyphen"/>'
    );

    const xml = serializeSectionProperties({
      lineNumbers: { countBy: 1 },
      pageNumbers: {},
      columnCount: 2,
    });
    expect(xml).toMatch(/<w:lnNumType[^>]*\/><w:pgNumType\/><w:cols/s);
  });

  test('nested tblpPr tblOverlap is parsed, with direct sibling precedence', () => {
    const nestedTblPr = parseXml(
      `<w:tblPr ${W}><w:tblpPr><w:tblOverlap w:val="never"/></w:tblpPr></w:tblPr>`
    ).elements![0];
    expect(parseTableProperties(nestedTblPr)?.overlap).toBe('never');

    const directTblPr = parseXml(
      `<w:tblPr ${W}><w:tblOverlap w:val="overlap"/><w:tblpPr><w:tblOverlap w:val="never"/></w:tblpPr></w:tblPr>`
    ).elements![0];
    expect(parseTableProperties(directTblPr)?.overlap).toBe('overlap');
  });

  test('multi-paragraph TOC complex field inside block SDT is raw-preserved when untouched', () => {
    const body = parseDocumentBody(`<w:document ${W}><w:body>
      <w:sdt><w:sdtPr><w:alias w:val="toc"/></w:sdtPr><w:sdtContent>
        <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC \\h \\o "1-5"</w:instrText></w:r></w:p>
        <w:p><w:r><w:t>Heading</w:t></w:r></w:p>
        <w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
      </w:sdtContent></w:sdt>
    </w:body></w:document>`);

    const roundTripped = fromProseDoc(toProseDoc(docOf(...body.content)));
    const xml = serializeDocumentBody(roundTripped.package.document);
    expect(xml).toContain('TOC \\h \\o "1-5"');
    expect(xml).toContain('w:fldCharType="begin"');
    expect(xml).toContain('w:fldCharType="end"');
  });

  test('untouched TOC with tab leaders in the cached result keeps raw preservation', () => {
    // The parser-side fingerprint counts tabs as \t; PM textContent skips tab
    // leaf nodes. The preservation guard must use the tab-aware fingerprint or
    // every TOC with page-number tab leaders loses its raw XML on save.
    const body = parseDocumentBody(`<w:document ${W}><w:body>
      <w:sdt><w:sdtPr><w:alias w:val="toc"/></w:sdtPr><w:sdtContent>
        <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC \\h \\o "1-5"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>
        <w:p><w:r><w:t>Heading One</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>3</w:t></w:r></w:p>
        <w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
      </w:sdtContent></w:sdt>
    </w:body></w:document>`);

    const parsedSdt = body.content[0] as BlockSdt;
    expect(parsedSdt.rawPreserveText).toBe('Heading One\t3');

    const roundTripped = fromProseDoc(toProseDoc(docOf(...body.content)));
    const outSdt = roundTripped.package.document.content[0] as BlockSdt;
    expect(outSdt.rawPreserveXml).toBe(parsedSdt.rawPreserveXml);
    const xml = serializeDocumentBody(roundTripped.package.document);
    expect(xml).toContain('w:fldCharType="separate"');
    expect(xml).toContain('<w:tab/>');
  });

  test('synthetic empty paragraph after terminal column break is not exported', () => {
    const body = parseDocumentBody(`<w:document ${W}><w:body>
      <w:p><w:r><w:t>Before</w:t><w:br w:type="column"/></w:r></w:p>
      <w:p><w:r><w:t>After</w:t></w:r></w:p>
    </w:body></w:document>`);

    const pm = toProseDoc(docOf(...body.content));
    expect(pm.childCount).toBe(4);
    expect(pm.child(2).type.name).toBe('paragraph');
    expect(pm.child(2).childCount).toBe(0);
    expect(pm.child(2).attrs.sourceColumnBreakContinuation).toBe(true);

    const roundTripped = fromProseDoc(pm);
    expect(roundTripped.package.document.content).toHaveLength(3);
    const xml = serializeDocumentBody(roundTripped.package.document);
    expect((xml.match(/<w:p(?:\s|>)/g) ?? []).length).toBe(3);
    expect(roundTripped.package.document.content[2]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'run', content: [{ type: 'text', text: 'After' }] }],
    });
    expect(xml).toContain('<w:br w:type="column"/>');
    expect(xml).toContain('<w:t>After</w:t>');
  });

  test('processNewImages reuses unchanged image rels and dedupes new media', async () => {
    const zip = new JSZip();
    zip.file('word/media/image1.png', new Uint8Array([1, 2, 3]));
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
        '</Relationships>'
    );
    zip.file('[Content_Types].xml', '<Types></Types>');

    const unchanged: Image = {
      type: 'image',
      rId: 'rId5',
      src: dataUrl([1, 2, 3]),
      size: { width: 1, height: 1 },
      wrap: { type: 'inline' },
    };
    const insertedA: Image = {
      type: 'image',
      rId: '',
      src: dataUrl([9, 9]),
      size: { width: 1, height: 1 },
      wrap: { type: 'inline' },
    };
    const insertedB: Image = {
      type: 'image',
      rId: '',
      src: dataUrl([9, 9]),
      size: { width: 1, height: 1 },
      wrap: { type: 'inline' },
    };

    await processNewImages(
      [
        {
          relsPath: 'word/_rels/document.xml.rels',
          blocks: [imageParagraph(unchanged), imageParagraph(insertedA), imageParagraph(insertedB)],
        },
      ],
      zip,
      1
    );

    expect(unchanged.rId).toBe('rId5');
    expect(insertedA.rId).toBe(insertedB.rId);
    expect(insertedA.rId).toMatch(/^rId\d+$/);
    expect(zip.file('word/media/image2.png')).toBeTruthy();
    expect(zip.file('word/media/image3.png')).toBeNull();
    // The single shared rel for the deduped pair must be registered.
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('text');
    expect(rels).toContain(`Id="${insertedA.rId}"`);
  });

  test('processNewImages leaves rels untouched when every image reuses its rel', async () => {
    const zip = new JSZip();
    zip.file('word/media/image1.png', new Uint8Array([1, 2, 3]));
    const originalRels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      IMAGE_REL('rId5', 'media/image1.png') +
      '</Relationships>';
    zip.file('word/_rels/document.xml.rels', originalRels);
    zip.file('[Content_Types].xml', '<Types></Types>');

    // Same bytes, e.g. only wrap/resize/crop changed — must not create media.
    const resizedOnly = image({ rId: 'rId5', src: dataUrl([1, 2, 3]) });
    resizedOnly.size = { width: 500, height: 500 };

    await processNewImages(
      [{ relsPath: 'word/_rels/document.xml.rels', blocks: [imageParagraph(resizedOnly)] }],
      zip,
      1
    );

    expect(resizedOnly.rId).toBe('rId5');
    expect(zip.file('word/media/image2.png')).toBeNull();
    expect(await zip.file('word/_rels/document.xml.rels')!.async('text')).toBe(originalRels);
  });

  test('processNewImages writes new media and rel when bytes differ (image replacement)', async () => {
    const zip = new JSZip();
    zip.file('word/media/image1.png', new Uint8Array([1, 2, 3]));
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        IMAGE_REL('rId5', 'media/image1.png') +
        '</Relationships>'
    );
    zip.file('[Content_Types].xml', '<Types></Types>');

    const replaced = image({ rId: 'rId5', src: dataUrl([7, 7, 7]) });

    await processNewImages(
      [{ relsPath: 'word/_rels/document.xml.rels', blocks: [imageParagraph(replaced)] }],
      zip,
      1
    );

    expect(replaced.rId).not.toBe('rId5');
    expect(replaced.rId).toMatch(/^rId\d+$/);
    const newMedia = zip.file('word/media/image2.png');
    expect(newMedia).toBeTruthy();
    expect(new Uint8Array(await newMedia!.async('arraybuffer'))).toEqual(new Uint8Array([7, 7, 7]));
    // Original media is preserved (other content may still reference it).
    expect(new Uint8Array(await zip.file('word/media/image1.png')!.async('arraybuffer'))).toEqual(
      new Uint8Array([1, 2, 3])
    );
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('text');
    expect(rels).toContain(`Id="${replaced.rId}"`);
    expect(rels).toContain('Target="media/image2.png"');
  });

  test('processNewImages does not trust an rId from another part (part-locality)', async () => {
    const zip = new JSZip();
    zip.file('word/media/image1.png', new Uint8Array([1, 2, 3]));
    zip.file('word/media/image2.png', new Uint8Array([4, 4, 4]));
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        IMAGE_REL('rId5', 'media/image1.png') +
        '</Relationships>'
    );
    // Same rId number exists in the header rels but points at different media.
    zip.file(
      'word/_rels/header1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        IMAGE_REL('rId5', 'media/image2.png') +
        '</Relationships>'
    );
    zip.file('[Content_Types].xml', '<Types></Types>');

    // Image copy-pasted from the body into the header carries the body's rId,
    // which must not be reused since it resolves to different bytes here.
    const pasted = image({ rId: 'rId5', src: dataUrl([1, 2, 3]) });

    await processNewImages(
      [{ relsPath: 'word/_rels/header1.xml.rels', blocks: [imageParagraph(pasted)] }],
      zip,
      1
    );

    expect(pasted.rId).not.toBe('rId5');
    const headerRels = await zip.file('word/_rels/header1.xml.rels')!.async('text');
    expect(headerRels).toContain(`Id="${pasted.rId}"`);
    expect(headerRels).toContain('Target="media/image3.png"');
    // Body rels untouched.
    const docRels = await zip.file('word/_rels/document.xml.rels')!.async('text');
    expect(docRels).not.toContain('image3.png');
  });

  test('processNewImages falls back to new media when the rel target is missing (corrupt doc)', async () => {
    const zip = new JSZip();
    // rId5 resolves in rels but the media file it points at does not exist.
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        IMAGE_REL('rId5', 'media/missing.png') +
        '</Relationships>'
    );
    zip.file('[Content_Types].xml', '<Types></Types>');

    const img = image({ rId: 'rId5', src: dataUrl([1, 2, 3]) });

    await processNewImages(
      [{ relsPath: 'word/_rels/document.xml.rels', blocks: [imageParagraph(img)] }],
      zip,
      1
    );

    expect(img.rId).toMatch(/^rId\d+$/);
    expect(zip.file('word/media/image1.png')).toBeTruthy();
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('text');
    expect(rels).toContain(`Id="${img.rId}"`);
  });

  test('processNewImages never reuses external-mode relationships', async () => {
    const zip = new JSZip();
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.example/x.png" TargetMode="External"/>' +
        '</Relationships>'
    );
    zip.file('[Content_Types].xml', '<Types></Types>');

    const img = image({ rId: 'rId5', src: dataUrl([1, 2, 3]) });

    await processNewImages(
      [{ relsPath: 'word/_rels/document.xml.rels', blocks: [imageParagraph(img)] }],
      zip,
      1
    );

    // A fresh internal media + rel is created; the external rel is not reused.
    expect(img.rId).not.toBe('rId5');
    expect(zip.file('word/media/image1.png')).toBeTruthy();
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('text');
    expect(rels).toContain(`Id="${img.rId}"`);
    expect(rels).toContain('Target="media/image1.png"');
  });

  test('processNewImages collects images nested in hyperlinks, inline SDTs, and block SDTs in table cells', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types></Types>');

    const inHyperlink = image({ src: dataUrl([1]) });
    const inInlineSdt = image({ src: dataUrl([2]) });
    const inNestedBlockSdt = image({ src: dataUrl([3]) });
    const inInsertion = image({ src: dataUrl([4]) });

    const hyperlink: Hyperlink = {
      type: 'hyperlink',
      href: 'https://example.com',
      children: [{ type: 'run', content: [{ type: 'drawing', image: inHyperlink }] }],
    };
    const inlineSdt: InlineSdt = {
      type: 'inlineSdt',
      properties: { sdtType: 'picture' },
      content: [{ type: 'run', content: [{ type: 'drawing', image: inInlineSdt }] }],
    };
    const insertion: Insertion = {
      type: 'insertion',
      info: { id: 1, author: 'A' },
      content: [{ type: 'run', content: [{ type: 'drawing', image: inInsertion }] }],
    };
    const blockSdtInCell: BlockSdt = {
      type: 'blockSdt',
      properties: { sdtType: 'richText' },
      content: [imageParagraph(inNestedBlockSdt)],
    };

    await processNewImages(
      [
        {
          relsPath: 'word/_rels/document.xml.rels',
          blocks: [
            paragraph([hyperlink, inlineSdt, insertion]),
            {
              type: 'table',
              rows: [
                {
                  type: 'tableRow',
                  cells: [{ type: 'tableCell', content: [blockSdtInCell] }],
                },
              ],
            },
          ],
        },
      ],
      zip,
      1
    );

    for (const img of [inHyperlink, inInlineSdt, inNestedBlockSdt, inInsertion]) {
      expect(img.rId).toMatch(/^rId\d+$/);
    }
    // Four distinct payloads → four media files, no more.
    expect(zip.file('word/media/image4.png')).toBeTruthy();
    expect(zip.file('word/media/image5.png')).toBeNull();
  });
});
