/**
 * Shared mark utility functions
 *
 * setMark, removeMark, isMarkActive, getMarkAttr, marksToTextFormatting, textFormattingToMarks, clearFormatting
 */

import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { MarkType, Mark, Schema } from 'prosemirror-model';
import { toggleMark as pmToggleMark } from 'prosemirror-commands';
import type { TextFormatting } from '../../../types/document';
import type { FontFamilyAttrs, UnderlineAttrs } from '../../schema/marks';

type MarkAttrs = Record<string, unknown>;

/**
 * TextFormatting keys that marksToTextFormatting / textFormattingToMarks
 * round-trip. When syncing DTF from stored marks, these are replaced from the
 * mark set; every other DOCX field (smallCaps, shading, spacing, …) is kept.
 */
const MARK_BACKED_FORMATTING_KEYS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'doubleStrike',
  'color',
  'highlight',
  'fontSize',
  'fontSizeCs',
  'fontFamily',
  'vertAlign',
  'rtl',
] as const satisfies readonly (keyof TextFormatting)[];

// ============================================================================
// PARAGRAPH DEFAULT FORMATTING HELPERS
// ============================================================================

export function marksToTextFormatting(marks: readonly Mark[]): TextFormatting {
  const formatting: TextFormatting = {};

  for (const mark of marks) {
    switch (mark.type.name) {
      case 'bold':
        formatting.bold = true;
        break;
      case 'italic':
        formatting.italic = true;
        break;
      case 'underline': {
        const attrs = mark.attrs as UnderlineAttrs;
        formatting.underline = {
          style: attrs.style || 'single',
          ...(attrs.color ? { color: attrs.color } : {}),
        };
        break;
      }
      case 'strike':
        if (mark.attrs.double) {
          formatting.doubleStrike = true;
        } else {
          formatting.strike = true;
        }
        break;
      case 'textColor':
        formatting.color = mark.attrs;
        break;
      case 'highlight':
        formatting.highlight = mark.attrs.color;
        break;
      case 'fontSize':
        // CS-only RTL runs carry the size in `sizeCs`; fall back so the toolbar
        // field isn't blank for them.
        formatting.fontSize = mark.attrs.size ?? mark.attrs.sizeCs;
        // Preserve a genuinely distinct complex-script size so a run with
        // different Latin/CS sizes survives a read -> textFormattingToMarks
        // round-trip (e.g. stored-mark persistence); without it fontSizeCs
        // stays undefined and the next write re-aligns sizeCs to fontSize.
        // Only set when sizeCs is present so Latin-only runs stay fontSize-only.
        if (mark.attrs.sizeCs != null) formatting.fontSizeCs = mark.attrs.sizeCs;
        break;
      case 'fontFamily': {
        const attrs = mark.attrs as FontFamilyAttrs;
        formatting.fontFamily = {
          ascii: attrs.ascii,
          hAnsi: attrs.hAnsi,
          eastAsia: attrs.eastAsia || undefined,
          cs: attrs.cs || undefined,
          asciiTheme: attrs.asciiTheme as NonNullable<TextFormatting['fontFamily']>['asciiTheme'],
          hAnsiTheme: attrs.hAnsiTheme || undefined,
          eastAsiaTheme: attrs.eastAsiaTheme || undefined,
          csTheme: attrs.csTheme || undefined,
        };
        break;
      }
      case 'superscript':
        formatting.vertAlign = 'superscript';
        break;
      case 'subscript':
        formatting.vertAlign = 'subscript';
        break;
      case 'rtl':
        // Per-run right-to-left flag (`<w:rtl/>`). Without this case, formatting
        // helpers that route through markUtils (live-edit commands, clipboard)
        // silently drop run direction for Arabic/Hebrew/etc. text. Fixes #806.
        formatting.rtl = true;
        break;
    }
  }

  return formatting;
}

/**
 * Sync `defaultTextFormatting` from stored marks without wiping DOCX fields
 * that have no ProseMirror mark. Mark-backed keys are replaced from `marks`;
 * everything else is kept from `existing`.
 */
