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
