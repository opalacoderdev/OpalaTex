// Reads the system clipboard, falling back to the backend API when the
// browser Clipboard API is unavailable (e.g., inside pywebview/Qt).
export async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text !== undefined) return text;
  } catch (_) {
    // fall through to backend fallback
  }
  try {
    const res = await fetch('/api/clipboard/read');
    const data = await res.json();
    return data.text ?? '';
  } catch (_) {
    return '';
  }
}

// Reads an image from the system clipboard. The async Clipboard API is tried
// first for real browsers; the embedded QtWebEngine shell does not implement
// it, so the backend endpoint is the one that actually answers there.
// Returns { blob, mime } or null when the clipboard holds no image.
export async function readClipboardImage() {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const mime = (item.types || []).find((type) => type.startsWith('image/'));
        if (mime) return { blob: await item.getType(mime), mime };
      }
    }
  } catch (_) {
    // fall through to backend fallback
  }
  try {
    const res = await fetch('/api/clipboard/read-image');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.data_b64) return null;
    return { data_b64: data.data_b64, mime: data.mime || 'image/png' };
  } catch (_) {
    return null;
  }
}
