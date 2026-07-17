/**
 * Symbol Extension — preserves OOXML `<w:sym>` as an inline atom.
 */

import { createNodeExtension } from '../create';

export const SymbolExtension = createNodeExtension({
  name: 'symbol',
  schemaNodeName: 'symbol',
  nodeSpec: {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: false,
    // Allow marks so a symbol inside `<w:ins>`/`<w:del>` carries the
    // tracked-change mark (see ImageExtension — leaf inline nodes disallow
    // marks by default, and convertTrackedChange gates on allowsMarkType).
    marks: '_',
    attrs: {
      font: { default: null },
      char: { default: null },
      text: { default: '' },
    },
    // Surface the glyph through node.textContent / textBetween so consumers
    // that look at paragraph text (e.g. the checkbox-SDT glyph detection in
    // buildBoxTree and contentControls) see the symbol exactly as they did
    // when `w:sym` was lowered to a plain text node.
    leafText(node) {
      return (node.attrs.text as string) || '';
    },
    parseDOM: [
      {
        tag: 'span[data-docx-symbol]',
        getAttrs(dom) {
          const el = dom as HTMLElement;
          return {
            font: el.dataset.symbolFont || null,
            char: el.dataset.symbolChar || null,
            text: el.textContent || '',
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = node.attrs as { font?: string | null; char?: string | null; text?: string };
      const domAttrs: Record<string, string> = { 'data-docx-symbol': 'true' };
      if (attrs.font) domAttrs['data-symbol-font'] = attrs.font;
      if (attrs.char) domAttrs['data-symbol-char'] = attrs.char;
      return ['span', domAttrs, attrs.text || ''];
    },
  },
});
