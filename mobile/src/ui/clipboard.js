/**
 * Put text on the system clipboard. Resolves to whether it got there.
 *
 * The asynchronous Clipboard API is the standard way; a web view that does not
 * grant it still honours the older `copy` command from a user gesture.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
