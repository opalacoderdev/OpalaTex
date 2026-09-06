// ─────────────────────────────────────────────────────────────────────────────
// geometry.js
//
// The math behind direct manipulation: dragging a box, resizing it from one of
// its eight handles, and snapping either operation to the alignments a user
// expects. Kept free of React and of the DOM so it can be tested directly —
// this is the layer where an off-by-one becomes a box that drifts under the
// cursor, which is very hard to diagnose from the UI.
//
// All coordinates are deck units (see model.js). The canvas converts pointer
// pixels to deck units before calling in, so nothing here knows about zoom.
// ─────────────────────────────────────────────────────────────────────────────

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// Below this an element stops being clickable, so resize refuses to go further
// rather than letting the user lose a box behind its own handles.
export const MIN_SIZE = 16;

// Distance, in deck units, within which an edge snaps. Applied after the
// pointer delta, so it never fights the user: it only trims the last few units.
export const SNAP_THRESHOLD = 8;

// ── click pairing ────────────────────────────────────────────────────────────
// Two presses on the same element, close in time and position, are a double
// click. This is computed rather than read off the event because `pointerdown`
// carries `detail = 0` in Chrome — the click count exists only on `mousedown`,
// `click` and `dblclick`, none of which the gesture layer listens to. The
// values mirror the platform defaults browsers use for their own dblclick
// synthesis.
export const DOUBLE_CLICK_MS = 450;
export const DOUBLE_CLICK_SLOP_PX = 6;

/** `previous` and `press` are {id, time, x, y}; `previous` may be null. */
export function isDoubleClick(previous, press,
  { withinMs = DOUBLE_CLICK_MS, slop = DOUBLE_CLICK_SLOP_PX } = {}) {
  if (!previous || previous.id !== press.id) return false;
  if (press.time - previous.time > withinMs) return false;
  if (press.time < previous.time) return false;
  return Math.abs(press.x - previous.x) <= slop && Math.abs(press.y - previous.y) <= slop;
}

export function rectOf(el) {
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

export function edgesOf(rect) {
  return {
    left: rect.x,
    right: rect.x + rect.w,
    top: rect.y,
    bottom: rect.y + rect.h,
    cx: rect.x + rect.w / 2,
    cy: rect.y + rect.h / 2,
  };
}

// The lines a moving element snaps to: the slide's own edges and centre, plus
// every edge and centre of the other elements on the slide.
export function snapTargets(deck, slide, excludeId) {
  const vertical = [0, deck.width / 2, deck.width];
  const horizontal = [0, deck.height / 2, deck.height];
  for (const el of slide.elements) {
    if (el.id === excludeId) continue;
    const e = edgesOf(rectOf(el));
    vertical.push(e.left, e.cx, e.right);
    horizontal.push(e.top, e.cy, e.bottom);
  }
  return { vertical, horizontal };
}

// Finds the smallest correction that brings any of `candidates` onto a target.
// Returns the correction and the target line, so the canvas can draw the guide
// the user is snapped to — a snap with no visible guide reads as a glitch.
function bestSnap(candidates, targets, threshold) {
  let best = null;
  for (const value of candidates) {
    for (const target of targets) {
      const delta = target - value;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, target };
    }
  }
  return best;
}

// Moves `rect` by (dx, dy), then snaps. `snap: false` (Alt held) skips it.
export function dragRect(rect, dx, dy, { targets = null, snap = true, threshold = SNAP_THRESHOLD } = {}) {
  const moved = { ...rect, x: rect.x + dx, y: rect.y + dy };
  if (!snap || !targets) return { rect: moved, guides: [] };

  const e = edgesOf(moved);
  const vertical = bestSnap([e.left, e.cx, e.right], targets.vertical, threshold);
  const horizontal = bestSnap([e.top, e.cy, e.bottom], targets.horizontal, threshold);

  const guides = [];
  if (vertical) {
    moved.x += vertical.delta;
    guides.push({ axis: 'v', at: vertical.target });
  }
  if (horizontal) {
    moved.y += horizontal.delta;
    guides.push({ axis: 'h', at: horizontal.target });
  }
  return { rect: moved, guides };
}

// Which edges a handle drags. 'n' moves the top edge and leaves x/w alone, and
// so on; the corner handles set both.
const HANDLE_EDGES = {
  nw: { x: true, y: true, w: -1, h: -1 },
  n:  { x: false, y: true, w: 0, h: -1 },
  ne: { x: false, y: true, w: 1, h: -1 },
  e:  { x: false, y: false, w: 1, h: 0 },
  se: { x: false, y: false, w: 1, h: 1 },
  s:  { x: false, y: false, w: 0, h: 1 },
  sw: { x: true, y: false, w: -1, h: 1 },
  w:  { x: true, y: false, w: -1, h: 0 },
};

