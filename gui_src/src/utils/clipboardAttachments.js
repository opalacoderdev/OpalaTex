// Turns a clipboard payload into files the chat attachment pipeline can upload.
//
// Pasting is the only attachment path where the file has no real name: a
// screenshot always arrives as "image.png", so several pastes would share one
// name and collapse into a single entry wherever attachments are keyed by name.

const GENERIC_IMAGE_NAME = /^(image|screenshot|imagem|captura)([ _-]?\(?\d+\)?)?(\.[a-z0-9+]+)?$/i;

export function extensionForImageMime(mime = '') {
  const subtype = String(mime).split('/')[1] || '';
  const clean = subtype.split(';')[0].trim().toLowerCase();
  if (!clean) return 'png';
  if (clean === 'jpeg') return 'jpg';
  if (clean === 'svg+xml') return 'svg';
  return clean;
}

export function isGenericImageName(name = '') {
  return !String(name).trim() || GENERIC_IMAGE_NAME.test(String(name).trim());
}

export function pastedImageName(mime, index = 0, timestamp = Date.now()) {
  const suffix = index > 0 ? `-${index + 1}` : '';
  return `pasted-image-${timestamp}${suffix}.${extensionForImageMime(mime)}`;
}

function defaultRenameFile(file, name) {
  try {
    if (typeof File === 'function') {
      return new File([file], name, { type: file.type, lastModified: file.lastModified });
    }
  } catch (_) {
    // Some embedded webviews expose File without a usable constructor.
  }
  return file;
}

/** True when the paste carries text the default handler should still insert. */
export function clipboardHasText(clipboardData) {
  if (!clipboardData) return false;
  const types = Array.from(clipboardData.types || []);
  return types.some((type) => type === 'text/plain' || type === 'text');
}

/**
 * Collect the files of a paste, renaming clipboard images to unique names.
 * Files copied from a file manager keep their own name.
 */
export function extractClipboardFiles(clipboardData, options = {}) {
  if (!clipboardData) return [];
  const { timestamp = Date.now(), renameFile = defaultRenameFile } = options;

  const collected = [];
  for (const item of Array.from(clipboardData.items || [])) {
    if (item?.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file) collected.push(file);
  }
  if (collected.length === 0) {
    collected.push(...Array.from(clipboardData.files || []));
  }

  let imageIndex = 0;
  return collected.map((file) => {
    const type = file?.type || '';
    if (!type.startsWith('image/') || !isGenericImageName(file?.name)) return file;
    const renamed = renameFile(file, pastedImageName(type, imageIndex, timestamp));
    imageIndex += 1;
    return renamed || file;
  });
}

/** Decode the base64 payload of /api/clipboard/read-image into a File. */
export function base64ImageToFile(dataB64, mime = 'image/png', timestamp = Date.now()) {
  const binary = atob(dataB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const name = pastedImageName(mime, 0, timestamp);
  return new File([bytes], name, { type: mime });
}
