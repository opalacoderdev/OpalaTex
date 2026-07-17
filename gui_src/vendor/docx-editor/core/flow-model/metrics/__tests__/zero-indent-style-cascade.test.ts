import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EditorState } from 'prosemirror-state';

import { parseParagraph } from '../../../docx/paragraphParser';
import { parseStyles } from '../../../docx/styleParser';
import { parseXmlDocument, type XmlElement } from '../../../docx/xmlParser';
import { toProseDoc } from '../../../prosemirror/conversion/toProseDoc';
import { fromProseDoc } from '../../../prosemirror/conversion/fromProseDoc';
import { serializeParagraph } from '../../../docx/serializer/paragraphSerializer';
import { buildBoxTree } from '../../buildBoxTree';
import { measureTextWidth, resetCanvasContext } from '../textMetrics';
import { paragraphLayout } from '../paragraphLayout';
import { paintParagraphFragment } from '../../../painter-model/renderParagraph';
import type { Document, Paragraph, StyleDefinitions } from '../../../types/document';
import type {
  MeasuredLine,
  ParagraphBlock,
  ParagraphFragment,
  TextRun,
} from '../../../pagination-model/types';
import type { RenderContext } from '../../../painter-model/paintPage';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const STYLE = { fontFamily: 'Calibri', fontSize: 11 };
const TEXT = 'Lorem ipsum dolor sit Amet, consectetur adipiscing elit.';
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext | undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(type: string) {
    if (type === '2d') {
      return {
        font: '',
        measureText: (text: string) => ({ width: text.length * 4 }),
      } as unknown as CanvasRenderingContext2D;
    }
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;
  resetCanvasContext();
});

afterAll(() => {
  if (originalGetContext) HTMLCanvasElement.prototype.getContext = originalGetContext;
  resetCanvasContext();
  GlobalRegistrator.unregister();
});

const styleMap = parseStyles(
  `<w:styles ${W}>
    <w:style w:type="paragraph" w:styleId="BodyText">
      <w:name w:val="Body Text"/>
      <w:pPr><w:ind w:left="1440" w:hanging="720"/></w:pPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="RightText">
      <w:name w:val="Right Text"/>
      <w:pPr><w:ind w:right="360" w:hanging="720"/></w:pPr>
    </w:style>
  </w:styles>`,
  null
);
const styleDefinitions: StyleDefinitions = { styles: [...styleMap.values()] };

function parseBodyTextParagraph(
  indentation: string,
  runContent = `<w:t>${TEXT}</w:t>`,
  styleId = 'BodyText'
): Paragraph {
  const root = parseXmlDocument(
    `<w:p ${W} ${W14} w14:paraId="584D912D">
      <w:pPr>
        <w:pStyle w:val="${styleId}"/>
        <w:ind ${indentation}/>
      </w:pPr>
      <w:r>${runContent}</w:r>
    </w:p>`
  ) as XmlElement | null;
  if (!root) throw new Error('Failed to parse paragraph XML');
  return parseParagraph(root, styleMap, null, null);
}

function toParagraphBlock(paragraph: Paragraph): ParagraphBlock {
  const doc: Document = {
    package: {
      document: { content: [paragraph] },
      styles: styleDefinitions,
    },
  };
  const pmDoc = toProseDoc(doc, { styles: styleDefinitions });
  return buildBoxTree(pmDoc, {}).find((block) => block.kind === 'paragraph') as ParagraphBlock;
}

function toParagraphAttrs(paragraph: Paragraph): Record<string, unknown> {
  const doc: Document = {
    package: {
      document: { content: [paragraph] },
      styles: styleDefinitions,
    },
  };
  return toProseDoc(doc, { styles: styleDefinitions }).child(0).attrs;
}

function documentWithParagraph(paragraph: Paragraph): Document {
  return {
    package: {
      document: { content: [paragraph] },
      styles: styleDefinitions,
    },
  };
}

function editParagraphAttrs(input: Document, patch: Record<string, unknown>): Paragraph {
  const pmDoc = toProseDoc(input, { styles: styleDefinitions });
  const state = EditorState.create({ doc: pmDoc });
  const paragraph = pmDoc.child(0);
  const edited = state.tr.setNodeMarkup(0, undefined, {
    ...paragraph.attrs,
    ...patch,
  }).doc;
  return fromProseDoc(edited, input).package.document.content[0] as Paragraph;
}