export function defaultTextFormattingFromMarks(
  existing: TextFormatting | null | undefined,
  marks: readonly Mark[]
): TextFormatting | null {
  const fromMarks = marksToTextFormatting(marks);
  if (!existing || Object.keys(existing).length === 0) {
    return Object.keys(fromMarks).length === 0 ? null : fromMarks;
  }

  const result: TextFormatting = { ...existing };
  for (const key of MARK_BACKED_FORMATTING_KEYS) {
    delete result[key];
  }
  Object.assign(result, fromMarks);
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Mirror the cursor's stored marks into the paragraph's `defaultTextFormatting`
 * attr so an empty paragraph renders with the right caret height/font.
 *
 * IMPORTANT: callers must invoke this BEFORE `tr.setStoredMarks(...)`. The
 * `setNodeMarkup` step appended here clears `tr.storedMarks` (every step does —
 * see prosemirror-state Transaction.addStep), so stored marks must be set last.
 * Marks are passed in explicitly rather than read off `tr.storedMarks` for the
 * same reason.
 */
function saveStoredMarksToParagraph(
  state: EditorState,
  tr: Transaction,
  marks: readonly Mark[]
): Transaction {
  const { $from } = state.selection;
  const paragraph = $from.parent;

  if (paragraph.type.name !== 'paragraph') return tr;
  if (paragraph.textContent.length > 0) return tr;

  const defaultTextFormatting = defaultTextFormattingFromMarks(
    paragraph.attrs.defaultTextFormatting as TextFormatting | null | undefined,
    marks
  );

  return tr.setNodeMarkup($from.before(), undefined, {
    ...paragraph.attrs,
    defaultTextFormatting,
  });
}

// ============================================================================
// CORE MARK COMMANDS
// ============================================================================

/**
 * Apply a new stored-mark set at a collapsed cursor and mirror it into the
 * paragraph's defaultTextFormatting. Order matters: setNodeMarkup runs first
 * because every transform step clears tr.storedMarks, so setStoredMarks must
 * be the last mutation.
 */
function dispatchStoredMarks(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  marks: readonly Mark[]
): void {
  // Coerce to state.schema so MarkType identity matches the EditorView
  // (Vite can duplicate ExtensionManager modules; foreign MarkTypes break
  // MarkType.isInSet / toggle-off).
  const localMarks = coerceMarksToSchema(marks, state.schema);
  let tr = state.tr;
  tr = saveStoredMarksToParagraph(state, tr, localMarks);
  tr.setStoredMarks(localMarks);
  dispatch(tr);
}

/** True if any mark shares `markType`'s name (reference equality optional). */
function hasMarkNamed(marks: readonly Mark[], markType: MarkType): boolean {
  return markType.isInSet(marks) != null || marks.some((m) => m.type.name === markType.name);
}

function withoutMarkNamed(marks: readonly Mark[], markType: MarkType): Mark[] {
  return marks.filter((m) => m.type !== markType && m.type.name !== markType.name);
}

/** Rebuild marks with this schema's MarkTypes (attrs preserved). */
function coerceMarksToSchema(marks: readonly Mark[], schema: Schema): Mark[] {
  const out: Mark[] = [];
  for (const mark of marks) {
    const type = schema.marks[mark.type.name];
    if (!type) continue;
    out.push(type === mark.type ? mark : type.create(mark.attrs));
  }
  return out;
}

/**
 * Marks that should apply to the next typed character in an empty paragraph.
 *
 * ProseMirror uses `storedMarks === null` to mean "inherit from the cursor",
 * but focus/toolbar churn often leaves `storedMarks === []` (explicit empty).
 * An empty array is truthy, so `storedMarks || $from.marks()` skips the
 * paragraph's `defaultTextFormatting` and a subsequent bold toggle would
 * overwrite DTF with `{ bold: true }` alone — dropping Georgia/size.
 * Seed from DTF whenever stored marks are missing or empty.
 */
export function effectiveEmptyParagraphMarks(state: EditorState): readonly Mark[] {
  const { $from } = state.selection;
  const para = $from.parent;
  if (para.type.name === 'paragraph' && para.content.size === 0) {
    const stored = state.storedMarks;
    if (stored && stored.length > 0) return stored;
    const dtf = para.attrs.defaultTextFormatting as TextFormatting | null | undefined;
    if (dtf && Object.keys(dtf).length > 0) {
      return textFormattingToMarks(dtf, state.schema);
    }
    if (stored) return stored;
  }
  return state.storedMarks || $from.marks();
}

export function setMark(markType: MarkType, attrs: MarkAttrs): Command {
  return (state, dispatch) => {
    const localType = state.schema.marks[markType.name] ?? markType;
    const { from, to, empty } = state.selection;
    const mark = localType.create(attrs);

    if (empty) {
      if (dispatch) {
        const current = effectiveEmptyParagraphMarks(state);
        dispatchStoredMarks(state, dispatch, [...withoutMarkNamed(current, localType), mark]);
      }
      return true;
    }

    if (dispatch) {
      dispatch(state.tr.addMark(from, to, mark).scrollIntoView());
    }
    return true;
  };
}

export function removeMark(markType: MarkType): Command {
  return (state, dispatch) => {
    const localType = state.schema.marks[markType.name] ?? markType;
    const { from, to, empty } = state.selection;

    if (empty) {
      if (dispatch) {
        dispatchStoredMarks(
          state,
          dispatch,
          withoutMarkNamed(effectiveEmptyParagraphMarks(state), localType)
        );
      }
      return true;
    }

    if (dispatch) {
      dispatch(state.tr.removeMark(from, to, localType).scrollIntoView());
    }
    return true;
  };
}

/**
 * Toggle a mark, mirroring into `defaultTextFormatting` when the caret is in
 * an empty paragraph. Plain `toggleMark` only updates `storedMarks`, which
 * ProseMirror clears on the next selection/focus transaction — so bold/italic
 * set on an empty run vanished after Enter / ArrowUp / toolbar refocus.
 * Range selections still use prosemirror-commands `toggleMark`.
 *
 * Always rebinds `markType` to `state.schema` and matches existing marks by
 * name — Vite can duplicate ExtensionManager modules so `MarkType.isInSet`
 * (reference equality) misses foreign-schema marks already in storedMarks.
 */
export function toggleMarkPersist(markType: MarkType, attrs?: MarkAttrs): Command {
  return (state, dispatch) => {
    const localType = state.schema.marks[markType.name] ?? markType;
    if (state.selection.empty) {
      const current = effectiveEmptyParagraphMarks(state);
      if (hasMarkNamed(current, localType)) {
        return removeMark(localType)(state, dispatch);
      }
      return setMark(localType, attrs ?? {})(state, dispatch);
    }
    return pmToggleMark(localType, attrs)(state, dispatch);
  };
}

/**
 * Check if a mark is active in the current selection
 */
export function isMarkActive(
  state: EditorState,
  markType: MarkType,
  attrs?: Record<string, unknown>
): boolean {
  const localType = state.schema.marks[markType.name] ?? markType;
  const { from, to, empty } = state.selection;

  if (empty) {
    const marks = effectiveEmptyParagraphMarks(state);
    return marks.some((mark) => {
      if (mark.type !== localType && mark.type.name !== localType.name) return false;
      if (!attrs) return true;
      return Object.entries(attrs).every(([key, value]) => mark.attrs[key] === value);
    });
  }

  let hasMark = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const mark = localType.isInSet(node.marks);
      if (mark) {
        if (!attrs) {
          hasMark = true;
          return false;
        }
        const attrsMatch = Object.entries(attrs).every(([key, value]) => mark.attrs[key] === value);
        if (attrsMatch) {
          hasMark = true;
          return false;
        }
      }
    }
    return true;
  });

  return hasMark;
}