// Resizes from one handle. The opposite corner stays put, which is what makes
// a resize feel anchored; `aspect` (Shift) preserves the starting ratio.
export function resizeRect(rect, handle, dx, dy, { aspect = false, min = MIN_SIZE } = {}) {
  const spec = HANDLE_EDGES[handle];
  if (!spec) return { ...rect };

  let { x, y, w, h } = rect;

  if (spec.w !== 0) {
    const delta = spec.w === -1 ? -dx : dx;
    w = rect.w + delta;
    if (spec.x) x = rect.x + rect.w - w;   // anchor the right edge
  }
  if (spec.h !== 0) {
    const delta = spec.h === -1 ? -dy : dy;
    h = rect.h + delta;
    if (spec.y) y = rect.y + rect.h - h;   // anchor the bottom edge
  }

  // A corner drag with Shift follows whichever axis the user pushed further,
  // so the box tracks the cursor instead of snapping between two ratios.
  if (aspect && spec.w !== 0 && spec.h !== 0) {
    const ratio = rect.w / rect.h;
    if (Math.abs(w - rect.w) >= Math.abs(h - rect.h)) h = w / ratio;
    else w = h * ratio;
    if (spec.x) x = rect.x + rect.w - w;
    if (spec.y) y = rect.y + rect.h - h;
  }

  // Clamping happens after the anchor is applied, or a box shrunk past the
  // minimum from a north/west handle would walk across the slide.
  if (w < min) {
    if (spec.x) x = rect.x + rect.w - min;
    w = min;
  }
  if (h < min) {
    if (spec.y) y = rect.y + rect.h - min;
    h = min;
  }
  return { x, y, w, h };
}

// Keeps an element reachable: it may hang off the slide (bleed is legitimate)
// but never so far that no part of it can be clicked.
export function clampToSlide(rect, deckW, deckH, keep = MIN_SIZE * 2) {
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, keep - rect.w), deckW - keep),
    y: Math.min(Math.max(rect.y, keep - rect.h), deckH - keep),
  };
}

// ── rotation ─────────────────────────────────────────────────────────────────
// Elements rotate about their centre (`transform-origin: center center`), which
// is what makes rotation feel like turning the object rather than swinging it
// around a corner. Everything below is the consequence of that choice.

export const ROTATION_SNAP_DEG = 15;

const toRad = deg => (deg * Math.PI) / 180;

