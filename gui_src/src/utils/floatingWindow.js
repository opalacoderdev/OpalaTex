// Geometry for the floating plan-review window.
//
// The plan used to be a `ConfirmModal` over a full-screen backdrop, which held
// the decision and the workbench hostage together: only the *agent* has to wait
// for an answer, but the backdrop also stopped the user from opening the files
// the plan talks about in order to give one. The window that replaced it floats
// over a live IDE, and that is only safe while it cannot be put somewhere the
// user can no longer reach — a dialog nobody can answer would leave the agent
// waiting forever with no way out. The rules that guarantee that live here, as
// pure functions, because they are the part worth testing without a browser.
//
// All values are app CSS pixels, not viewport pixels. The app renders inside a
// CSS `zoom` (see utils/uiScale.js), so callers must convert pointer deltas and
// `window.innerWidth`/`innerHeight` before handing them over.

export const PLAN_WINDOW_MIN_WIDTH = 320;
export const PLAN_WINDOW_MIN_HEIGHT = 220;

// What the window shrinks to when collapsed: its title bar. The vertical clamp
// uses this instead of the stored height, so a collapsed window is pinned by
// the strip the user actually sees rather than by the body hidden behind it —
// otherwise collapsing a window docked at the bottom would leave its title bar
// stranded above a screenful of nothing.
export const PLAN_WINDOW_HEADER_HEIGHT = 44;

// Slack kept between the window and the viewport edge at maximum size, so a
// window sized to fill the screen still shows that there is an IDE behind it.
const MARGIN = 16;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Confine a coordinate to the span where the window is fully on screen.
 *
 * When the window fits, that span is `[0, viewport - size]` and the window can
 * never be dragged even partly out of view. When it does not fit — a viewport
 * narrower than the minimum width — the span inverts, and the clamp then keeps
 * the overflowing window pinned across the whole viewport instead of letting it
 * drift off one side.
 */
const confine = (value, size, viewportSize) =>
  clamp(value, Math.min(0, viewportSize - size), Math.max(0, viewportSize - size));

/**
 * The rectangle a first-time window opens at: docked to the right, clear of the
 * top and bottom edges. The right side is chosen deliberately — the chat the
 * plan came from sits there in most layouts, so the window appears next to the
 * conversation it answers rather than over the editor the user is about to
 * consult in order to answer it.
 */
export const defaultPlanWindowRect = (viewport) => {
  const width = clamp(520, PLAN_WINDOW_MIN_WIDTH, Math.max(PLAN_WINDOW_MIN_WIDTH, viewport.width - MARGIN));
  const height = clamp(
    Math.round(viewport.height * 0.62),
    PLAN_WINDOW_MIN_HEIGHT,
    Math.max(PLAN_WINDOW_MIN_HEIGHT, viewport.height - MARGIN)
  );
  return clampPlanWindowRect(
    { x: viewport.width - width - MARGIN, y: Math.round((viewport.height - height) / 2), width, height },
    viewport
  );
};

/**
 * Force a rectangle back into something usable: a size no smaller than the
 * minimum and no larger than the viewport, at a position that keeps the whole
 * window on screen. Applied to every move, every resize, every viewport change
 * and every value restored from storage, so there is no path by which the
 * window ends up unreachable.
 *
 * `collapsed` clamps vertically against the title bar's height, because that is
 * all the window occupies while collapsed.
 */
export const clampPlanWindowRect = (rect, viewport, { collapsed = false } = {}) => {
  const width = clamp(
    rect.width,
    PLAN_WINDOW_MIN_WIDTH,
    Math.max(PLAN_WINDOW_MIN_WIDTH, viewport.width - MARGIN)
  );
  const height = clamp(
    rect.height,
    PLAN_WINDOW_MIN_HEIGHT,
    Math.max(PLAN_WINDOW_MIN_HEIGHT, viewport.height - MARGIN)
  );

  return {
    x: confine(rect.x, width, viewport.width),
    y: confine(rect.y, collapsed ? PLAN_WINDOW_HEADER_HEIGHT : height, viewport.height),
    width,
    height,
  };
};

/** Move by a pointer delta, clamped. */
export const movePlanWindowRect = (rect, dx, dy, viewport, options) =>
  clampPlanWindowRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewport, options);

/** Resize from the bottom-right corner by a pointer delta, clamped. */
export const resizePlanWindowRect = (rect, dx, dy, viewport) =>
  clampPlanWindowRect({ ...rect, width: rect.width + dx, height: rect.height + dy }, viewport);

/**
 * Restore a persisted rectangle. Anything that is not four finite numbers is
 * rejected, so a corrupted or hand-edited storage entry falls back to the
 * default placement instead of rendering the window at NaN — which paints
 * nothing at all, and would look exactly like a plan request that never came.
 */
export const parsePlanWindowRect = (raw) => {
  if (!raw) return null;
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { x, y, width, height } = parsed;
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  return { x, y, width, height };
};
