/**
 * useKeyboardShortcuts: Global keyboard shortcut handler for the PowerPoint editor.
 *
 * Listens for keydown on the container element and dispatches to the
 * appropriate handler (delete, copy, cut, undo, redo, nudge, etc.). Paste is
 * not here: it is driven by the native `paste` event (`useSystemPasteEvent`),
 * so that Ctrl+V can read the system clipboard without a permission prompt.
 *
 * Shortcuts are only active in "edit" mode and are suppressed when an
 * inline text edit, table cell edit, or drawing tool is active.
 *
 * Keys are matched through `shortcut-keys`, which falls back to the physical
 * key when the runtime does not resolve a character for the event: an embedded
 * web view that leaves `event.key` unresolved under a modifier would otherwise
 * lose every combo here.
 */
import { useEffect, useCallback, useRef } from 'react';

import type { TableCellEditorState, DrawingTool } from '../types';
import type { ViewerMode } from '../types-core';
import { matchesLetterKey, matchesNamedKey } from './shortcut-keys';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Small nudge step in EMU-equivalent pixels. */
const NUDGE_SMALL = 2;
/** Large nudge step (Shift+Arrow). */
const NUDGE_LARGE = 20;

/* ------------------------------------------------------------------ */
/*  Input interface                                                   */
/* ------------------------------------------------------------------ */

export interface UseKeyboardShortcutsInput {
	/** Container element ref: used to scope the listener. */
	containerRef: React.RefObject<HTMLDivElement | null>;

	mode: ViewerMode;
	canEdit: boolean;

	/** Whether any element is currently being inline-edited (text box). */
	inlineEditingElementId: string | null;
	/** Whether a table cell is being edited. */
	tableEditorState: TableCellEditorState | null;
	/** Current drawing tool: shortcuts are suppressed when drawing. */
	activeTool: DrawingTool;

	/** Whether at least one element is selected. */
	hasSelection: boolean;
	/** The IDs of the currently selected elements (effective). */
	effectiveSelectedIds: string[];

	// ── Action callbacks ────────────────────────────────────────────
	onDelete: () => void;
	onCopy: () => void;
	onCut: () => void;
	onDuplicate: () => void;
	/** Duplicate the active slide (edit mode, when no element selection or Ctrl+Shift+D). */
	onDuplicateSlide?: () => void;
	onUndo: () => void;
	onRedo: () => void;
	onSelectAll: () => void;
	onEscape: () => void;
	/** Move selected elements by (dx, dy). */
	onNudge: (dx: number, dy: number) => void;
	/** Navigate to previous visible slide (edit mode, no selection). */
	onPrevSlide?: () => void;
	/** Navigate to next visible slide (edit mode, no selection). */
	onNextSlide?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useKeyboardShortcuts(input: UseKeyboardShortcutsInput): void {
	// Store everything in a ref so the keydown closure never goes stale
	// and we don't need to re-attach the listener on every render.
	const inputRef = useRef(input);
	inputRef.current = input;

	const handleKeyDown = useCallback((e: KeyboardEvent) => {
		if (e.defaultPrevented) {
			return;
		}

		const {
			mode,
			canEdit,
			inlineEditingElementId,
			tableEditorState,
			activeTool,
			hasSelection,
			onDelete,
			onCopy,
			onCut,
			onDuplicate,
			onDuplicateSlide,
			onUndo,
			onRedo,
			onSelectAll,
			onEscape,
			onNudge,
			onPrevSlide,
			onNextSlide,
		} = inputRef.current;

		// Only active in edit mode
		if (mode !== 'edit' || !canEdit) {
			return;
		}

		// If the user is typing inside an <input>, <textarea>, or
		// contenteditable element, let the browser handle the event
		// (except for Escape which should always work).
		const target = e.target as HTMLElement | null;
		const isTextInput =
			target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

		// ── Escape: always handled ─────────────────────────────────
		if (matchesNamedKey(e, 'Escape')) {
			e.preventDefault();
			onEscape();
			return;
		}

		// Suppress shortcuts when inline-editing text, actively editing a table
		// cell, or when a drawing tool is active.
		if (inlineEditingElementId || tableEditorState?.isEditing || activeTool !== 'select') {
			return;
		}

		// ... and when focus is in a text input
		if (isTextInput) {
			return;
		}

		const isMod = e.metaKey || e.ctrlKey;

		// ── Delete / Backspace ──────────────────────────────────────
		if ((matchesNamedKey(e, 'Delete') || matchesNamedKey(e, 'Backspace')) && hasSelection) {
			e.preventDefault();
			onDelete();
			return;
		}

		// ── Ctrl/Cmd combos ─────────────────────────────────────────
		// Ctrl/Cmd+V is intentionally absent: preventing the default here would
		// also suppress the native `paste` event, which is the only way to read
		// the clipboard without the `clipboard-read` permission.
		// `useSystemPasteEvent` owns paste.
		if (isMod) {
			if (matchesLetterKey(e, 'z')) {
				e.preventDefault();
				if (e.shiftKey) {
					onRedo();
				} else {
					onUndo();
				}
				return;
			}
			if (matchesLetterKey(e, 'y')) {
				e.preventDefault();
				onRedo();
				return;
			}
			if (matchesLetterKey(e, 'c')) {
				if (hasSelection) {
					e.preventDefault();
					onCopy();
				}
				return;
			}
			if (matchesLetterKey(e, 'x')) {
				if (hasSelection) {
					e.preventDefault();
					onCut();
				}
				return;
			}
			if (matchesLetterKey(e, 'd')) {
				if (e.shiftKey) {
					if (onDuplicateSlide) {
						e.preventDefault();
						onDuplicateSlide();
					}
					return;
				}
				if (hasSelection) {
					e.preventDefault();
					onDuplicate();
				} else if (onDuplicateSlide) {
					e.preventDefault();
					onDuplicateSlide();
				}
				return;
			}
			if (matchesLetterKey(e, 'a')) {
				e.preventDefault();
				onSelectAll();
				return;
			}
		}

		// ── Arrow key nudge ─────────────────────────────────────────
		if (
			hasSelection &&
			(matchesNamedKey(e, 'ArrowUp') ||
				matchesNamedKey(e, 'ArrowDown') ||
				matchesNamedKey(e, 'ArrowLeft') ||
				matchesNamedKey(e, 'ArrowRight'))
		) {
			e.preventDefault();
			const step = e.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
			let dx = 0;
			let dy = 0;
			if (matchesNamedKey(e, 'ArrowUp')) {
				dy = -step;
			} else if (matchesNamedKey(e, 'ArrowDown')) {
				dy = step;
			} else if (matchesNamedKey(e, 'ArrowLeft')) {
				dx = -step;
			} else {
				dx = step;
			}
			onNudge(dx, dy);
			return;
		}

		// No element selection: use left/right arrows to navigate slides.
		if (!hasSelection && (matchesNamedKey(e, 'ArrowLeft') || matchesNamedKey(e, 'ArrowRight'))) {
			e.preventDefault();
			if (matchesNamedKey(e, 'ArrowLeft')) {
				onPrevSlide?.();
			} else {
				onNextSlide?.();
			}
		}
	}, []);

	useEffect(() => {
		// Listen on window so shortcuts work consistently across the entire editor.
		window.addEventListener('keydown', handleKeyDown);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [handleKeyDown]);
}
