import type { PptxSlide } from 'pptx-viewer-core';
import { useEffect } from 'react';
import type React from 'react';

import { matchesLetterKey, matchesNamedKey } from '../../hooks/shortcut-keys';
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from './types';
import type { SorterContextMenuState } from './types';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseKeyboardShortcutsParams {
	slides: PptxSlide[];
	activeSlideIndex: number;
	canEdit: boolean;
	selectedSlideIds: string[];
	selectedIndexes: number[];
	contextMenu: SorterContextMenuState | null;
	setContextMenu: React.Dispatch<React.SetStateAction<SorterContextMenuState | null>>;
	setSelectedSlideIds: React.Dispatch<React.SetStateAction<string[]>>;
	setZoom: React.Dispatch<React.SetStateAction<number>>;
	onClose: () => void;
	handleDeleteSelected: () => void;
	handleCopySelected: () => void;
	handlePaste: () => void;
	handleDuplicateSelected: () => void;
	handleSelectAll: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useKeyboardShortcuts(params: UseKeyboardShortcutsParams): void {
	const {
		slides,
		activeSlideIndex,
		canEdit,
		selectedSlideIds,
		selectedIndexes,
		contextMenu,
		setContextMenu,
		setSelectedSlideIds,
		setZoom,
		onClose,
		handleDeleteSelected,
		handleCopySelected,
		handlePaste,
		handleDuplicateSelected,
		handleSelectAll,
	} = params;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (contextMenu) {
				setContextMenu(null);
			}
			const isCtrl = e.ctrlKey || e.metaKey;

			if (matchesNamedKey(e, 'Escape')) {
				e.stopPropagation();
				if (selectedSlideIds.length > 1) {
					const activeSlide = slides[activeSlideIndex];
					setSelectedSlideIds(activeSlide?.id ? [activeSlide.id] : []);
				} else {
					onClose();
				}
				return;
			}
			if ((matchesNamedKey(e, 'Delete') || matchesNamedKey(e, 'Backspace')) && canEdit) {
				e.preventDefault();
				if (selectedIndexes.length > 0) {
					handleDeleteSelected();
				}
				return;
			}
			if (isCtrl && matchesLetterKey(e, 'c')) {
				e.preventDefault();
				handleCopySelected();
				return;
			}
			if (isCtrl && matchesLetterKey(e, 'v') && canEdit) {
				e.preventDefault();
				handlePaste();
				return;
			}
			if (isCtrl && matchesLetterKey(e, 'd') && canEdit) {
				e.preventDefault();
				handleDuplicateSelected();
				return;
			}
			if (isCtrl && matchesLetterKey(e, 'a')) {
				e.preventDefault();
				handleSelectAll();
				return;
			}
			if (isCtrl && (e.key === '=' || e.key === '+')) {
				e.preventDefault();
				setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
				return;
			}
			if (isCtrl && e.key === '-') {
				e.preventDefault();
				setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [
		onClose,
		canEdit,
		selectedSlideIds,
		selectedIndexes,
		activeSlideIndex,
		slides,
		contextMenu,
		setContextMenu,
		setSelectedSlideIds,
		setZoom,
		handleDeleteSelected,
		handleCopySelected,
		handlePaste,
		handleDuplicateSelected,
		handleSelectAll,
	]);
}
