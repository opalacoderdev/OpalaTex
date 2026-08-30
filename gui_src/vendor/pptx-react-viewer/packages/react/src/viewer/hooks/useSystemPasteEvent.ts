/**
 * useSystemPasteEvent: routes the browser's native `paste` event into the
 * editor's paste handler, and keeps Ctrl+V working where that event never
 * arrives.
 *
 * Ctrl+V is deliberately *not* a preventDefault-ing keyboard shortcut (see
 * `useKeyboardShortcuts`): calling `preventDefault()` on the key event
 * suppresses the `paste` event that follows, and that event is the only way to
 * read the clipboard without the `clipboard-read` permission — which many
 * embedders never grant. Listening for the event instead makes Ctrl+V work for
 * content copied from another application, and it also covers the browser's own
 * context-menu Paste command.
 *
 * Not every runtime dispatches that event when the focus is not in an editable
 * element, though, and there Ctrl+V would be dead: the key press also arms a
 * fallback that runs the command path (async Clipboard API, then the in-app
 * payload) unless a `paste` event arrives first. The native event stays
 * authoritative wherever it works, and the fallback never doubles it.
 *
 * The listener is on `document` because the slide stage is not focusable, so a
 * paste after clicking a slide is delivered to `<body>`. It stands down when
 * the focus is inside another widget — an inline text editor, a dialog input,
 * or anything outside the viewer — so those keep their own paste behaviour.
 */
import { useEffect, useRef } from 'react';

import type { TableCellEditorState } from '../types';
import type { ViewerMode } from '../types-core';
import { matchesLetterKey } from './shortcut-keys';

/**
 * How long a native `paste` event has to arrive after Ctrl+V before the
 * fallback runs. The event is dispatched in the same task as the key press
 * wherever it is dispatched at all, so this only has to outlast a busy frame.
 */
const PASTE_EVENT_GRACE_MS = 150;

export interface UseSystemPasteEventInput {
	/** Viewer root: pastes from widgets outside it are left alone. */
	containerRef: React.RefObject<HTMLDivElement | null>;
	mode: ViewerMode;
	canEdit: boolean;
	/** Set while a text box is being edited inline; that editor owns its pastes. */
	inlineEditingElementId: string | null;
	/** Set while a table cell is being edited; same reason. */
	tableEditorState: TableCellEditorState | null;
	onPaste: (dataTransfer: DataTransfer | null) => void;
	/**
	 * Paste with no event behind it, for the Ctrl+V fallback: reads the system
	 * clipboard through the async Clipboard API and falls back to the in-app
	 * payload. @see ClipboardHandlers.handlePaste
	 */
	onPasteWithoutEvent: () => void;
}

export function useSystemPasteEvent(input: UseSystemPasteEventInput): void {
	// Keep the latest input in a ref so the listener is attached once and never
	// goes stale, matching useKeyboardShortcuts.
	const inputRef = useRef(input);
	inputRef.current = input;

	useEffect(() => {
		let fallbackTimer: number | null = null;

		const cancelFallback = () => {
			if (fallbackTimer !== null) {
				window.clearTimeout(fallbackTimer);
				fallbackTimer = null;
			}
		};

		/** Whether the viewer owns the paste that `target` is about to receive. */
		const viewerOwnsPaste = (target: EventTarget | null): boolean => {
			const { containerRef, mode, canEdit, inlineEditingElementId, tableEditorState } =
				inputRef.current;

			if (mode !== 'edit' || !canEdit) {
				return false;
			}
			if (inlineEditingElementId || tableEditorState?.isEditing) {
				return false;
			}

			const element = target as HTMLElement | null;
			if (
				element?.tagName === 'INPUT' ||
				element?.tagName === 'TEXTAREA' ||
				element?.isContentEditable
			) {
				return false;
			}

			// `<body>` (or nothing) is the normal target after clicking a slide,
			// since the stage takes no focus; any other focused element outside the
			// viewer owns its own paste.
			const container = containerRef.current;
			const active = document.activeElement;
			if (container && active && active !== document.body && !container.contains(active)) {
				return false;
			}
			return true;
		};

		const handlePaste = (event: ClipboardEvent) => {
			// The native event won: whatever it carries is the freshest clipboard
			// content, so the armed fallback must not run on top of it.
			cancelFallback();
			if (!viewerOwnsPaste(event.target)) {
				return;
			}
			event.preventDefault();
			inputRef.current.onPaste(event.clipboardData);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
				return;
			}
			if (!matchesLetterKey(event, 'v') || !viewerOwnsPaste(event.target)) {
				return;
			}
			// No preventDefault: the native `paste` event must still be free to
			// fire, and it cancels this fallback when it does.
			cancelFallback();
			fallbackTimer = window.setTimeout(() => {
				fallbackTimer = null;
				inputRef.current.onPasteWithoutEvent();
			}, PASTE_EVENT_GRACE_MS);
		};

		document.addEventListener('paste', handlePaste);
		document.addEventListener('keydown', handleKeyDown);
		return () => {
			cancelFallback();
			document.removeEventListener('paste', handlePaste);
			document.removeEventListener('keydown', handleKeyDown);
		};
	}, []);
}
