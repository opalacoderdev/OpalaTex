import type { ImagePptxElement, PptxElement, TextPptxElement } from 'pptx-viewer-core';
import { describe, expect, it } from 'vitest';

import { PASTE_OFFSET_PX, serializeElementClipboard } from './element-clipboard';
import {
	createPastedImageElement,
	createPastedTextElement,
	decodeElementClipboardHtml,
	elementsFromSystemClipboardContent,
	elementsToPlainText,
	ELEMENT_CLIPBOARD_HTML_ATTRIBUTE,
	encodeElementClipboardHtml,
	fitWithinBounds,
	MAX_PASTED_IMAGE_HEIGHT,
	MAX_PASTED_IMAGE_WIDTH,
} from './system-clipboard';

const CANVAS = { width: 960, height: 540 };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function makeElement(overrides: Partial<PptxElement> & { id: string }): PptxElement {
	return {
		type: 'shape',
		x: 100,
		y: 200,
		width: 50,
		height: 60,
		...overrides,
	} as PptxElement;
}

describe('text/html transport', () => {
	it('round-trips elements through the html flavour', () => {
		const elements = [makeElement({ id: 'a' }), makeElement({ id: 'b', x: 0 })];
		const decoded = decodeElementClipboardHtml(encodeElementClipboardHtml(elements));
		expect(decoded?.elements.map((el) => el.id)).toEqual(['a', 'b']);
		expect(decoded?.isTemplate).toBe(false);
	});

	it('preserves non-ASCII slide text, which btoa alone cannot carry', () => {
		const element = makeElement({ id: 'a', text: 'Apresentação — 1{,}5 °C' } as never);
		const decoded = decodeElementClipboardHtml(encodeElementClipboardHtml([element]));
		expect((decoded?.elements[0] as { text?: string }).text).toBe('Apresentação — 1{,}5 °C');
	});

	it('carries the isTemplate flag', () => {
		const decoded = decodeElementClipboardHtml(
			encodeElementClipboardHtml([makeElement({ id: 'a' })], true),
		);
		expect(decoded?.isTemplate).toBe(true);
	});

	it('emits an empty wrapper so foreign rich-text targets see no markup', () => {
		const html = encodeElementClipboardHtml([makeElement({ id: 'a' })]);
		expect(html).toContain(ELEMENT_CLIPBOARD_HTML_ATTRIBUTE);
		expect(html.replace(/<[^>]*>/gu, '')).toBe('');
	});

	it('returns null for html copied from another application', () => {
		expect(decodeElementClipboardHtml('<p>Hello <b>world</b></p>')).toBeNull();
		expect(decodeElementClipboardHtml('')).toBeNull();
	});

	it('returns null when the payload is not a valid element clipboard', () => {
		const html = `<div ${ELEMENT_CLIPBOARD_HTML_ATTRIBUTE}="${btoa('{"marker":"other"}')}"></div>`;
		expect(decodeElementClipboardHtml(html)).toBeNull();
	});

	it('rejects a payload whose base64 is corrupt rather than throwing', () => {
		const html = `<div ${ELEMENT_CLIPBOARD_HTML_ATTRIBUTE}="=="></div>`;
		expect(decodeElementClipboardHtml(html)).toBeNull();
	});
});

describe('elementsToPlainText', () => {
	it('joins the text of the copied elements', () => {
		const elements = [
			makeElement({ id: 'a', text: 'First' } as never),
			makeElement({ id: 'b' }),
			makeElement({ id: 'c', text: 'Second' } as never),
		];
		expect(elementsToPlainText(elements)).toBe('First\nSecond');
	});

	it('is empty for a selection with no text', () => {
		expect(elementsToPlainText([makeElement({ id: 'a' })])).toBe('');
	});
});

describe('fitWithinBounds', () => {
	it('leaves a small box untouched', () => {
		expect(fitWithinBounds(120, 80, 500, 400)).toEqual({ width: 120, height: 80 });
	});

	it('scales down preserving the aspect ratio', () => {
		expect(fitWithinBounds(1000, 500, 500, 400)).toEqual({ width: 500, height: 250 });
		expect(fitWithinBounds(500, 1000, 500, 400)).toEqual({ width: 200, height: 400 });
	});
});

