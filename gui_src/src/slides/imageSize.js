// ─────────────────────────────────────────────────────────────────────────────
// imageSize.js
//
// The natural pixel size of a picture, which the PPTX export cannot do without.
//
// CSS `object-fit: contain` — the deck's default for an image — letterboxes a
// picture inside its box. PowerPoint has no equivalent property: a picture fills
// the frame it is given, full stop. So the export has to do the letterboxing
// itself, and to letterbox it has to know the aspect ratio of the pixels. An
// export that skips this step is the one the user sees: every photograph in the
// deck stretched to the shape of the box someone drew around it.
//
// Two ways to find that out, because this runs in two places:
//
//   • With a DOM, the browser decodes the picture and reports it. Correct for
//     every format the browser can show, which is the definition that matters.
//   • Without one — `node --test`, and any headless use — the bytes are read
//     directly. Only the handful of formats a deck can actually contain are
//     understood; anything else returns null and the caller stretches, which is
//     what it did before this module existed.
// ─────────────────────────────────────────────────────────────────────────────

/** The bytes behind a `data:` URI, or null for any other kind of source. */
function bytesOfDataUri(src) {
  const match = /^data:([^,]*),(.*)$/s.exec(src);
  if (!match) return null;
  const meta = match[1];
  const payload = match[2];
  try {
    if (/;base64$/i.test(meta)) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

function u16be(b, at) { return (b[at] << 8) | b[at + 1]; }
function u32be(b, at) { return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0; }
function u32le(b, at) { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }

/**
 * `{ w, h }` read from an image's own header, or null.
 *
 * Deliberately not a decoder: each format is read only as far as the field that
 * says how big it is.
 */
export function sizeFromBytes(bytes) {
  if (!bytes || bytes.length < 16) return null;

  // PNG — IHDR is always the first chunk, at a fixed offset.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { w: u32be(bytes, 16), h: u32be(bytes, 20) };
  }

  // GIF — the logical screen descriptor, little-endian, right after the magic.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: bytes[6] | (bytes[7] << 8), h: bytes[8] | (bytes[9] << 8) };
  }

  // BMP — the DIB header's width and height; height is signed and negative for
  // a top-down bitmap, which is a storage order, not a different size.
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const h = u32le(bytes, 22);
    return { w: u32le(bytes, 18), h: h > 0x7fffffff ? 0x100000000 - h : h };
  }

  // WebP — three container shapes, each storing the size in its own place.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const kind = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (kind === 'VP8 ') {
      return { w: (bytes[26] | (bytes[27] << 8)) & 0x3fff, h: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') {
      return {
        w: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
        h: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
      };
    }
    return null;
  }

  // JPEG — the size lives in a start-of-frame marker somewhere after the
  // metadata, so the segment chain has to be walked to find it.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1];
      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;   // end, or entropy data
      const length = u16be(bytes, at + 2);
      // Every SOFn but the four that are not frame headers.
      const isFrame = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { w: u16be(bytes, at + 7), h: u16be(bytes, at + 5) };
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }

  return null;
}

/** An SVG's size, from its own attributes. */
function sizeFromSvg(text) {
  const viewBox = /viewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)/.exec(text);
  if (viewBox) {
    const w = parseFloat(viewBox[1]);
    const h = parseFloat(viewBox[2]);
    if (w > 0 && h > 0) return { w, h };
  }
  const width = /\bwidth\s*=\s*["']([\d.eE]+)/.exec(text);
  const height = /\bheight\s*=\s*["']([\d.eE]+)/.exec(text);
  if (width && height) {
    const w = parseFloat(width[1]);
    const h = parseFloat(height[1]);
    if (w > 0 && h > 0) return { w, h };
  }
  return null;
}

/**
 * The natural size of the picture at `src`, or null when it cannot be found.
 *
 * Null is a normal answer — an unreachable URL, a format nobody sniffs, a
 * picture the browser refuses — and the caller's job is to carry on without it,
 * not to fail the export over one image.
 */
export async function naturalSize(src) {
  if (!src) return null;

  if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
    const measured = await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(
        image.naturalWidth && image.naturalHeight
          ? { w: image.naturalWidth, h: image.naturalHeight }
          : null,
      );
      image.onerror = () => resolve(null);
      image.src = src;
    });
    if (measured) return measured;
  }

  const bytes = bytesOfDataUri(src);
  if (!bytes) return null;
  if (/^data:image\/svg\+xml/i.test(src)) {
    return sizeFromSvg(new TextDecoder().decode(bytes));
  }
  return sizeFromBytes(bytes);
}

/**
 * Where a picture of `natural` size lands inside `box` under a CSS `fit`.
 *
 * Returns the rectangle to draw it in and the crop to apply, in the shape the
 * two consumers want: `rect` is a plain box PowerPoint can be handed directly,
 * and `crop` is the fraction of the picture to cut from each side, which is the
 * only way `cover` can be expressed there.
 */
export function fitRect(box, natural, fit) {
  if (!natural || !natural.w || !natural.h || fit === 'fill') {
    return { rect: { ...box }, crop: null };
  }
  const boxRatio = box.h / box.w;
  const imageRatio = natural.h / natural.w;

  if (fit === 'cover') {
    // The picture keeps the whole box and loses its overflowing edges, so the
    // crop is what changes rather than the rectangle.
    const overflow = imageRatio > boxRatio
      ? { axis: 'y', amount: 1 - boxRatio / imageRatio }
      : { axis: 'x', amount: 1 - imageRatio / boxRatio };
    const half = Math.max(0, overflow.amount / 2);
    return {
      rect: { ...box },
      crop: overflow.axis === 'y'
        ? { left: 0, right: 0, top: half, bottom: half }
        : { left: half, right: half, top: 0, bottom: 0 },
    };
  }

  // contain: the picture shrinks to fit and is centred in what is left.
  const w = imageRatio > boxRatio ? box.h / imageRatio : box.w;
  const h = imageRatio > boxRatio ? box.h : box.w * imageRatio;
  return {
    rect: {
      x: box.x + (box.w - w) / 2,
      y: box.y + (box.h - h) / 2,
      w,
      h,
    },
    crop: null,
  };
}
