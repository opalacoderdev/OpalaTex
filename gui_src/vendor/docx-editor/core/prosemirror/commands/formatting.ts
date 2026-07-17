/**
 * Text Formatting Commands — thin re-exports from extension system
 *
 * Toggle marks, set marks, clear formatting, hyperlinks.
 * All implementations live in extensions/marks/; this file re-exports
 * for backward compatibility.
 * @packageDocumentation
 * @public
 */

import type { Command } from 'prosemirror-state';
import { singletonManager, schema } from '../schema';
import type { TextColorAttrs } from '../schema';

// Utility re-exports from markUtils (used by toolbar, conversion, etc.)
export {
  isMarkActive,
  getMarkAttr,
  clearFormatting,
  createSetMarkCommand,
  createRemoveMarkCommand,
} from '../extensions/marks/markUtils';

// Hyperlink query helpers (used by toolbar)
export {
  isHyperlinkActive,
  getHyperlinkAttrs,
  getSelectedText,
  findHyperlinkRangeAt,
} from '../extensions/marks/HyperlinkExtension';

// ============================================================================
// PARAGRAPH DEFAULT FORMATTING HELPERS
// ============================================================================

/**
 * textFormattingToMarks — wraps markUtils version to use singleton schema
 */
import { textFormattingToMarks as _textFormattingToMarks } from '../extensions/marks/markUtils';
import type { TextFormatting } from '../../types/document';
import type { Mark } from 'prosemirror-model';

export function textFormattingToMarks(formatting: TextFormatting): Mark[] {
  return _textFormattingToMarks(formatting, schema);
}

// ============================================================================
// COMMANDS — delegated to singleton extension manager
// ============================================================================

const cmds = () => singletonManager.getCommands();

// Toggle marks (simple on/off) — resolve lazily so the command always closes
// over the singleton schema currently backing the editor (not a stale capture
// from first import before runtime init).
export const toggleBold: Command = (state, dispatch, view) =>
  cmds().toggleBold()(state, dispatch, view);
export const toggleItalic: Command = (state, dispatch, view) =>
  cmds().toggleItalic()(state, dispatch, view);
export const toggleUnderline: Command = (state, dispatch, view) =>
  cmds().toggleUnderline()(state, dispatch, view);
export const toggleStrike: Command = (state, dispatch, view) =>
  cmds().toggleStrike()(state, dispatch, view);
export const toggleSuperscript: Command = (state, dispatch, view) =>
  cmds().toggleSuperscript()(state, dispatch, view);
export const toggleSubscript: Command = (state, dispatch, view) =>
  cmds().toggleSubscript()(state, dispatch, view);
// Set marks (with attributes)
export function setTextColor(attrs: TextColorAttrs): Command {
  return cmds().setTextColor(attrs);
}
export const clearTextColor: Command = (state, dispatch, view) =>
  cmds().clearTextColor()(state, dispatch, view);

export function setHighlight(color: string): Command {
  return cmds().setHighlight(color);
}
export const clearHighlight: Command = (state, dispatch, view) =>
  cmds().clearHighlight()(state, dispatch, view);

export function setFontSize(size: number): Command {
  return cmds().setFontSize(size);
}
export const clearFontSize: Command = (state, dispatch, view) =>
  cmds().clearFontSize()(state, dispatch, view);

export function setFontFamily(fontName: string): Command {
  return cmds().setFontFamily(fontName);
}
export const clearFontFamily: Command = (state, dispatch, view) =>
  cmds().clearFontFamily()(state, dispatch, view);

export function setUnderlineStyle(style: string, color?: TextColorAttrs): Command {
  return cmds().setUnderlineStyle(style, color);
}

// Hyperlink commands
export function setHyperlink(href: string, tooltip?: string): Command {
  return cmds().setHyperlink(href, tooltip);
}
export const removeHyperlink: Command = (state, dispatch, view) =>
  cmds().removeHyperlink()(state, dispatch, view);

export function insertHyperlink(text: string, href: string, tooltip?: string): Command {
  return cmds().insertHyperlink(text, href, tooltip);
}
