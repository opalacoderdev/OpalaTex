// ─────────────────────────────────────────────────────────────────────────────
// clipboard.js
//
// The bridge between the system clipboard and the deck model. `model.js` owns
// the payload format — serializing and parsing the tagged envelope — and knows
// nothing about the browser; everything environment-dependent lives here.
//
// Two things shape this file:
//
//   • The clipboard is read twice, by two different mechanisms, because neither
//     one works everywhere. A native `paste` event carries `clipboardData`
//     synchronously and is the only path that ever sees an image the user
//     copied from another application in a real browser; the embedded
//     QtWebEngine shell (see utils/clipboard.js) does not implement the async
//     Clipboard API at all and answers through the backend instead. The editor
//     therefore arms both and lets whichever fires first win.
//   • A paste is classified, never guessed at. `readSlidePayload` returns what
//     the clipboard actually holds — deck elements, an image, or plain text —
//     and the caller decides what each one becomes. Text that is not a deck
//     payload is never coerced into one.
// ─────────────────────────────────────────────────────────────────────────────

import { parseClipboard, serializeClipboard } from './model.js';
import { readClipboard, readClipboardImage, writeClipboard } from '../utils/clipboard.js';

/**
 * A clipboard payload the slide editor can act on:
 *
 *   { kind: 'elements', elements }  — copied from a deck, here or in another window
 *   { kind: 'image',    src }       — a data URI, ready to become an image element
 *   { kind: 'text',     text }      — anything else, to become a text box
 *
 * or null when the clipboard holds nothing usable.
 */

/** Puts elements on the system clipboard. Resolves to whether it worked. */
export function writeElements(elements) {
  return writeClipboard(serializeClipboard(elements));
}

/** Reads a `File`/`Blob` as a data URI, so an image is self-contained in the deck. */
export function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '') || null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * The payload carried by a native paste event, or null when the event has
 * nothing this editor can use — in which case the caller falls back to
 * `readSlidePayload`, which can still reach the clipboard through the backend.
 *
 * Synchronous inspection first (`hasUsableData`), because `preventDefault` has
 * to be called before the first `await` or the browser will paste on top of us.
 */
export function hasUsableData(clipboardData) {
  if (!clipboardData) return false;
  if (clipboardData.getData('text/plain')) return true;
  return !!imageItemOf(clipboardData);
}

function imageItemOf(clipboardData) {
  const items = Array.from(clipboardData.items || []);
  return items.find(item => item.kind === 'file' && String(item.type).startsWith('image/')) || null;
}

export async function payloadFromClipboardData(clipboardData) {
  if (!clipboardData) return null;
  // Deck elements first: an element copied out of a slide is put on the
  // clipboard as text, and if the source application also offered an image
  // rendition the text is still the higher-fidelity one.
  const text = clipboardData.getData('text/plain') || '';
  const elements = parseClipboard(text);
  if (elements) return { kind: 'elements', elements };

  const item = imageItemOf(clipboardData);
  if (item) {
    const file = item.getAsFile();
    const src = file ? await blobToDataUrl(file) : null;
    if (src) return { kind: 'image', src };
  }

  return text ? { kind: 'text', text } : null;
}

/**
 * The payload on the system clipboard, read asynchronously.
 *
 * This is the path used when no native paste event arrives — the context menu's
 * Paste, and Ctrl+V inside the QtWebEngine shell, where the browser delivers no
 * `clipboardData`. Order matches `payloadFromClipboardData`, so a paste means
 * the same thing whichever path served it.
 */
export async function readSlidePayload() {
  const text = await readClipboard();
  const elements = parseClipboard(text);
  if (elements) return { kind: 'elements', elements };

  const image = await readClipboardImage();
  if (image) {
    if (image.data_b64) return { kind: 'image', src: `data:${image.mime};base64,${image.data_b64}` };
    if (image.blob) {
      const src = await blobToDataUrl(image.blob);
      if (src) return { kind: 'image', src };
    }
  }

  return text ? { kind: 'text', text } : null;
}
