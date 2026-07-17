/**
 * Column Break Extension — block node representing a DOCX column break.
 */

import { createNodeExtension } from '../create';

export const ColumnBreakExtension = createNodeExtension({
  name: 'columnBreak',
  schemaNodeName: 'columnBreak',
  nodeSpec: {
    group: 'block',
    atom: true,
    selectable: true,
    parseDOM: [{ tag: 'div.docx-column-break' }],
    toDOM() {
      return ['div', { class: 'docx-column-break' }];
    },
  },
});
