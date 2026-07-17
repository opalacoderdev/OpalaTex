/**
 * Hard Break Extension — Shift+Enter line break
 */

import { createNodeExtension } from '../create';
import type { ExtensionContext, ExtensionRuntime } from '../types';

export const HardBreakExtension = createNodeExtension({
  name: 'hardBreak',
  schemaNodeName: 'hardBreak',
  nodeSpec: {
    inline: true,
    group: 'inline',
    selectable: false,
    // Imported breaks can sit inside tracked insertions/deletions. Without
    // marks, a deleted w:cr loses its revision state and becomes a live break.
    marks: '_',
    attrs: {
      breakType: { default: 'textWrapping' },
    },
    parseDOM: [
      {
        tag: 'br',
        getAttrs: (dom) => ({
          breakType: (dom as HTMLElement).dataset.docxBreakType || 'textWrapping',
        }),
      },
    ],
    toDOM(node) {
      return ['br', node.attrs.breakType === 'page' ? { 'data-docx-break-type': 'page' } : {}];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const hardBreakType = ctx.schema.nodes.hardBreak;

    return {
      keyboardShortcuts: {
        'Shift-Enter': (state, dispatch) => {
          if (dispatch) {
            dispatch(state.tr.replaceSelectionWith(hardBreakType.create()).scrollIntoView());
          }
          return true;
        },
      },
    };
  },
});
