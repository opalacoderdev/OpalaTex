/**
 * Italic Mark Extension
 */

import { createMarkExtension } from '../create';
import { toggleMarkPersist } from './markUtils';
import type { ExtensionContext, ExtensionRuntime } from '../types';

export const ItalicExtension = createMarkExtension({
  name: 'italic',
  schemaMarkName: 'italic',
  markSpec: {
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      {
        style: 'font-style',
        getAttrs: (value) => (value === 'italic' ? null : false),
      },
    ],
    toDOM() {
      return ['em', 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const toggle = toggleMarkPersist(ctx.schema.marks.italic);
    return {
      commands: {
        toggleItalic: () => toggle,
      },
      keyboardShortcuts: {
        'Mod-i': toggle,
      },
    };
  },
});
