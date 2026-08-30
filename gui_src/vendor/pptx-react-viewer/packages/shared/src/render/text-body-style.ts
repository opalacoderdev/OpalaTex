/**
 * text-body-style.ts: separates the text-body properties of a `TextStyle`
 * patch from the run/paragraph ones.
 *
 * `TextStyle` is one flat bag covering three different OOXML scopes: run
 * properties (`a:rPr` — bold, colour, size), paragraph properties (`a:pPr` —
 * alignment, indents) and **text-body** properties (`a:bodyPr` — the vertical
 * anchor, insets, columns, text direction). The first two belong to a range of
 * text; the third belongs to the shape's whole text body and has no meaning on
 * a run.
 *
 * That distinction matters as soon as a binding applies a patch to a *selected
 * range* rather than to the element: a body-level key written into a text
 * segment is dropped on save (the writer reads it from `element.textStyle`
 * only), so the command silently does nothing. Vertical alignment is the case
 * users hit first — selecting the text inside a shape and clicking "align
 * middle" is the obvious gesture, and it is exactly the one that fails.
 *
 * Paragraph-level keys are deliberately *not* separated here: the bindings
 * currently treat them as run-level, which is imprecise but not silently
 * lossy, and changing it is a larger behavioural change than this module is
 * for.
 *
 * @module render/text-body-style
 */
import type { TextStyle } from 'pptx-viewer-core';

/**
 * Every `TextStyle` key that maps to `a:bodyPr` (or one of its children:
 * `a:prstTxWarp`, `a:normAutofit`/`a:spAutoFit`, `a:scene3d`).
 */
export const TEXT_BODY_STYLE_KEYS = [
	'vAlign',
	'anchorCenter',
	'textDirection',
	'columnCount',
	'columnSpacing',
	'hOverflow',
	'vertOverflow',
	'bodyInsetLeft',
	'bodyInsetTop',
	'bodyInsetRight',
	'bodyInsetBottom',
	'textWrap',
	'textWarpPreset',
	'textWarpAdj',
	'textWarpAdj2',
	'autoFit',
	'autoFitMode',
	'autoFitFontScale',
	'autoFitLineSpacingReduction',
	'spaceFirstLastParagraph',
	'rtlColumns',
	'fromWordArt',
	'forceAntiAlias',
	'upright',
	'compatibleLineSpacing',
	'textBodyRotation',
	'textBodyScene3d',
	'bodyPropertiesExtLstXml',
] as const satisfies ReadonlyArray<keyof TextStyle>;

const BODY_KEY_SET: ReadonlySet<string> = new Set<string>(TEXT_BODY_STYLE_KEYS);

/** True when `key` addresses the shape's text body rather than a run of text. */
export function isTextBodyStyleKey(key: string): boolean {
	return BODY_KEY_SET.has(key);
}

/**
 * Split a `TextStyle` patch into the part that belongs to the shape's text
 * body and the part that belongs to the text itself.
 *
 * Either half may be empty; callers should skip an empty half rather than
 * dispatch a no-op update.
 */
export function splitTextBodyStyle(patch: Partial<TextStyle>): {
	body: Partial<TextStyle>;
	run: Partial<TextStyle>;
} {
	const body: Record<string, unknown> = {};
	const run: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		(isTextBodyStyleKey(key) ? body : run)[key] = value;
	}
	return { body: body as Partial<TextStyle>, run: run as Partial<TextStyle> };
}
