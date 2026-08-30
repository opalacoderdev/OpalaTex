/**
 * system-clipboard.ts: framework-agnostic bridge between the slide model and
 * the *operating system* clipboard.
 *
 * `element-clipboard.ts` owns the in-app clipboard (an element snapshot held in
 * viewer state) and the string codec. This module owns everything needed to
 * round-trip that codec through the real system clipboard, plus the conversion
 * of *foreign* clipboard content — an image copied from a browser or an image
 * editor, text copied from anywhere — into slide elements. Without it a viewer
 * can only paste what it copied itself, so Ctrl+V after copying an image in
 * another application does nothing.
 *
 * The system clipboard carries no custom MIME types portably (browsers sanitize
 * `ClipboardItem` down to `text/plain`, `text/html` and `image/png`), so the
 * serialized element payload travels *inside* `text/html`, base64-encoded in a
 * data attribute on an empty wrapper element. Other applications paste that as
 * an invisible empty div, and the accompanying `text/plain` flavour carries the
 * element text so a paste into a text editor is still meaningful.
 *
 * Bindings supply the DOM half (reading `DataTransfer` / `navigator.clipboard`,
 * decoding a blob to a data URL, measuring an image); everything here is pure
 * and testable in Node.
 *
 * @module render/system-clipboard
 */
import type { ImagePptxElement, PptxElement, TextPptxElement } from 'pptx-viewer-core';

import type { CanvasSize } from '../types';
import {
	type ElementClipboardData,
	deserializeElementClipboard,
	generateElementId,
	prepareElementsForPaste,
	serializeElementClipboard,
} from './element-clipboard';

/** Attribute carrying the base64 element payload inside the `text/html` flavour. */
export const ELEMENT_CLIPBOARD_HTML_ATTRIBUTE = 'data-pptx-viewer-elements';

/** Largest box a pasted image is scaled into, in slide px. */
export const MAX_PASTED_IMAGE_WIDTH = 500;
/** @see MAX_PASTED_IMAGE_WIDTH */
export const MAX_PASTED_IMAGE_HEIGHT = 400;

/** Fallback size used when a pasted image reports no intrinsic dimensions. */
export const FALLBACK_PASTED_IMAGE_WIDTH = 400;
/** @see FALLBACK_PASTED_IMAGE_WIDTH */
export const FALLBACK_PASTED_IMAGE_HEIGHT = 300;

/** Default text box geometry/typography for text pasted from another application. */
export const DEFAULT_PASTED_TEXT_WIDTH = 400;
/** @see DEFAULT_PASTED_TEXT_WIDTH */
export const DEFAULT_PASTED_TEXT_FONT_SIZE = 18;

/** Characters per line assumed when estimating a pasted text box's height. */
const PASTED_TEXT_CHARS_PER_LINE_FACTOR = 0.55;
/** Line box height as a multiple of the font size. */
const PASTED_TEXT_LINE_HEIGHT = 1.4;

/**
 * Clipboard content a binding has read, normalized to the three flavours the
 * viewer can turn into slide elements.
 */
export type SystemClipboardContent =
	/** Elements copied from a pptx-viewer (this window or another one). */
	| { kind: 'elements'; data: ElementClipboardData }
	/** A bitmap, already decoded to a data URL by the binding. */
	| {
			kind: 'image';
			imageData: string;
			/** Intrinsic size in px; `0`/omitted falls back to {@link FALLBACK_PASTED_IMAGE_WIDTH}. */
			naturalWidth?: number;
			naturalHeight?: number;
	  }
	/** Plain text. */
	| { kind: 'text'; text: string };

/** Options for {@link elementsFromSystemClipboardContent}. */
export interface SystemClipboardPasteOptions {
	/** Slide canvas size, used to centre freshly created elements. */
	canvasSize: CanvasSize;
	/** Whether the paste target is the template (master/layout) store. */
	intoTemplate?: boolean;
}

/* ------------------------------------------------------------------ */
/*  UTF-8 safe base64                                                  */
/* ------------------------------------------------------------------ */

/**
 * `btoa` only accepts latin-1, and a serialized payload routinely contains
 * non-ASCII slide text, so the string is UTF-8 encoded before it is base64'd.
 */
