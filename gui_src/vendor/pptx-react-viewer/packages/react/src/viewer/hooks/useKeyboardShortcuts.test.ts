/**
 * Tests for pure keyboard-shortcut logic extracted from useKeyboardShortcuts.
 *
 * We test the decision logic (which action fires for which key combo)
 * without needing a DOM or React lifecycle.
 */
import { describe, it, expect } from 'vitest';

import { type ShortcutKeyEvent, matchesLetterKey, matchesNamedKey } from './shortcut-keys';

// ---------------------------------------------------------------------------
// Constants (mirror the hook)
// ---------------------------------------------------------------------------

const NUDGE_SMALL = 2;
const NUDGE_LARGE = 20;

// ---------------------------------------------------------------------------
// Extracted pure dispatch function: mirrors the handleKeyDown closure
// ---------------------------------------------------------------------------

interface ShortcutInput {
	mode: 'edit' | 'present' | 'view';
	canEdit: boolean;
	inlineEditingElementId: string | null;
	tableEditorIsEditing: boolean;
	activeTool: string;
	hasSelection: boolean;
	isTextInput: boolean;
}

type ActionName =
	| 'escape'
	| 'delete'
	| 'undo'
	| 'redo'
	| 'copy'
	| 'cut'
	| 'paste'
	| 'duplicate'
	| 'duplicateSlide'
	| 'selectAll'
	| 'nudge'
	| 'prevSlide'
	| 'nextSlide'
	| null;

interface DispatchResult {
	action: ActionName;
	dx?: number;
	dy?: number;
}

/**
 * Determine which action a keyboard event should trigger.
 * Returns null if the event should be ignored.
 *
 * A bare string stands for an event whose character the platform resolved; the
 * object form also names the physical key, which is what the hook falls back to
 * when it did not (see `shortcut-keys`).
 */
function resolveShortcutAction(
	key: string | ShortcutKeyEvent,
	ctrlKey: boolean,
	shiftKey: boolean,
	input: ShortcutInput,
): DispatchResult {
	const event: ShortcutKeyEvent = typeof key === 'string' ? { key, code: '' } : key;
	const {
		mode,
		canEdit,
		inlineEditingElementId,
		tableEditorIsEditing,
		activeTool,
		hasSelection,
		isTextInput,
	} = input;

	// Only active in edit mode
	if (mode !== 'edit' || !canEdit) {
		return { action: null };
	}

	// Escape: always handled
	if (matchesNamedKey(event, 'Escape')) {
		return { action: 'escape' };
	}

	// Suppress when inline-editing, table-editing, or drawing
	if (inlineEditingElementId || tableEditorIsEditing || activeTool !== 'select') {
		return { action: null };
	}

	// Suppress when in text input
	if (isTextInput) {
		return { action: null };
	}

	const isMod = ctrlKey;

	// Delete / Backspace
	if ((matchesNamedKey(event, 'Delete') || matchesNamedKey(event, 'Backspace')) && hasSelection) {
		return { action: 'delete' };
	}

	// Ctrl/Cmd combos. Ctrl/Cmd+V is not among them: the native `paste` event
	// owns it, so that the default is never prevented and the event still fires.
	if (isMod) {
		if (matchesLetterKey(event, 'z')) {
			return { action: shiftKey ? 'redo' : 'undo' };
		}
		if (matchesLetterKey(event, 'y')) {
			return { action: 'redo' };
		}
		if (matchesLetterKey(event, 'c')) {
			return hasSelection ? { action: 'copy' } : { action: null };
		}
		if (matchesLetterKey(event, 'x')) {
			return hasSelection ? { action: 'cut' } : { action: null };
		}
		if (matchesLetterKey(event, 'd')) {
			if (shiftKey) {
				return { action: 'duplicateSlide' };
			}
			return hasSelection ? { action: 'duplicate' } : { action: 'duplicateSlide' };
		}
		if (matchesLetterKey(event, 'a')) {
			return { action: 'selectAll' };
		}
	}

	// Arrow key nudge
	if (
		hasSelection &&
		(matchesNamedKey(event, 'ArrowUp') ||
			matchesNamedKey(event, 'ArrowDown') ||
			matchesNamedKey(event, 'ArrowLeft') ||
			matchesNamedKey(event, 'ArrowRight'))
	) {
		const step = shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
		let dx = 0;
		let dy = 0;
		if (matchesNamedKey(event, 'ArrowUp')) {
			dy = -step;
		} else if (matchesNamedKey(event, 'ArrowDown')) {
			dy = step;
		} else if (matchesNamedKey(event, 'ArrowLeft')) {
			dx = -step;
		} else {
			dx = step;
		}
		return { action: 'nudge', dx, dy };
	}

	// Slide navigation (no selection)
	if (!hasSelection && (matchesNamedKey(event, 'ArrowLeft') || matchesNamedKey(event, 'ArrowRight'))) {
		return { action: matchesNamedKey(event, 'ArrowLeft') ? 'prevSlide' : 'nextSlide' };
	}

	return { action: null };
}

