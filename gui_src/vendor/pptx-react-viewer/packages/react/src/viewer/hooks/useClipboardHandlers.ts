/**
 * useClipboardHandlers: Copy, cut, paste, duplicate, and delete handlers
 * extracted from useElementManipulation.
 *
 * Thin wrapper over the two shared clipboard modules
 * (`pptx-viewer-shared`): `render/element-clipboard.ts` owns the in-app
 * payload building + paste cloning (fresh template-aware ids, cascade offset),
 * and `render/system-clipboard.ts` owns the OS-clipboard transport and the
 * conversion of foreign clipboard content into elements.
 *
 * Paste reads the system clipboard first and only falls back to the in-app
 * payload: an image or text the user copied in another application is the
 * common case, and it is the only one the in-app payload can never hold. The
 * exception is a copy this window made that the embedder refused to publish to
 * the system clipboard — see {@link inAppPayloadOutranks}.
 */
import { useRef } from 'react';
import type { PptxElement, PptxSlide } from 'pptx-viewer-core';
import {
	type SystemClipboardContent,
	buildElementClipboardPayload,
	cloneElementForPaste,
	elementsFromSystemClipboardContent,
} from 'pptx-viewer-shared';

import type { CanvasSize } from '../types';
import {
	readClipboardContentFromDataTransfer,
	readClipboardContentFromNavigator,
	writeElementsToSystemClipboard,
} from '../utils/system-clipboard';
import type { ClipboardHandlers } from './element-manipulation-types';
import type { EditorHistoryResult } from './useEditorHistory';
import type { ElementOperations } from './useElementOperations';

interface ClipboardInput {
	activeSlide: PptxSlide | undefined;
	activeSlideIndex: number;
	canvasSize: CanvasSize;
	selectedElement: PptxElement | null;
	effectiveSelectedIds: string[];
	editTemplateMode: boolean;
	clipboardPayload: { element: PptxElement; isTemplate: boolean } | null;
	setClipboardPayload: React.Dispatch<
		React.SetStateAction<{ element: PptxElement; isTemplate: boolean } | null>
	>;
	ops: ElementOperations;
	history: EditorHistoryResult;
}

export function useClipboardHandlers(input: ClipboardInput): ClipboardHandlers {
	const {
		activeSlide,
		canvasSize,
		selectedElement,
		effectiveSelectedIds,
		editTemplateMode,
		clipboardPayload,
		setClipboardPayload,
		ops,
		history,
	} = input;

	/**
	 * Whether the last copy's element payload reached the system clipboard,
	 * pending while the write is in flight. `null` until this window copies
	 * something. @see inAppPayloadOutranks
	 */
	const systemCopyRef = useRef<Promise<boolean> | null>(null);

	const handleCopy = () => {
		if (!selectedElement) {
			return;
		}
		setClipboardPayload(buildElementClipboardPayload(selectedElement, editTemplateMode));
		// Best effort, and deliberately not awaited: the in-app payload above is
		// already set, so a clipboard the embedder blocks costs cross-window
		// paste, not paste. The promise is kept, not dropped, so paste can tell
		// whether this copy ever reached the system clipboard.
		systemCopyRef.current = writeElementsToSystemClipboard([selectedElement], editTemplateMode);
	};

	const handleDelete = () => {
		const idsToDelete = effectiveSelectedIds;
		if (!idsToDelete.length || !activeSlide) {
			return;
		}
		const idSet = new Set(idsToDelete);
		// Route to whichever store is being edited: in edit-template mode the
		// selected ids are template elements in the template store; otherwise they
		// are normal slide elements. Template deletes persist via buildSaveSlides.
		ops.updateActiveElements((els) => els.filter((el) => !idSet.has(el.id)));
		ops.clearSelection();
		history.markDirty();
	};

	const handleCut = () => {
		handleCopy();
		handleDelete();
	};

	const insertElements = (elements: PptxElement[]) => {
		if (!elements.length) {
			return;
		}
		ops.updateActiveElements((els) => [...els, ...elements]);
		ops.applySelection(
			elements[0].id,
			elements.length > 1 ? elements.map((element) => element.id) : [],
		);
		history.markDirty();
	};

	const insertClone = (source: PptxElement) => {
		// In edit-template mode the clone is inserted into the template store, so
		// it keeps a template-prefixed id so later edits route to the same store.
		insertElements([cloneElementForPaste(source, { intoTemplate: editTemplateMode })]);
	};

	/** Insert whatever the system clipboard held; `false` when it held nothing usable. */
	const pasteSystemContent = (content: SystemClipboardContent | null): boolean => {
		if (!content || !activeSlide) {
			return false;
		}
		const elements = elementsFromSystemClipboardContent(content, {
			canvasSize,
			intoTemplate: editTemplateMode,
		});
		if (!elements.length) {
			return false;
		}
		insertElements(elements);
		return true;
	};

	/**
	 * Whether the in-app payload outranks what the system clipboard reports.
	 *
	 * It does when the last copy never reached the system clipboard as elements:
	 * the OS then still holds whatever it held before the copy, or — when the
	 * write degraded to `writeText` — only the copied element's own text, which
	 * would paste a copied shape back as a plain text box. Neither is what the
	 * user copied. A bitmap is never something a copy here failed to write, so it
	 * still wins, and so does an element payload (this window's copy made it out,
	 * or another viewer window's did).
	 */
	const inAppPayloadOutranks = async (content: SystemClipboardContent | null): Promise<boolean> => {
		if (!clipboardPayload || content?.kind === 'elements' || content?.kind === 'image') {
			return false;
		}
		const systemCopy = systemCopyRef.current;
		return systemCopy !== null && !(await systemCopy);
	};

	const pasteInAppPayload = (): boolean => {
		if (!clipboardPayload || !activeSlide) {
			return false;
		}
		insertClone(clipboardPayload.element);
		return true;
	};

	const pasteContent = async (content: SystemClipboardContent | null): Promise<void> => {
		if ((await inAppPayloadOutranks(content)) && pasteInAppPayload()) {
			return;
		}
		if (pasteSystemContent(content)) {
			return;
		}
		pasteInAppPayload();
	};

	const handlePaste = () => {
		void (async () => {
			await pasteContent(await readClipboardContentFromNavigator());
		})();
	};

	const handlePasteDataTransfer = (dataTransfer: DataTransfer | null) => {
		void (async () => {
			await pasteContent(await readClipboardContentFromDataTransfer(dataTransfer));
		})();
	};

	const handleDuplicate = () => {
		if (!selectedElement || !activeSlide) {
			return;
		}
		insertClone(selectedElement);
	};

	return {
		handleCopy,
		handleCut,
		handlePaste,
		handlePasteDataTransfer,
		handleDuplicate,
		handleDelete,
	};
}
