// ─────────────────────────────────────────────────────────────────────────────
// video.js
//
// What a `video` element actually points at, decided in one place.
//
// A slide's video is stored as a single `src` string, because that is what a
// user has in their hand: a link they copied from YouTube, or a file in the
// project. What has to happen with that string differs completely between the
// two — one becomes an `<iframe>` pointing at a player owned by someone else,
// the other becomes a `<video>` element the browser decodes itself — and five
// surfaces need to agree about which it is: the editing canvas, the thumbnail
// rail, presentation mode, the HTML export and the PPTX export.
//
// So the classification lives here, exactly as `arrowsOf` and `borderOf` in
// model.js hold the answers their surfaces must not disagree about. A video
// that plays in presentation mode and shows a broken box in the export is a
// deck that cannot be given to anyone.
//
// The deck never stores the embed URL, only what the user pasted. Providers
// change their embed paths; a deck written today must still play in three
// years, and it will if what it kept is the address of the video rather than
// the address of a player.
// ─────────────────────────────────────────────────────────────────────────────

// Long enough to exclude a stray path segment, loose enough to accept the id
// formats YouTube has used. The id is taken from whichever URL shape the user
// pasted — the watch page, the short link, the embed, a Short, a livestream.
const YOUTUBE = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([\w-]{6,})/i;
const VIMEO = /vimeo\.com\/(?:video\/)?(\d+)/i;

/** File extensions a browser may be able to play directly. */
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v', 'mkv', 'avi'];

const MIME_BY_EXTENSION = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

/** The extension of a source, ignoring any query string or fragment. */
export function videoExtensionOf(src) {
  const path = String(src || '').split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  if (dot === -1) return '';
  return path.slice(dot + 1).toLowerCase();
}

export function videoMimeOf(src) {
  const data = /^data:([^;,]+)/i.exec(String(src || ''));
  if (data) return data[1];
  return MIME_BY_EXTENSION[videoExtensionOf(src)] || '';
}

/**
 * What `el.src` is, as `{ kind, id, url }`, or null when there is no source.
 *
 * `kind` is `'youtube'`, `'vimeo'` or `'file'`. Anything that is not a
 * recognised provider is a file — including a plain `https://` URL to an `.mp4`
 * on a web server, which a `<video>` element plays as readily as a local one.
 */
export function videoSourceOf(el) {
  const src = String(el?.src ?? '').trim();
  if (!src) return null;

  const youtube = YOUTUBE.exec(src);
  if (youtube) return { kind: 'youtube', id: youtube[1], url: src };

  const vimeo = VIMEO.exec(src);
  if (vimeo) return { kind: 'vimeo', id: vimeo[1], url: src };

  return { kind: 'file', id: '', url: src };
}

/** True when the source is played by a provider's own embedded player. */
export function isEmbeddedVideo(el) {
  const source = videoSourceOf(el);
  return !!source && source.kind !== 'file';
}

/**
 * The page a viewer should be sent to when the video cannot be played where
 * they are — a printed PDF, a slide exported to a format with no media.
 */
export function videoWatchUrl(el) {
  const source = videoSourceOf(el);
  if (!source) return '';
  if (source.kind === 'youtube') return `https://www.youtube.com/watch?v=${source.id}`;
  if (source.kind === 'vimeo') return `https://vimeo.com/${source.id}`;
  return source.url;
}

/**
 * The URL a provider's player is embedded from, or '' for a plain file.
 *
 * The playback options travel as query parameters because that is the only
 * channel an embedded player has: an `<iframe>` obeys no attribute of the page
 * around it. `autoplay` is paired with `mute` deliberately — every browser
 * blocks an unmuted autoplay, so an autoplaying video that was not asked to be
 * muted simply would not start, which reads as a broken slide rather than as a
 * policy.
 */
export function videoEmbedUrl(el, { autoplay = false } = {}) {
  const source = videoSourceOf(el);
  if (!source || source.kind === 'file') return '';

  const start = Math.max(0, Math.round(Number(el.start) || 0));
  const wantsAutoplay = autoplay && el.autoplay !== false;
  const params = new URLSearchParams();

  if (source.kind === 'youtube') {
    if (wantsAutoplay) { params.set('autoplay', '1'); params.set('mute', '1'); }
    else if (el.muted) params.set('mute', '1');
    if (el.loop) {
      params.set('loop', '1');
      // YouTube loops a *playlist*, and a single video only loops when it is
      // named as the playlist — without this the video plays once and stops.
      params.set('playlist', source.id);
    }
    if (el.controls === false) params.set('controls', '0');
    if (start) params.set('start', String(start));
    params.set('rel', '0');
    return `https://www.youtube.com/embed/${source.id}?${params}`;
  }

  if (wantsAutoplay) { params.set('autoplay', '1'); params.set('muted', '1'); }
  else if (el.muted) params.set('muted', '1');
  if (el.loop) params.set('loop', '1');
  if (el.controls === false) params.set('controls', '0');
  // Vimeo takes the start offset as a media fragment, not as a parameter —
  // putting it in the query string would send a literal `#t` to the player.
  const fragment = start ? `#t=${start}s` : '';
  return `https://player.vimeo.com/video/${source.id}?${params}${fragment}`;
}

/**
 * The URL a `<video>` element should load, with the start offset attached as a
 * media fragment — the standard way to say "begin here" to a plain file, and
 * the only one that needs no script beside it in an exported deck.
 */
export function videoFileUrl(el, resolveSrc) {
  const source = videoSourceOf(el);
  if (!source || source.kind !== 'file') return '';
  const url = resolveSrc ? resolveSrc(source.url) : source.url;
  const start = Math.max(0, Math.round(Number(el.start) || 0));
  if (!start || !url) return url;
  return `${url}${url.includes('#') ? '' : `#t=${start}`}`;
}

/** True when a file source names an extension no browser is likely to play. */
export function isUnplayableVideoFile(el) {
  const source = videoSourceOf(el);
  if (!source || source.kind !== 'file') return false;
  const extension = videoExtensionOf(source.url);
  if (!extension || source.url.startsWith('data:')) return false;
  return !VIDEO_EXTENSIONS.includes(extension);
}

/** A short label for a video, for the placeholder the editor draws. */
export function videoLabelOf(el) {
  const source = videoSourceOf(el);
  if (!source) return '';
  if (source.kind === 'youtube') return `YouTube · ${source.id}`;
  if (source.kind === 'vimeo') return `Vimeo · ${source.id}`;
  if (source.url.startsWith('data:')) return videoMimeOf(source.url) || 'video';
  return source.url.split('/').pop() || source.url;
}
