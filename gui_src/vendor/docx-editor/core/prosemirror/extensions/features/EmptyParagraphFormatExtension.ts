/**
 * EmptyParagraphFormat — re-establishes stored marks for an empty styled
 * paragraph so typed text inherits the style's run formatting (bold, color,
 * size, font).
 *
 * Why this exists:
 * An empty paragraph carries its run defaults in the `defaultTextFormatting`
 * attr (set at load by toProseDoc, and when a style / mark is applied via
 * `applyStyle` / `setMark` / `toggleMarkPersist`). The visible painter derives
 * caret metrics from that attr, but typed text only picks up formatting when
 * it carries real marks. Those marks live in `storedMarks`, which ProseMirror
 * clears on the next selection change (dropdown refocus, ArrowUp, Enter
 * settle, etc.).
 *
 * This plugin:
 * 1. Mirrors non-empty `storedMarks` into `defaultTextFormatting` on empty
 *    paragraphs (so toggleMark / delete-preserved marks survive focus loss).
 * 2. When `storedMarks` is null or `[]`, re-derives them from
 *    `defaultTextFormatting` so typing and the toolbar see the same formatting
 *    the painter shows. (An empty array is truthy and must not wipe DTF.)
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { Schema } from 'prosemirror-model';
import { createExtension } from '../create';
import type { ExtensionContext, ExtensionRuntime } from '../types';
import { textFormattingToMarks, defaultTextFormattingFromMarks } from '../marks/markUtils';
import type { TextFormatting } from '../../../types/document';

export const emptyParagraphFormatKey = new PluginKey('emptyParagraphFormat');

function normalizeDtf(f: TextFormatting | null | undefined): TextFormatting | null {
  if (!f || Object.keys(f).length === 0) return null;
  return f;
}

function formattingEqual(
  a: TextFormatting | null | undefined,
  b: TextFormatting | null | undefined
): boolean {
  return JSON.stringify(normalizeDtf(a)) === JSON.stringify(normalizeDtf(b));
}

function createEmptyParagraphFormatPlugin(schema: Schema): Plugin {
  return new Plugin({
    key: emptyParagraphFormatKey,
    appendTransaction(transactions, _oldState, newState) {
      // Only react when the caret may have moved into an empty paragraph or
      // stored marks changed (toggle / delete).
      if (!transactions.some((t) => t.selectionSet || t.docChanged || t.storedMarksSet)) {
        return null;
      }

      const { selection } = newState;
      if (!selection.empty) return null;

      const para = selection.$from.parent;
      if (para.type.name !== 'paragraph' || para.content.size !== 0) return null;

      const dtf = para.attrs.defaultTextFormatting as TextFormatting | null | undefined;
      const stored = newState.storedMarks;

      // Non-empty stored marks (bold toggle, delete-preserved run, setMark) —
      // mirror them into the paragraph attr so a later selection clear can
      // re-derive them. Skip when DTF already matches to avoid churn.
      //
      // Important: `storedMarks === []` is NOT the same as intentional clear.
      // Focus/toolbar churn often leaves an empty array (truthy), and mirroring
      // that would wipe font/size from DTF. Treat [] like null: restore from DTF.
      if (stored !== null && stored.length > 0) {
        // Merge mark-backed fields onto existing DTF so DOCX-only attrs
        // (smallCaps, shading, …) and previously lossy mark attrs survive.
        const nextDtf = normalizeDtf(defaultTextFormattingFromMarks(dtf, stored));
        if (formattingEqual(dtf, nextDtf)) return null;
        const tr = newState.tr.setNodeMarkup(selection.$from.before(), undefined, {
          ...para.attrs,
          defaultTextFormatting: nextDtf,
        });
        // setNodeMarkup clears storedMarks — put them back.
        tr.setStoredMarks(stored);
        tr.setMeta('addToHistory', false);
        return tr;
      }

      const normalized = normalizeDtf(dtf);
      if (!normalized) return null;

      const marks = textFormattingToMarks(normalized, schema);
      if (marks.length === 0) return null;

      // Already restored (or clearFormatting left both empty).
      if (stored && stored.length === marks.length && marks.every((m) => m.isInSet(stored))) {
        return null;
      }

      const tr = newState.tr.setStoredMarks(marks);
      tr.setMeta('addToHistory', false);
      return tr;
    },
  });
}

export const EmptyParagraphFormatExtension = createExtension({
  name: 'emptyParagraphFormat',
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    return {
      plugins: [createEmptyParagraphFormatPlugin(ctx.schema)],
    };
  },
});
