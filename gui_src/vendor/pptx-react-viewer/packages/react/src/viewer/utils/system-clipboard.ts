/**
 * system-clipboard: the DOM half of the system-clipboard bridge.
 *
 * `pptx-viewer-shared` (render/system-clipboard.ts) owns the pure part — the
 * `text/html` transport for copied elements and the conversion of foreign
 * clipboard content into slide elements. This module owns the browser APIs it
 * cannot use: reading a paste event's `DataTransfer`, reading
 * `navigator.clipboard`, decoding a blob to a data URL, and measuring a bitmap.
 *
 * Two read paths exist because they have different capabilities:
 *
 * - {@link readClipboardContentFromDataTransfer} serves the native `paste`
 *   event (Ctrl+V). The event hands the data over directly, so it needs no
 *   permission and never prompts. This is the path that must work.
 * - {@link readClipboardContentFromNavigator} serves the toolbar and
 *   context-menu Paste commands, which have no event to read from. The async
 *   Clipboard API may be unavailable or denied; it resolves to `null` then, and
 *   the caller falls back to the in-app clipboard.
 */
import {
	type SystemClipboardContent,
	decodeElementClipboardHtml,
	elementsToPlainText,
	encodeElementClipboardHtml,
} from 'pptx-viewer-shared';
import type { PptxElement } from 'pptx-viewer-core';

/** Read a clipboard image blob as a data URL, the form image elements store. */
export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error('Could not read clipboard image.'));
		reader.readAsDataURL(blob);
	});
}

/**
 * Measure a data URL's intrinsic size. Resolves to zeros rather than rejecting
 * when the bitmap fails to decode, so the caller still inserts the image at the
 * fallback size instead of dropping the paste.
 */
export function measureImageDataUrl(dataUrl: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve({ width: 0, height: 0 });
		image.src = dataUrl;
	});
}

async function imageContentFromBlob(blob: Blob): Promise<SystemClipboardContent | null> {
	const imageData = await blobToDataUrl(blob).catch(() => null);
	if (!imageData) {
		return null;
	}
	const { width, height } = await measureImageDataUrl(imageData);
	return { kind: 'image', imageData, naturalWidth: width, naturalHeight: height };
}

/**
 * Normalize a paste event's `DataTransfer`.
 *
 * Flavours are tried in the order that keeps the user's intent: elements copied
 * from a viewer first (they are the richest and are only ever present when the
 * user copied them here), then a bitmap, then text.
 */
export async function readClipboardContentFromDataTransfer(
	dataTransfer: DataTransfer | null,
): Promise<SystemClipboardContent | null> {
	if (!dataTransfer) {
		return null;
	}

	// A DataTransfer is only readable while the event is being dispatched, so
	// every flavour is pulled out synchronously, before the first await.
	const html = dataTransfer.getData('text/html');
	const text = dataTransfer.getData('text/plain');
	const imageFiles = Array.from(dataTransfer.items ?? [])
		.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
		.map((item) => item.getAsFile())
		.filter((file): file is File => file !== null);

	if (html) {
		const data = decodeElementClipboardHtml(html);
		if (data) {
			return { kind: 'elements', data };
		}
	}

	for (const file of imageFiles) {
		const content = await imageContentFromBlob(file);
		if (content) {
			return content;
		}
	}

	return text ? { kind: 'text', text } : null;
}

/**
 * Normalize what the async Clipboard API reports, for paste commands that have
 * no event to read from. Resolves to `null` when the API is missing, blocked,
 * or the permission is denied — every one of which is an ordinary state here,
 * not an error worth surfacing.
 */
export async function readClipboardContentFromNavigator(): Promise<SystemClipboardContent | null> {
	const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
	if (!clipboard) {
		return null;
	}

	if (typeof clipboard.read === 'function') {
		try {
			const items = await clipboard.read();
			for (const item of items) {
				if (item.types.includes('text/html')) {
					const html = await (await item.getType('text/html')).text();
					const data = decodeElementClipboardHtml(html);
					if (data) {
						return { kind: 'elements', data };
					}
				}
			}
			for (const item of items) {
				const imageType = item.types.find((type) => type.startsWith('image/'));
				if (imageType) {
					const content = await imageContentFromBlob(await item.getType(imageType));
					if (content) {
						return content;
					}
				}
			}
			for (const item of items) {
				if (item.types.includes('text/plain')) {
					const text = await (await item.getType('text/plain')).text();
					if (text) {
						return { kind: 'text', text };
					}
				}
			}
			return null;
		} catch {
			// Permission denied, or a clipboard the browser refuses to expose:
			// fall through to the text-only API, which is granted more widely.
		}
	}

	if (typeof clipboard.readText === 'function') {
		try {
			const text = await clipboard.readText();
			return text ? { kind: 'text', text } : null;
		} catch {
			return null;
		}
	}

	return null;
}

/**
 * Publish copied elements to the system clipboard so they can be pasted into
 * another viewer window, and their text into any other application.
 *
 * Best-effort by design: writing needs a user gesture and a permission the
 * embedder may withhold. `false` means the in-app clipboard is the only copy,
 * which the paste handlers already fall back to.
 */
export async function writeElementsToSystemClipboard(
	elements: PptxElement[],
	isTemplate: boolean = false,
): Promise<boolean> {
	const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
	if (!clipboard || !elements.length) {
		return false;
	}

	const html = encodeElementClipboardHtml(elements, isTemplate);
	const plainText = elementsToPlainText(elements);

	if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
		try {
			await clipboard.write([
				new ClipboardItem({
					'text/html': new Blob([html], { type: 'text/html' }),
					'text/plain': new Blob([plainText], { type: 'text/plain' }),
				}),
			]);
			return true;
		} catch {
			// Fall through: some embedders expose writeText() only.
		}
	}

	if (typeof clipboard.writeText === 'function' && plainText) {
		try {
			await clipboard.writeText(plainText);
			// The element payload did not make it out, only the text did.
			return false;
		} catch {
			return false;
		}
	}

	return false;
}