/**
 * Get the current value of a mark attribute
 */
export function getMarkAttr(state: EditorState, markType: MarkType, attr: string): unknown | null {
  const localType = state.schema.marks[markType.name] ?? markType;
  const { empty, from, to } = state.selection;

  if (empty) {
    const marks = effectiveEmptyParagraphMarks(state);
    for (const mark of marks) {
      if (mark.type === localType || mark.type.name === localType.name) {
        return mark.attrs[attr];
      }
    }
    return null;
  }

  let value: unknown = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText && value === null) {
      const mark = localType.isInSet(node.marks);
      if (mark) {
        value = mark.attrs[attr];
        return false;
      }
    }
    return true;
  });

  return value;
}

/**
 * Convert TextFormatting to marks array (used to restore formatting on empty paragraphs)
 */
export function textFormattingToMarks(formatting: TextFormatting, schema: Schema): Mark[] {
  const marks: Mark[] = [];

  if (formatting.bold) {
    marks.push(schema.marks.bold.create());
  }
  if (formatting.italic) {
    marks.push(schema.marks.italic.create());
  }
  if (formatting.underline) {
    marks.push(
      schema.marks.underline.create({
        style: formatting.underline.style || 'single',
        color: formatting.underline.color,
      })
    );
  }
  if (formatting.strike) {
    marks.push(schema.marks.strike.create());
  }
  if (formatting.doubleStrike) {
    marks.push(schema.marks.strike.create({ double: true }));
  }
  if (formatting.color) {
    marks.push(
      schema.marks.textColor.create({
        rgb: formatting.color.rgb,
        themeColor: formatting.color.themeColor,
        themeTint: formatting.color.themeTint,
        themeShade: formatting.color.themeShade,
      })
    );
  }
  if (formatting.highlight) {
    marks.push(schema.marks.highlight.create({ color: formatting.highlight }));
  }
  if (formatting.fontSize) {
    marks.push(
      schema.marks.fontSize.create({
        size: formatting.fontSize,
        sizeCs: formatting.fontSizeCs ?? formatting.fontSize,
      })
    );
  }
  if (formatting.fontFamily) {
    marks.push(
      schema.marks.fontFamily.create({
        ascii: formatting.fontFamily.ascii,
        hAnsi: formatting.fontFamily.hAnsi,
        eastAsia: formatting.fontFamily.eastAsia,
        cs: formatting.fontFamily.cs,
        asciiTheme: formatting.fontFamily.asciiTheme,
        hAnsiTheme: formatting.fontFamily.hAnsiTheme,
        eastAsiaTheme: formatting.fontFamily.eastAsiaTheme,
        csTheme: formatting.fontFamily.csTheme,
      })
    );
  }
  if (formatting.vertAlign === 'superscript') {
    marks.push(schema.marks.superscript.create());
  }
  if (formatting.vertAlign === 'subscript') {
    marks.push(schema.marks.subscript.create());
  }
  if (formatting.rtl) {
    marks.push(schema.marks.rtl.create());
  }

  return marks;
}