// ---------------------------------------------------------------------------
// Default input factory
// ---------------------------------------------------------------------------

function defaultInput(overrides: Partial<ShortcutInput> = {}): ShortcutInput {
	return {
		mode: 'edit',
		canEdit: true,
		inlineEditingElementId: null,
		tableEditorIsEditing: false,
		activeTool: 'select',
		hasSelection: true,
		isTextInput: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts: shortcut dispatch logic', () => {

	// ── Physical key fallback ─────────────────────────────────────────
	// Runtimes that leave `key` unresolved under a modifier used to lose every
	// combo below; the hook falls back to the physical key there.
	describe('unresolved characters fall back to the physical key', () => {
		it('should copy for Ctrl + physical C when the character is Dead', () => {
			const result = resolveShortcutAction({ key: 'Dead', code: 'KeyC' }, true, false, defaultInput());
			expect(result.action).toBe('copy');
		});

		it('should cut for Ctrl + physical X when the character is Unidentified', () => {
			const result = resolveShortcutAction(
				{ key: 'Unidentified', code: 'KeyX' },
				true,
				false,
				defaultInput(),
			);
			expect(result.action).toBe('cut');
		});

		it('should undo for Ctrl + physical Z when the character is empty', () => {
			const result = resolveShortcutAction({ key: '', code: 'KeyZ' }, true, false, defaultInput());
			expect(result.action).toBe('undo');
		});

		it('should copy for a non-Latin character on the physical C key', () => {
			// Cyrillic layout: Ctrl+C reports 'с' (U+0441), not 'c'.
			const result = resolveShortcutAction({ key: '\u0441', code: 'KeyC' }, true, false, defaultInput());
			expect(result.action).toBe('copy');
		});

		it('should delete for an unresolved Delete key', () => {
			const result = resolveShortcutAction(
				{ key: 'Unidentified', code: 'Delete' },
				false,
				false,
				defaultInput(),
			);
			expect(result.action).toBe('delete');
		});

		it('should follow the resolved character, not the physical key, on a remapped layout', () => {
			// AZERTY: the physical Z key types 'w', and Ctrl+W is not a shortcut
			// here — the character the layout resolved has to win.
			const result = resolveShortcutAction({ key: 'w', code: 'KeyZ' }, true, false, defaultInput());
			expect(result.action).toBeNull();
		});

		it('should undo for the key labelled Z wherever it sits physically', () => {
			const result = resolveShortcutAction({ key: 'z', code: 'KeyW' }, true, false, defaultInput());
			expect(result.action).toBe('undo');
		});
	});
	// ── Guard conditions ──────────────────────────────────────────────
	describe('guard conditions', () => {
		it('should return null in present mode', () => {
			const result = resolveShortcutAction(
				'Delete',
				false,
				false,
				defaultInput({ mode: 'present' }),
			);
			expect(result.action).toBeNull();
		});

		it('should return null when canEdit is false', () => {
			const result = resolveShortcutAction(
				'Delete',
				false,
				false,
				defaultInput({ canEdit: false }),
			);
			expect(result.action).toBeNull();
		});

		it('should always handle Escape even in view mode guard (but edit mode required)', () => {
			const result = resolveShortcutAction('Escape', false, false, defaultInput());
			expect(result.action).toBe('escape');
		});

		it('should suppress non-Escape keys when inline editing', () => {
			const result = resolveShortcutAction(
				'Delete',
				false,
				false,
				defaultInput({ inlineEditingElementId: 'el-1' }),
			);
			expect(result.action).toBeNull();
		});

		it('should still allow Escape when inline editing', () => {
			const result = resolveShortcutAction(
				'Escape',
				false,
				false,
				defaultInput({ inlineEditingElementId: 'el-1' }),
			);
			expect(result.action).toBe('escape');
		});

		it('should suppress when table editor is editing', () => {
			const result = resolveShortcutAction(
				'Delete',
				false,
				false,
				defaultInput({ tableEditorIsEditing: true }),
			);
			expect(result.action).toBeNull();
		});

		it('should suppress when drawing tool is active', () => {
			const result = resolveShortcutAction(
				'Delete',
				false,
				false,
				defaultInput({ activeTool: 'pen' }),
			);
			expect(result.action).toBeNull();
		});

		it('should suppress when focus is in a text input', () => {
			const result = resolveShortcutAction(
				'Delete',
				false,
				false,
				defaultInput({ isTextInput: true }),
			);
			expect(result.action).toBeNull();
		});
	});

	// ── Delete / Backspace ────────────────────────────────────────────
	describe('delete', () => {
		it('should trigger delete on Delete key with selection', () => {
			expect(resolveShortcutAction('Delete', false, false, defaultInput()).action).toBe('delete');
		});

		it('should trigger delete on Backspace key with selection', () => {
			expect(resolveShortcutAction('Backspace', false, false, defaultInput()).action).toBe(
				'delete',
			);
		});

		it('should not trigger delete without selection', () => {
			expect(
				resolveShortcutAction('Delete', false, false, defaultInput({ hasSelection: false })).action,
			).toBeNull();
		});
	});

	// ── Ctrl/Cmd combos ──────────────────────────────────────────────
	describe('ctrl combos', () => {
		it('ctrl+Z should trigger undo', () => {
			expect(resolveShortcutAction('z', true, false, defaultInput()).action).toBe('undo');
		});

		it('ctrl+Shift+Z should trigger redo', () => {
			expect(resolveShortcutAction('z', true, true, defaultInput()).action).toBe('redo');
		});

		it('ctrl+Y should trigger redo', () => {
			expect(resolveShortcutAction('y', true, false, defaultInput()).action).toBe('redo');
		});

		it('ctrl+C should trigger copy with selection', () => {
			expect(resolveShortcutAction('c', true, false, defaultInput()).action).toBe('copy');
		});

		it('ctrl+C should do nothing without selection', () => {
			expect(
				resolveShortcutAction('c', true, false, defaultInput({ hasSelection: false })).action,
			).toBeNull();
		});

		it('ctrl+X should trigger cut with selection', () => {
			expect(resolveShortcutAction('x', true, false, defaultInput()).action).toBe('cut');
		});

		it('ctrl+V is left unhandled so the native paste event can fire', () => {
			expect(
				resolveShortcutAction('v', true, false, defaultInput({ hasSelection: false })).action,
			).toBeNull();
		});

		it('ctrl+D should trigger duplicate with selection', () => {
			expect(resolveShortcutAction('d', true, false, defaultInput()).action).toBe('duplicate');
		});

		it('ctrl+D should trigger duplicateSlide without selection', () => {
			expect(
				resolveShortcutAction('d', true, false, defaultInput({ hasSelection: false })).action,
			).toBe('duplicateSlide');
		});

		it('ctrl+Shift+D should trigger duplicateSlide even with selection', () => {
			expect(resolveShortcutAction('d', true, true, defaultInput()).action).toBe('duplicateSlide');
		});

		it('ctrl+A should trigger selectAll', () => {
			expect(resolveShortcutAction('a', true, false, defaultInput()).action).toBe('selectAll');
		});
	});

	// ── Arrow nudge ───────────────────────────────────────────────────
	describe('arrow nudge', () => {
		it('arrowUp should nudge up by NUDGE_SMALL', () => {
			const result = resolveShortcutAction('ArrowUp', false, false, defaultInput());
			expect(result).toStrictEqual({ action: 'nudge', dx: 0, dy: -NUDGE_SMALL });
		});

		it('arrowDown should nudge down by NUDGE_SMALL', () => {
			const result = resolveShortcutAction('ArrowDown', false, false, defaultInput());
			expect(result).toStrictEqual({ action: 'nudge', dx: 0, dy: NUDGE_SMALL });
		});

		it('arrowLeft should nudge left by NUDGE_SMALL', () => {
			const result = resolveShortcutAction('ArrowLeft', false, false, defaultInput());
			expect(result).toStrictEqual({ action: 'nudge', dx: -NUDGE_SMALL, dy: 0 });
		});

		it('arrowRight should nudge right by NUDGE_SMALL', () => {
			const result = resolveShortcutAction('ArrowRight', false, false, defaultInput());
			expect(result).toStrictEqual({ action: 'nudge', dx: NUDGE_SMALL, dy: 0 });
		});

		it('shift+ArrowUp should nudge by NUDGE_LARGE', () => {
			const result = resolveShortcutAction('ArrowUp', false, true, defaultInput());
			expect(result).toStrictEqual({ action: 'nudge', dx: 0, dy: -NUDGE_LARGE });
		});

		it('shift+ArrowRight should nudge by NUDGE_LARGE', () => {
			const result = resolveShortcutAction('ArrowRight', false, true, defaultInput());
			expect(result).toStrictEqual({ action: 'nudge', dx: NUDGE_LARGE, dy: 0 });
		});
	});

	// ── Slide navigation ──────────────────────────────────────────────
	describe('slide navigation', () => {
		it('arrowLeft without selection should go to prev slide', () => {
			const result = resolveShortcutAction(
				'ArrowLeft',
				false,
				false,
				defaultInput({ hasSelection: false }),
			);
			expect(result.action).toBe('prevSlide');
		});

		it('arrowRight without selection should go to next slide', () => {
			const result = resolveShortcutAction(
				'ArrowRight',
				false,
				false,
				defaultInput({ hasSelection: false }),
			);
			expect(result.action).toBe('nextSlide');
		});
	});
});