function utf8ToBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToUtf8(base64: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ */
/*  text/html transport                                                */
/* ------------------------------------------------------------------ */

/**
 * Wrap elements into the `text/html` clipboard flavour: an empty div whose
 * data attribute carries the base64 of {@link serializeElementClipboard}.
 *
 * Empty on purpose — pasting into a foreign rich-text target must not inject
 * visible markup; those targets use the `text/plain` flavour instead.
 */
export function encodeElementClipboardHtml(
	elements: PptxElement[],
	isTemplate: boolean = false,
): string {
	const payload = utf8ToBase64(serializeElementClipboard(elements, isTemplate));
	return `<div ${ELEMENT_CLIPBOARD_HTML_ATTRIBUTE}="${payload}"></div>`;
}

/**
 * Recover elements from the `text/html` clipboard flavour.
 *
 * Returns `null` for HTML that carries no payload (anything copied from another
 * application), so callers fall back to their image/text paste path. The
 * attribute value is base64, so it can never contain the quote that ends it.
 */
export function decodeElementClipboardHtml(html: string): ElementClipboardData | null {
	const match = new RegExp(`${ELEMENT_CLIPBOARD_HTML_ATTRIBUTE}="([A-Za-z0-9+/=]*)"`).exec(html);
	if (!match?.[1]) {
		return null;
	}
	let json: string;
	try {
		json = base64ToUtf8(match[1]);
	} catch {
		return null;
	}
	return deserializeElementClipboard(json);
}

/**
 * The `text/plain` flavour written alongside the HTML payload: the copied
 * elements' text, so a paste into a text editor carries something readable.
 * Empty when the selection has no text (a picture, a plain shape).
 */
export function elementsToPlainText(elements: PptxElement[]): string {
	return elements
		.map((element) => {
			const text = (element as { text?: unknown }).text;
			return typeof text === 'string' ? text : '';
		})
		.filter((text) => text.length > 0)
		.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Foreign content → elements                                         */
/* ------------------------------------------------------------------ */

/** Scale `width`/`height` down to fit `maxWidth`/`maxHeight`, preserving aspect ratio. */
export function fitWithinBounds(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number,
): CanvasSize {
	if (width <= maxWidth && height <= maxHeight) {
		return { width: Math.round(width), height: Math.round(height) };
	}
	const scale = Math.min(maxWidth / width, maxHeight / height);
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Fresh element ids must keep a template prefix when the paste target is the
 * template store, or later edits — which route by id prefix — would be written
 * to the slide instead and lost on save. A brand-new element has no source id
 * to inherit `master-`/`layout-` from, so it joins the layout store, the one
 * the template editor edits by default.
 */
function newElementId(intoTemplate: boolean): string {
	return intoTemplate ? `layout-${generateElementId()}` : generateElementId();
}

/** Build the image element inserted when a bitmap is pasted from another application. */
export function createPastedImageElement(
	imageData: string,
	options: SystemClipboardPasteOptions & { naturalWidth?: number; naturalHeight?: number },
): ImagePptxElement {
	const { canvasSize, intoTemplate = false, naturalWidth, naturalHeight } = options;
	const { width, height } = fitWithinBounds(
		naturalWidth && naturalWidth > 0 ? naturalWidth : FALLBACK_PASTED_IMAGE_WIDTH,
		naturalHeight && naturalHeight > 0 ? naturalHeight : FALLBACK_PASTED_IMAGE_HEIGHT,
		MAX_PASTED_IMAGE_WIDTH,
		MAX_PASTED_IMAGE_HEIGHT,
	);
	return {
		id: newElementId(intoTemplate),
		type: 'image',
		x: Math.round((canvasSize.width - width) / 2),
		y: Math.round((canvasSize.height - height) / 2),
		width,
		height,
		imageData,
	} as ImagePptxElement;
}

/** Build the text box inserted when plain text is pasted from another application. */
export function createPastedTextElement(
	text: string,
	options: SystemClipboardPasteOptions & { fontSize?: number; width?: number },
): TextPptxElement {
	const {
		canvasSize,
		intoTemplate = false,
		fontSize = DEFAULT_PASTED_TEXT_FONT_SIZE,
		width = DEFAULT_PASTED_TEXT_WIDTH,
	} = options;
	// The real line count depends on the font metrics the renderer ends up with,
	// so the box is only sized approximately; the user can resize it, and the
	// text renderer does not clip.
	const charsPerLine = Math.max(
		1,
		Math.floor(width / (fontSize * PASTED_TEXT_CHARS_PER_LINE_FACTOR)),
	);
	const lines = text
		.split('\n')
		.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
	const height = Math.round(Math.max(1, lines) * fontSize * PASTED_TEXT_LINE_HEIGHT);
	const boxWidth = Math.min(width, canvasSize.width);
	return {
		id: newElementId(intoTemplate),
		type: 'text',
		x: Math.round((canvasSize.width - boxWidth) / 2),
		y: Math.round(Math.max(0, (canvasSize.height - height) / 2)),
		width: boxWidth,
		height,
		text,
		textStyle: { fontSize },
	} as TextPptxElement;
}

/**
 * Convert whatever a binding read from the system clipboard into the elements
 * to append to the active slide.
 *
 * Elements copied from a viewer keep their full fidelity and get the standard
 * cascade offset; foreign content becomes one new image or text element,
 * centred on the slide. Returns an empty array for content that yields nothing
 * (blank text), so callers can fall back to the in-app clipboard.
 */
export function elementsFromSystemClipboardContent(
	content: SystemClipboardContent,
	options: SystemClipboardPasteOptions,
): PptxElement[] {
	const { intoTemplate = false } = options;
	switch (content.kind) {
		case 'elements':
			return prepareElementsForPaste(content.data, { intoTemplate });
		case 'image':
			return [
				createPastedImageElement(content.imageData, {
					...options,
					naturalWidth: content.naturalWidth,
					naturalHeight: content.naturalHeight,
				}),
			];
		case 'text': {
			const text = content.text.replace(/\r\n/gu, '\n').trim();
			if (!text) {
				return [];
			}
			return [createPastedTextElement(text, options)];
		}
	}
}
