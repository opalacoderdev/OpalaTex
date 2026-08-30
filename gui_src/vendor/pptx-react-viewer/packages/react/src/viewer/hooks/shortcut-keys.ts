/**
 * shortcut-keys: matching a keyboard event against a shortcut key.
 *
 * `event.key` carries the character the platform's keyboard/compose layer
 * resolved, and it is the right thing to match whenever it is available: it
 * follows the user's layout, so Ctrl+Z stays the key labelled Z on AZERTY as
 * well as on QWERTY. Some runtimes the viewer is embedded in do not resolve it
 * while a modifier is held — a packaged desktop shell around a system web view
 * is the usual case — and deliver `Dead`, `Unidentified` or an empty string
 * instead, which kills every Ctrl shortcut. `event.code` names the *physical*
 * key and stays correct there.
 *
 * Hence the rule below: match the resolved character when there is one, and
 * fall back to the physical key only when there is not. A non-Latin layout
 * resolves a character this can never match (`с` for the C key on a Cyrillic
 * layout), so it takes the same fallback — which is what those users expect,
 * since their shortcuts are positional too.
 */

/** A character the layout resolved to a plain Latin letter. */
const LATIN_LETTER = /^[a-z]$/u;

/** The parts of a keyboard event a shortcut match looks at. */
export interface ShortcutKeyEvent {
	key: string;
	code: string;
}

/**
 * Whether `event` is the given letter shortcut key (`letter` is lower-case
 * ASCII, e.g. `'c'` for Ctrl+C). Modifiers are the caller's business.
 */
export function matchesLetterKey(event: ShortcutKeyEvent, letter: string): boolean {
	const character = (event.key ?? '').toLowerCase();
	if (LATIN_LETTER.test(character)) {
		return character === letter;
	}
	return event.code === `Key${letter.toUpperCase()}`;
}

/**
 * Whether `event` is the given named (non-character) key, such as `Escape`,
 * `Delete` or `ArrowUp`. These names are layout-independent and `code` repeats
 * them for the main keys, so matching either is unambiguous.
 */
export function matchesNamedKey(event: ShortcutKeyEvent, name: string): boolean {
	return event.key === name || event.code === name;
}