/** Rotates (x, y) about the origin by `deg`. */
export function rotatePoint(x, y, deg) {
  if (!deg) return { x, y };
  const a = toRad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

export function centerOf(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Normalizes any angle into [0, 360). */
export function normalizeAngle(deg) {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * The angle, in degrees, from a rect's centre to a point — measured so that a
 * point directly above the centre is 0, matching the rotation handle's rest
 * position. `snap` rounds to ROTATION_SNAP_DEG.
 */
export function angleToPoint(rect, px, py, { snap = false } = {}) {
  const c = centerOf(rect);
  const deg = (Math.atan2(py - c.y, px - c.x) * 180) / Math.PI + 90;
  const normalized = normalizeAngle(deg);
  if (!snap) return normalized;
  return normalizeAngle(Math.round(normalized / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG);
}

/**
 * Resizes a rotated rect from one handle, given a pointer delta in world (deck)
 * coordinates.
 *
 * Two corrections are needed and neither is optional:
 *
 *   1. The handle drags along the element's *local* axes, so the world delta is
 *      rotated by -rotation before `resizeRect` sees it. Without this, dragging
 *      the east handle of a 45-degree box widens it diagonally on screen.
 *   2. `resizeRect` anchors the opposite corner in local, axis-aligned space —
 *      but the element rotates about its centre, and resizing moves that
 *      centre. The anchor therefore swings away from where the user grabbed it.
 *      Shifting the result by `u - R(u)`, where `u` is how far the centre moved,
 *      pins the anchor back to its original world position.
 */
export function resizeRotatedRect(rect, handle, dx, dy, rotation = 0, options = {}) {
  if (!rotation) return resizeRect(rect, handle, dx, dy, options);

  const local = rotatePoint(dx, dy, -rotation);
  const resized = resizeRect(rect, handle, local.x, local.y, options);

  const before = centerOf(rect);
  const after = centerOf(resized);
  const u = { x: before.x - after.x, y: before.y - after.y };
  const ru = rotatePoint(u.x, u.y, rotation);
  return {
    ...resized,
    x: resized.x + u.x - ru.x,
    y: resized.y + u.y - ru.y,
  };
}

/** The world position of a rect's corner, honouring rotation about the centre. */
export function cornerAt(rect, corner, rotation = 0) {
  const c = centerOf(rect);
  const sx = corner === 'nw' || corner === 'sw' ? -1 : 1;
  const sy = corner === 'nw' || corner === 'ne' ? -1 : 1;
  const local = { x: (sx * rect.w) / 2, y: (sy * rect.h) / 2 };
  const r = rotatePoint(local.x, local.y, rotation);
  return { x: c.x + r.x, y: c.y + r.y };
}

export function rectsIntersect(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

// Hit-testing for a marquee selection: topmost first, matching paint order.
export function elementsInRect(slide, rect) {
  return slide.elements.filter(el => rectsIntersect(rectOf(el), rect)).map(el => el.id);
}

export function round(rect, precision = 1) {
  const r = value => Math.round(value / precision) * precision;
  return { x: r(rect.x), y: r(rect.y), w: r(rect.w), h: r(rect.h) };
}

// ── polygon inset ────────────────────────────────────────────────────────────
// A border has to sit *inside* the element box, because that is what CSS gives
// a rectangle (`box-sizing: border-box`) and what the ellipse renderer already
// does by shrinking its radii. An SVG stroke is centred on the path instead, so
// half of it would spill outside the box and be clipped by the viewBox. Moving
// the path inwards by half the stroke width puts the outer edge back on the
// original outline, and every surface that draws a polygon does it through
// here so the canvas, the thumbnails and the exports cannot disagree.

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function centroidOf(points) {
  const sum = points.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

/**
 * Moves every edge of a convex polygon `distance` units towards the interior.
 *
 * `points` is an array of `[x, y]` pairs in any winding order. The inward
 * direction is taken per edge as the one pointing at the centroid, which is
 * correct for the convex shapes the deck draws and needs no orientation
 * bookkeeping from the caller.
 *
 * A distance larger than the shape can absorb would turn the polygon inside
 * out; that collapses to the centroid instead, which renders as a solid patch
 * of the border colour — the right answer for a border thicker than its shape.
 */
export function insetPolygon(points, distance) {
  const n = points.length;
  if (n < 3 || !(distance > 0)) return points;
  const centroid = centroidOf(points);

  // Each edge becomes an offset line, stored as a point plus a direction.
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (!len) return points;
    const dx = (x2 - x1) / len;
    const dy = (y2 - y1) / len;
    let nx = -dy;
    let ny = dx;
    const midToCentroid = [centroid[0] - (x1 + x2) / 2, centroid[1] - (y1 + y2) / 2];
    if (nx * midToCentroid[0] + ny * midToCentroid[1] < 0) { nx = -nx; ny = -ny; }
    lines.push({ px: x1 + nx * distance, py: y1 + ny * distance, dx, dy });
  }

  // Vertex i is where the offset lines of edges i-1 and i meet.
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = lines[(i - 1 + n) % n];
    const b = lines[i];
    const denom = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(denom) < 1e-9) {
      // Collinear edges: no corner to find, so keep the offset point itself.
      out.push([b.px, b.py]);
      continue;
    }
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / denom;
    out.push([a.px + a.dx * t, a.py + a.dy * t]);
  }

  // A distance the shape cannot absorb does not fold the polygon flat: the
  // offset lines still meet, in a shape reflected through the interior that is
  // both inside the original and wound the same way, so neither a signed-area
  // test nor a containment test notices. What does is that every edge has
  // turned around — the inset ran past the far side and came back.
  const valid = out.every(([x1, y1], i) => {
    const [x2, y2] = out[(i + 1) % n];
    return (x2 - x1) * lines[i].dx + (y2 - y1) * lines[i].dy > 1e-9;
  });
  if (!valid) return points.map(() => centroid.slice());
  return out;
}

/**
 * The outline of a triangle inscribed in an element box, apex centred at the
 * top. Shared by every renderer, and by `insetPolygon` when it has a border.
 */
export function trianglePoints({ w, h }) {
  return [[w / 2, 0], [w, h], [0, h]];
}

/** A polygon as an SVG `points` attribute. */
export function polygonPoints(points) {
  return points.map(([x, y]) => `${round1(x)},${round1(y)}`).join(' ');
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
