import { describe, expect, it } from 'vitest';

import {
	LINE_PRESET_INSERT_WIDTH,
	SHAPE_PRESET_DEFS,
	shapePresetInsertDefaults,
} from './shape-preset-catalog';

describe('shape preset catalogue', () => {
	it('contains the full 32-shape catalogue with unique types', () => {
		expect(SHAPE_PRESET_DEFS).toHaveLength(32);
		const types = SHAPE_PRESET_DEFS.map((d) => d.type);
		expect(new Set(types).size).toBe(types.length);
	});

	it('keeps the top-shapes row (first 12 entries) stable', () => {
		expect(SHAPE_PRESET_DEFS.slice(0, 12).map((d) => d.type)).toStrictEqual([
			'rect',
			'roundRect',
			'ellipse',
			'cylinder',
			'rtArrow',
			'leftArrow',
			'upArrow',
			'downArrow',
			'triangle',
			'rtTriangle',
			'diamond',
			'parallelogram',
		]);
	});

	it('gives every entry a label, i18n key, and glyph', () => {
		for (const def of SHAPE_PRESET_DEFS) {
			expect(def.label.length).toBeGreaterThan(0);
			expect(def.i18nKey).toMatch(/^pptx\./);
			expect(def.glyph.length).toBeGreaterThan(0);
			expect(def.glyphClass).toBeTypeOf('string');
		}
	});

	it('carries the rotation/skew modifiers the pickers render', () => {
		const byType = new Map(SHAPE_PRESET_DEFS.map((d) => [d.type, d]));
		expect(byType.get('leftArrow')?.glyphClass).toBe('rotate-180');
		expect(byType.get('upArrow')?.glyphClass).toBe('-rotate-90');
		expect(byType.get('downArrow')?.glyphClass).toBe('rotate-90');
		expect(byType.get('parallelogram')?.glyphClass).toBe('-skew-x-12');
		expect(byType.get('star5')?.glyphClass).toBe('rotate-45');
		expect(byType.get('rect')?.glyphClass).toBe('');
	});
});

describe('arrow line presets', () => {
	const byType = new Map(SHAPE_PRESET_DEFS.map((d) => [d.type, d]));

	it('sits next to the plain line, so the picker groups the line family', () => {
		const types = SHAPE_PRESET_DEFS.map((d) => d.type);
		expect(types.indexOf('lineArrow')).toBe(types.indexOf('line') + 1);
		expect(types.indexOf('lineDoubleArrow')).toBe(types.indexOf('line') + 2);
	});

	it('inserts `line` geometry, never its own id, which is not a prstGeom', () => {
		expect(byType.get('lineArrow')?.geometryType).toBe('line');
		expect(byType.get('lineDoubleArrow')?.geometryType).toBe('line');
		expect(shapePresetInsertDefaults('lineArrow', { width: 200, height: 150 }).shapeType).toBe(
			'line',
		);
	});

	it('carries the arrowheads that make it an arrow', () => {
		const single = shapePresetInsertDefaults('lineArrow', { width: 200, height: 150 });
		expect(single.style.connectorEndArrow).toBe('triangle');
		expect(single.style.connectorStartArrow).toBeUndefined();

		const double = shapePresetInsertDefaults('lineDoubleArrow', { width: 200, height: 150 });
		expect(double.style.connectorStartArrow).toBe('triangle');
		expect(double.style.connectorEndArrow).toBe('triangle');
	});
});

describe('shapePresetInsertDefaults', () => {
	it('gives the line family a flat, wide, unfilled box', () => {
		for (const preset of ['line', 'lineArrow', 'lineDoubleArrow', 'connector']) {
			const defaults = shapePresetInsertDefaults(preset, { width: 200, height: 150 });
			expect(defaults.width).toBe(LINE_PRESET_INSERT_WIDTH);
			expect(defaults.height).toBe(0);
			expect(defaults.style.fillMode).toBe('none');
		}
	});

	it('leaves filled shapes on the caller default box, with no style override', () => {
		const defaults = shapePresetInsertDefaults('rect', { width: 200, height: 150 });
		expect(defaults).toStrictEqual({
			shapeType: 'rect',
			width: 200,
			height: 150,
			style: {},
		});
	});

	it('passes an unknown preset through rather than inventing a geometry', () => {
		const defaults = shapePresetInsertDefaults('somethingElse', { width: 10, height: 20 });
		expect(defaults.shapeType).toBe('somethingElse');
		expect(defaults.width).toBe(10);
		expect(defaults.height).toBe(20);
	});
});