describe('createPastedImageElement', () => {
	it('caps a large bitmap and centres it on the slide', () => {
		const element = createPastedImageElement(PNG, {
			canvasSize: CANVAS,
			naturalWidth: 1920,
			naturalHeight: 1080,
		});
		expect(element.width).toBeLessThanOrEqual(MAX_PASTED_IMAGE_WIDTH);
		expect(element.height).toBeLessThanOrEqual(MAX_PASTED_IMAGE_HEIGHT);
		expect(element.x).toBe(Math.round((CANVAS.width - element.width) / 2));
		expect(element.y).toBe(Math.round((CANVAS.height - element.height) / 2));
		expect((element as ImagePptxElement).imageData).toBe(PNG);
	});

	it('falls back to a default size when the bitmap reports none', () => {
		const element = createPastedImageElement(PNG, { canvasSize: CANVAS });
		expect(element.width).toBeGreaterThan(0);
		expect(element.height).toBeGreaterThan(0);
	});
});

describe('createPastedTextElement', () => {
	it('creates a centred text box carrying the pasted text', () => {
		const element = createPastedTextElement('Hello', { canvasSize: CANVAS });
		expect((element as TextPptxElement).text).toBe('Hello');
		expect(element.height).toBeGreaterThan(0);
		expect(element.x).toBe(Math.round((CANVAS.width - element.width) / 2));
	});

	it('grows taller for more lines', () => {
		const short = createPastedTextElement('one', { canvasSize: CANVAS });
		const long = createPastedTextElement('one\ntwo\nthree\nfour', { canvasSize: CANVAS });
		expect(long.height).toBeGreaterThan(short.height);
	});

	it('never exceeds the slide width', () => {
		const element = createPastedTextElement('Hello', {
			canvasSize: { width: 200, height: 200 },
		});
		expect(element.width).toBeLessThanOrEqual(200);
	});
});

describe('elementsFromSystemClipboardContent', () => {
	it('clones viewer elements with fresh ids and the cascade offset', () => {
		const source = makeElement({ id: 'a' });
		const [pasted] = elementsFromSystemClipboardContent(
			{ kind: 'elements', data: { elements: [source], isTemplate: false } },
			{ canvasSize: CANVAS },
		);
		expect(pasted.id).not.toBe('a');
		expect(pasted.x).toBe(source.x + PASTE_OFFSET_PX);
		expect(pasted.y).toBe(source.y + PASTE_OFFSET_PX);
	});

	it('turns a bitmap into a single image element', () => {
		const elements = elementsFromSystemClipboardContent(
			{ kind: 'image', imageData: PNG, naturalWidth: 100, naturalHeight: 50 },
			{ canvasSize: CANVAS },
		);
		expect(elements).toHaveLength(1);
		expect(elements[0].type).toBe('image');
	});

	it('turns text into a single text element, trimming surrounding whitespace', () => {
		const elements = elementsFromSystemClipboardContent(
			{ kind: 'text', text: '  hello\r\nworld  ' },
			{ canvasSize: CANVAS },
		);
		expect(elements).toHaveLength(1);
		expect((elements[0] as TextPptxElement).text).toBe('hello\nworld');
	});

	it('yields nothing for blank text, so the caller can fall back', () => {
		expect(
			elementsFromSystemClipboardContent({ kind: 'text', text: '   \n ' }, { canvasSize: CANVAS }),
		).toEqual([]);
	});

	it('gives fresh elements a template-prefixed id when pasting into the template', () => {
		const [image] = elementsFromSystemClipboardContent(
			{ kind: 'image', imageData: PNG },
			{ canvasSize: CANVAS, intoTemplate: true },
		);
		expect(image.id).toMatch(/^layout-/);
	});

	it('decodes what the html transport produced, end to end', () => {
		const html = encodeElementClipboardHtml([makeElement({ id: 'a', text: 'x' } as never)]);
		const data = decodeElementClipboardHtml(html);
		expect(data).not.toBeNull();
		const elements = elementsFromSystemClipboardContent(
			{ kind: 'elements', data: data as NonNullable<typeof data> },
			{ canvasSize: CANVAS },
		);
		expect(elements).toHaveLength(1);
		expect(serializeElementClipboard(elements)).toContain('"x"');
	});
});
