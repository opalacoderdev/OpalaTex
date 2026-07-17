/**
 * Bold Mark Extension
 */

import { createMarkExtension } from '../create';
import { toggleMarkPersist } from './markUtils';
import type { ExtensionContext, ExtensionRuntime } from '../types';

export const BoldExtension = createMarkExtension({
  name: 'bold',
  schemaMarkName: 'bold',
  markSpec: {
    parseDOM: [
      { tag: 'strong' },
      {
        tag: 'b',
        getAttrs(dom) {
          // Reject <b> with explicit non-bold font-weight (e.g. Google Docs structural wrapper)
          const fw = (dom as HTMLElement).style?.fontWeight;
          if (fw === 'normal' || fw === '400') return false;
          return null;
        },
      },
      {
        style: 'font-weight',
        getAttrs: (value) => (/^(bold(er)?|[5-9]\d{2})$/.test(value as string) ? null : false),
      },
    ],
    toDOM() {
      return ['strong', 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const toggle = toggleMarkPersist(ctx.schema.marks.bold);
    return {
      commands: {
        toggleBold: () => toggle,
      },
      keyboardShortcuts: {
        'Mod-b': toggle,
      },
    };
  },
});
