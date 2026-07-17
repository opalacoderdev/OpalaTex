import { describe, expect, test } from 'bun:test';
import { parseStyles } from '../styleParser';
import { toProseDoc } from '../../prosemirror/conversion/toProseDoc';
import { buildBoxTree } from '../../flow-model/buildBoxTree';
import type { Document } from '../../types/document';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe('style widowControl parsing', () => {
  test('preserves explicit true and false in paragraph styles', () => {
    const styles = parseStyles(
      `<w:styles ${W}>
        <w:style w:type="paragraph" w:styleId="Enabled">
          <w:pPr><w:widowControl/></w:pPr>
        </w:style>
        <w:style w:type="paragraph" w:styleId="Disabled">
          <w:pPr><w:widowControl w:val="0"/></w:pPr>
        </w:style>
        <w:style w:type="paragraph" w:styleId="Omitted"><w:pPr/></w:style>
      </w:styles>`,
      null
    );

    expect(styles.get('Enabled')?.pPr?.widowControl).toBe(true);
    expect(styles.get('Disabled')?.pPr?.widowControl).toBe(false);
    expect(styles.get('Omitted')?.pPr?.widowControl).toBeUndefined();
  });

  test('carries style-inherited false through PM into layout', () => {
    const styles = parseStyles(
      `<w:styles ${W}>
        <w:style w:type="paragraph" w:styleId="Disabled">
          <w:pPr><w:widowControl w:val="0"/></w:pPr>
        </w:style>
      </w:styles>`,
      null
    );
    const document: Document = {
      package: {
        styles: { styles: [...styles.values()] },
        document: {
          content: [
            {
              type: 'paragraph',
              formatting: { styleId: 'Disabled' },
              content: [{ type: 'run', content: [{ type: 'text', text: 'x' }] }],
            },
          ],
        },
      },
    };

    const pm = toProseDoc(document, { styles: document.package.styles });
    expect(pm.child(0).attrs.widowControl).toBe(false);
    const flow = buildBoxTree(pm)[0];
    expect(flow.kind).toBe('paragraph');
    if (flow.kind !== 'paragraph') throw new Error('expected paragraph');
    expect(flow.attrs?.widowControl).toBe(false);
  });
});