/**
 * Clear all text formatting (remove all marks)
 */
export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;

  if (empty) {
    if (dispatch) {
      // Wipe mark-backed *and* DOCX-only run defaults — unlike removeMark of the
      // last mark, clearFormatting is an intentional full clear.
      const { $from } = state.selection;
      const paragraph = $from.parent;
      let tr = state.tr;
      if (paragraph.type.name === 'paragraph' && paragraph.textContent.length === 0) {
        tr = tr.setNodeMarkup($from.before(), undefined, {
          ...paragraph.attrs,
          defaultTextFormatting: null,
        });
      }
      tr.setStoredMarks([]);
      dispatch(tr);
    }
    return true;
  }

  if (dispatch) {
    let tr = state.tr;

    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText && node.marks.length > 0) {
        const start = Math.max(from, pos);
        const end = Math.min(to, pos + node.nodeSize);
        for (const mark of node.marks) {
          tr = tr.removeMark(start, end, mark.type);
        }
      }
    });

    dispatch(tr.scrollIntoView());
  }

  return true;
};

/**
 * Create a command that sets a mark on the selection
 */
export function createSetMarkCommand(markType: MarkType, attrs?: Record<string, unknown>): Command {
  return setMark(markType, attrs || {});
}

/**
 * Create a command that removes a mark from the selection
 */
export function createRemoveMarkCommand(markType: MarkType): Command {
  return removeMark(markType);
}
