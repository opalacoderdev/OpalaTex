/**
 * Tests for shortcut key matching: the resolved character wins where there is
 * one, the physical key covers the runtimes that resolve none.
 */
import { describe, it, expect } from 'vitest';

import { matchesLetterKey, matchesNamedKey } from './shortcut-keys';

describe('matchesLetterKey', () => {
	it('matches the resolved character', () => {
		expect(matchesLetterKey({ key: 'c', code: 'KeyC' }, 'c')).toBe(true);
		expect(matchesLetterKey({ key: 'C', code: 'KeyC' }, 'c')).toBe(true);
	});

	it('rejects a different resolved character even on the matching physical key', () => {
		// AZERTY types 'w' on the physical Z key: Ctrl+W must not undo.
		expect(matchesLetterKey({ key: 'w', code: 'KeyZ' }, 'z')).toBe(false);
	});

	it('follows the layout when the character sits on another physical key', () => {
		expect(matchesLetterKey({ key: 'z', code: 'KeyW' }, 'z')).toBe(true);
	});

	it('falls back to the physical key when no character was resolved', () => {
		expect(matchesLetterKey({ key: 'Dead', code: 'KeyC' }, 'c')).toBe(true);
		expect(matchesLetterKey({ key: 'Unidentified', code: 'KeyC' }, 'c')).toBe(true);
		expect(matchesLetterKey({ key: '', code: 'KeyC' }, 'c')).toBe(true);
	});

	it('falls back to the physical key for a non-Latin character', () => {
		// Cyrillic layout: the C key reports 'с' (U+0441).
		expect(matchesLetterKey({ key: 'с', code: 'KeyC' }, 'c')).toBe(true);
	});

	it('rejects an unresolved character on a different physical key', () => {
		expect(matchesLetterKey({ key: 'Dead', code: 'KeyX' }, 'c')).toBe(false);
	});

	it('rejects when neither the character nor the physical key is known', () => {
		expect(matchesLetterKey({ key: 'Unidentified', code: '' }, 'c')).toBe(false);
	});
});

describe('matchesNamedKey', () => {
	it('matches the key name', () => {
		expect(matchesNamedKey({ key: 'Escape', code: 'Escape' }, 'Escape')).toBe(true);
		expect(matchesNamedKey({ key: 'ArrowUp', code: 'ArrowUp' }, 'ArrowUp')).toBe(true);
	});

	it('matches the physical key when the name is unresolved', () => {
		expect(matchesNamedKey({ key: 'Unidentified', code: 'Delete' }, 'Delete')).toBe(true);
	});

	it('matches the name on a key that reports another code', () => {
		// Numpad Delete: key 'Delete', code 'NumpadDecimal'.
		expect(matchesNamedKey({ key: 'Delete', code: 'NumpadDecimal' }, 'Delete')).toBe(true);
	});

	it('rejects a different key', () => {
		expect(matchesNamedKey({ key: 'Enter', code: 'Enter' }, 'Escape')).toBe(false);
	});
});