function lineText(block: ParagraphBlock, line: MeasuredLine): string {
  const textRuns = block.runs as TextRun[];
  let text = '';
  for (let runIndex = line.fromRun; runIndex <= line.toRun; runIndex++) {
    const run = textRuns[runIndex];
    if (!run || run.kind !== 'text') continue;
    const from = runIndex === line.fromRun ? line.fromChar : 0;
    const to = runIndex === line.toRun ? line.toChar : run.text.length;
    text += run.text.slice(from, to);
  }
  return text.trimEnd();
}

describe('direct zero w:ind clears paragraph-style indentation', () => {
  for (const [boundary, clone] of [
    ['structuredClone', (paragraph: Paragraph) => structuredClone(paragraph)],
    ['JSON', (paragraph: Paragraph) => JSON.parse(JSON.stringify(paragraph)) as Paragraph],
  ] as const) {
    test(`explicit clear survives ${boundary} transport`, () => {
      const paragraph = clone(parseBodyTextParagraph('w:left="0" w:firstLine="0"'));
      expect(toParagraphAttrs(paragraph)).toMatchObject({
        indentLeft: 0,
        indentFirstLine: 0,
        hangingIndent: false,
      });
      expect(toParagraphBlock(paragraph).attrs?.indent).toEqual({
        left: 0,
        firstLine: 0,
      });
    });
  }

  test('unchanged effective indentation preserves source zero OOXML', () => {
    const paragraph = parseBodyTextParagraph('w:left="0" w:firstLine="0"');
    const input = documentWithParagraph(paragraph);
    const output = fromProseDoc(toProseDoc(input, { styles: styleDefinitions }), input).package
      .document.content[0] as Paragraph;

    expect(serializeParagraph(output)).toContain('<w:ind w:left="0" w:firstLine="0"/>');
    expect(output.formatting?._indentProvenance?.source).toBeDefined();
    expect(output.formatting?._indentProvenance?.baseline).toBeUndefined();
    expect(output.formatting?._indentProvenance?.resolvedNumbering).toBeUndefined();
  });

  test('edited PM indentation replaces source formatting on save', () => {
    const input = documentWithParagraph(parseBodyTextParagraph('w:left="0" w:firstLine="0"'));
    const output = editParagraphAttrs(input, {
      indentLeft: 720,
      indentRight: 240,
      indentFirstLine: 180,
      hangingIndent: false,
    });
    const xml = serializeParagraph(output);

    expect(xml).toContain('<w:ind w:left="720" w:right="240" w:firstLine="180"/>');
    expect(xml).not.toContain('w:left="0"');
    expect(output.formatting?._indentProvenance).toBeUndefined();
  });

  test('edited hanging and cleared indentation serialize current PM values', () => {
    const input = documentWithParagraph(parseBodyTextParagraph('w:left="0" w:firstLine="0"'));
    const hanging = editParagraphAttrs(input, {
      indentLeft: 720,
      indentRight: 240,
      indentFirstLine: -360,
      hangingIndent: true,
    });
    expect(serializeParagraph(hanging)).toContain(
      '<w:ind w:left="720" w:right="240" w:hanging="360"/>'
    );

    const cleared = editParagraphAttrs(input, {
      indentLeft: 0,
      indentRight: 0,
      indentFirstLine: 0,
      hangingIndent: false,
    });
    expect(serializeParagraph(cleared)).toContain(
      '<w:ind w:left="0" w:right="0" w:firstLine="0"/>'
    );
  });

  test('null PM attrs save a stable explicit clear across reload', () => {
    const input = documentWithParagraph(parseBodyTextParagraph('w:left="0" w:firstLine="0"'));
    const cleared = editParagraphAttrs(input, {
      indentLeft: null,
      indentRight: null,
      indentFirstLine: null,
      hangingIndent: null,
    });
    const xml = serializeParagraph(cleared);
    expect(xml).toContain('<w:ind w:left="0" w:right="0" w:firstLine="0"/>');

    const serializedInd = xml.match(/<w:ind ([^>]*)\/>/)?.[1];
    expect(serializedInd).toBeDefined();
    const reparsed = parseBodyTextParagraph(serializedInd!);
    expect(toParagraphBlock(reparsed).attrs?.indent).toEqual({
      left: 0,
      right: 0,
      firstLine: 0,
    });
  });

  test('unchanged aliases and zero lexemes survive direct, clone, JSON, and PM roundtrips', () => {
    const expected = '<w:ind w:start="+000" w:end="-000" w:firstLine="-000"/>';
    const parsed = parseBodyTextParagraph('w:start="+000" w:end="-000" w:firstLine="-000"');

    for (const paragraph of [
      parsed,
      structuredClone(parsed),
      JSON.parse(JSON.stringify(parsed)) as Paragraph,
    ]) {
      expect(serializeParagraph(paragraph)).toContain(expected);
    }

    const input = documentWithParagraph(parsed);
    const output = fromProseDoc(toProseDoc(input, { styles: styleDefinitions }), input).package
      .document.content[0] as Paragraph;
    expect(serializeParagraph(output)).toContain(expected);
  });

  test('real parse → PM → flow measurement uses the cleared style indent', () => {
    const paragraph = parseBodyTextParagraph('w:left="0" w:firstLine="0"');
    expect(paragraph.formatting?.indentLeft).toBe(0);
    expect(paragraph.formatting?.indentFirstLine).toBe(0);
    expect(toParagraphAttrs(paragraph)).toMatchObject({
      indentLeft: 0,
      indentFirstLine: 0,
      hangingIndent: false,
    });

    const block = toParagraphBlock(paragraph);
    expect(block.attrs?.indent).toEqual({ left: 0, firstLine: 0 });

    const throughAmet = measureTextWidth('Lorem ipsum dolor sit Amet,', STYLE);
    const throughConsectetur = measureTextWidth('Lorem ipsum dolor sit Amet, consectetur', STYLE);
    const containerWidth = (throughAmet + throughConsectetur) / 2;
    const measured = paragraphLayout(block, containerWidth);
    expect(lineText(block, measured.lines[0])).toBe('Lorem ipsum dolor sit Amet,');
    expect(lineText(block, measured.lines[1]).startsWith('consectetur')).toBe(true);

    const fragment: ParagraphFragment = {
      kind: 'paragraph',
      nodeId: block.id,
      x: 0,
      y: 0,
      width: containerWidth,
      height: measured.totalHeight,
      fromLine: 0,
      toLine: measured.lines.length,
    };
    const context: RenderContext = { pageNumber: 1, totalPages: 1, section: 'body' };
    const painted = paintParagraphFragment(fragment, block, measured, context);
    const lines = [...painted.querySelectorAll<HTMLElement>(':scope > .layout-line')];
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => parseFloat(line.style.paddingLeft || '0') === 0)).toBe(true);
    expect(lines.every((line) => parseFloat(getComputedStyle(line).textIndent || '0') === 0)).toBe(
      true
    );
  });

  test('five source w:cr remain hard lines without reapplying first-line indentation', () => {
    const paragraph = parseBodyTextParagraph(
      'w:left="0" w:firstLine="0"',
      '<w:t>one</w:t><w:cr/><w:t>two</w:t><w:cr/><w:t>three</w:t><w:cr/><w:t>four</w:t><w:cr/><w:t>five</w:t><w:cr/><w:t>six</w:t>'
    );
    const block = toParagraphBlock(paragraph);
    expect(block.runs.filter((run) => run.kind === 'lineBreak')).toHaveLength(5);

    const measured = paragraphLayout(block, 400);
    expect(measured.lines).toHaveLength(6);
    const fragment: ParagraphFragment = {
      kind: 'paragraph',
      nodeId: block.id,
      x: 0,
      y: 0,
      width: 400,
      height: measured.totalHeight,
      fromLine: 0,
      toLine: measured.lines.length,
    };
    const painted = paintParagraphFragment(fragment, block, measured, {
      pageNumber: 1,
      totalPages: 1,
      section: 'body',
    });
    const lines = [...painted.querySelectorAll<HTMLElement>(':scope > .layout-line')];
    expect(lines).toHaveLength(6);
    expect(lines.every((line) => parseFloat(line.style.paddingLeft || '0') === 0)).toBe(true);
    expect(lines.every((line) => parseFloat(getComputedStyle(line).textIndent || '0') === 0)).toBe(
      true
    );
  });

  test('lone direct left zero still explicitly removes the style left indent', () => {
    const paragraph = parseBodyTextParagraph('w:left="0"');
    expect(paragraph.formatting?.indentLeft).toBe(0);

    const block = toParagraphBlock(paragraph);
    expect(block.attrs?.indent?.left).toBe(0);
    expect(block.attrs?.indent?.hanging).toBe(48);
  });

  test('nonzero direct left and firstLine override the style values', () => {
    const paragraph = parseBodyTextParagraph('w:left="720" w:firstLine="240"');
    const block = toParagraphBlock(paragraph);

    expect(block.attrs?.indent).toEqual({ left: 48, firstLine: 16 });
  });

  test('start alias zero clears style left indentation', () => {
    const block = toParagraphBlock(parseBodyTextParagraph('w:start="+000" w:firstLine="-000"'));
    expect(block.attrs?.indent?.left).toBe(0);
    expect(Math.abs(block.attrs?.indent?.firstLine ?? Number.NaN)).toBe(0);
    expect(block.attrs?.indent?.hanging).toBeUndefined();
  });

  test('end alias zero clears style right indentation', () => {
    const attrs = toParagraphAttrs(
      parseBodyTextParagraph('w:end="0" w:firstLine="0"', undefined, 'RightText')
    );
    expect(attrs).toMatchObject({
      indentRight: 0,
      indentFirstLine: 0,
      hangingIndent: false,
    });
  });

  test('style and direct-indent mutations invalidate stale provenance', () => {
    const parsed = parseBodyTextParagraph('w:left="0" w:firstLine="0"');

    const changedStyle = structuredClone(parsed);
    changedStyle.formatting!.styleId = 'RightText';
    const styleAttrs = toParagraphAttrs(changedStyle);
    expect(styleAttrs.indentLeft).not.toBe(1440);
    expect(styleAttrs.indentRight).toBe(360);

    const mutations: Array<{
      patch: Partial<NonNullable<Paragraph['formatting']>>;
      expected: Record<string, unknown>;
    }> = [
      { patch: { indentLeft: 720 }, expected: { indentLeft: 720 } },
      { patch: { indentRight: 240 }, expected: { indentLeft: 0, indentRight: 240 } },
      {
        patch: { indentFirstLine: 180 },
        expected: { indentLeft: 0, indentFirstLine: 180 },
      },
      {
        patch: { indentFirstLine: -180, hangingIndent: true },
        expected: { indentLeft: 0, indentFirstLine: -180, hangingIndent: true },
      },
    ];
    for (const { patch, expected } of mutations) {
      const mutated = structuredClone(parsed);
      Object.assign(mutated.formatting!, patch);
      expect(toParagraphAttrs(mutated)).toMatchObject(expected);
      expect(toParagraphAttrs(mutated).indentLeft).not.toBe(1440);
    }
  });

  for (const malformed of ['0oops', '0.5']) {
    test(`malformed left ${malformed} is not classified as neutral zero`, () => {
      const block = toParagraphBlock(
        parseBodyTextParagraph(`w:left="${malformed}" w:firstLine="0"`)
      );
      expect(block.attrs?.indent).toEqual({ left: 0, firstLine: 0 });
    });

    test(`malformed firstLine ${malformed} remains a direct override`, () => {
      const block = toParagraphBlock(
        parseBodyTextParagraph(`w:left="0" w:firstLine="${malformed}"`)
      );
      expect(block.attrs?.indent).toEqual({ left: 0, firstLine: 0 });
    });

    test(`malformed hanging ${malformed} remains a direct override`, () => {
      const block = toParagraphBlock(parseBodyTextParagraph(`w:left="0" w:hanging="${malformed}"`));
      expect(block.attrs?.indent).toEqual({ left: 0, hanging: 0 });
    });
  }
});
