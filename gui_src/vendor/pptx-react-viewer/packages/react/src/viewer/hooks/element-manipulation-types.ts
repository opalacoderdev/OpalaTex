/**
 * Shared types for the useElementManipulation hook and its sub-hooks.
 */
import type { PptxElement, PptxSlide, MergeShapeOperation } from 'pptx-viewer-core';

import type { CanvasSize, ElementContextMenuAction } from '../types';
import type { EditorHistoryResult } from './useEditorHistory';
import type { ElementOperations } from './useElementOperations';

export interface UseElementManipulationInput {
	activeSlide: PptxSlide | undefined;
	activeSlideIndex: number;
	/** Slide canvas size, used to centre elements pasted from the system clipboard. */
	canvasSize: CanvasSize;
	selectedElement: PptxElement | null;
	effectiveSelectedIds: string[];
	selectedElements: PptxElement[];
	selectedElementIdSet: Set<string>;
	elementLookup: Map<string, PptxElement>;
	editTemplateMode: boolean;
	clipboardPayload: { element: PptxElement; isTemplate: boolean } | null;
	setClipboardPayload: React.Dispatch<
		React.SetStateAction<{ element: PptxElement; isTemplate: boolean } | null>
	>;
	setSelectedElementIds: React.Dispatch<React.SetStateAction<string[]>>;
	setIsInspectorPaneOpen: React.Dispatch<React.SetStateAction<boolean>>;
	setSidebarPanelMode: React.Dispatch<React.SetStateAction<string>>;
	ops: ElementOperations;
	history: EditorHistoryResult;
	onOpenHyperlinkDialog: () => void;
}

export interface ElementManipulationHandlers {
	handleCopy: () => void;
	handleCut: () => void;
	handlePaste: () => void;
	/** Paste the content of a native `paste` event (Ctrl+V). @see ClipboardHandlers */
	handlePasteDataTransfer: (dataTransfer: DataTransfer | null) => void;
	handleDuplicate: () => void;
	handleGroupElements: () => void;
	handleUngroupElement: () => void;
	handleDelete: () => void;
	handleFlip: (direction: 'horizontal' | 'vertical') => void;
	handleAlignElements: (align: string) => void;
	handleDistributeElements: (axis: string) => void;
	canDistribute: boolean;
	handleMoveLayer: (direction: string) => void;
	handleMoveLayerToEdge: (direction: string) => void;
	handleMergeShapes: (operation: MergeShapeOperation) => void;
	canMergeShapes: boolean;
	handleContextMenuAction: (action: ElementContextMenuAction) => void;
}

export interface ClipboardHandlers {
	handleCopy: () => void;
	handleCut: () => void;
	/**
	 * Paste from a command with no event behind it (toolbar button, context
	 * menu): reads the system clipboard through the async Clipboard API, and
	 * falls back to the in-app payload when that is unavailable or empty.
	 */
	handlePaste: () => void;
	/**
	 * Paste the content of a native `paste` event. Ctrl+V goes through this
	 * path because the event carries the clipboard data directly, so it works
	 * without the clipboard-read permission the async API needs.
	 */
	handlePasteDataTransfer: (dataTransfer: DataTransfer | null) => void;
	handleDuplicate: () => void;
	handleDelete: () => void;
}

export interface GroupAlignLayerHandlers {
	handleGroupElements: () => void;
	handleUngroupElement: () => void;
	handleFlip: (direction: 'horizontal' | 'vertical') => void;
	handleAlignElements: (align: string) => void;
	handleDistributeElements: (axis: string) => void;
	canDistribute: boolean;
	handleMoveLayer: (direction: string) => void;
	handleMoveLayerToEdge: (direction: string) => void;
	handleMergeShapes: (operation: MergeShapeOperation) => void;
	canMergeShapes: boolean;
}
