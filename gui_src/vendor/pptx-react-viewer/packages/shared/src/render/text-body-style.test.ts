import type { TextStyle } from 'pptx-viewer-core';
import { describe, expect, it } from 'vitest';

import { isTextBodyStyleKey, splitTextBodyStyle, TEXT_BODY_STYLE_KEYS } from './text-body-style';

describe('isTextBodyStyleKey', () => {
	it('recognises the vertical anchor and the other body properties', () => {
		expect(isTextBodyStyleKey('vAlign')).toBe(true);
		expect(isTextBodyStyleKey('bodyInsetTop')).toBe(true);
		expect(isTextBodyStyleKey('columnCount')).toBe(true);
		expect(isTextBodyStyleKey('textDirection')).toBe(true);
	});

	it('leaves run and paragraph properties alone', () => {
		expect(isTextBodyStyleKey('bold')).toBe(false);
		expect(isTextBodyStyleKey('fontSize')).toBe(false);
		expect(isTextBodyStyleKey('color')).toBe(false);
		// Paragraph alignment is deliberately not treated as a body property.
		expect(isTextBodyStyleKey('align')).toBe(false);
	});
});

describe('splitTextBodyStyle', () => {
	it('separates a mixed patch', () => {
		const patch: Partial<TextStyle> = { vAlign: 'middle', bold: true, fontSize: 24 };
		expect(splitTextBodyStyle(patch)).toEqual({
			body: { vAlign: 'middle' },
			run: { bold: true, fontSize: 24 },
		});
	});

	it('yields an empty body half for a pure run patch', () => {
		expect(splitTextBodyStyle({ italic: true })).toEqual({ body: {}, run: { italic: true } });
	});

	it('yields an empty run half for a pure body patch', () => {
		expect(splitTextBodyStyle({ vAlign: 'bottom' })).toEqual({
			body: { vAlign: 'bottom' },
			run: {},
		});
	});

	it('keeps falsy and undefined values, which are meaningful patches', () => {
		const { body, run } = splitTextBodyStyle({ vAlign: undefined, bold: false });
		expect('vAlign' in body).toBe(true);
		expect(run).toEqual({ bold: false });
	});

	it('handles an empty patch', () => {
		expect(splitTextBodyStyle({})).toEqual({ body: {}, run: {} });
	});
});

describe('TEXT_BODY_STYLE_KEYS', () => {
	it('has no duplicates', () => {
		expect(new Set(TEXT_BODY_STYLE_KEYS).size).toBe(TEXT_BODY_STYLE_KEYS.length);
	});
});
