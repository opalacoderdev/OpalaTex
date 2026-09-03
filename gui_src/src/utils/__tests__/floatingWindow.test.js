import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_WINDOW_HEADER_HEIGHT,
  PLAN_WINDOW_MIN_HEIGHT,
  PLAN_WINDOW_MIN_WIDTH,
  clampPlanWindowRect,
  defaultPlanWindowRect,
  movePlanWindowRect,
  parsePlanWindowRect,
  resizePlanWindowRect,
} from '../floatingWindow.js';

const VIEWPORT = { width: 1600, height: 900 };

const fits = (rect, viewport) =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.width <= viewport.width &&
  rect.y + rect.height <= viewport.height;

test('the default placement is fully on screen and docked to the right', () => {
  const rect = defaultPlanWindowRect(VIEWPORT);
  assert.ok(fits(rect, VIEWPORT), `${JSON.stringify(rect)} escapes the viewport`);
  // Nearer the right edge than the left: the chat it answers is over there.
  assert.ok(rect.x > VIEWPORT.width / 2);
});

test('a window can never be dragged off screen', () => {
  const rect = defaultPlanWindowRect(VIEWPORT);
  for (const [dx, dy] of [[-9999, -9999], [9999, 9999], [9999, -9999], [-9999, 9999]]) {
    const moved = movePlanWindowRect(rect, dx, dy, VIEWPORT);
    assert.ok(fits(moved, VIEWPORT), `dragging by ${dx},${dy} escaped: ${JSON.stringify(moved)}`);
  }
});

test('a collapsed window is pinned by its title bar, not by its stored height', () => {
  const rect = { x: 100, y: 0, width: 520, height: 600 };
  // Dragged to the bottom while collapsed: the title bar may sit below the point
  // where the expanded body would have to start, because the body is not drawn.
  const collapsed = movePlanWindowRect(rect, 0, 9999, VIEWPORT, { collapsed: true });
  assert.equal(collapsed.y, VIEWPORT.height - PLAN_WINDOW_HEADER_HEIGHT);
  // The stored height survives the collapse, so expanding restores the size.
  assert.equal(collapsed.height, 600);
  // Expanded, the same drag stops where the whole body still fits.
  const expanded = movePlanWindowRect(rect, 0, 9999, VIEWPORT);
  assert.equal(expanded.y, VIEWPORT.height - 600);
});

test('resizing respects the minimum size and the viewport', () => {
  const rect = { x: 0, y: 0, width: 520, height: 400 };
  const shrunk = resizePlanWindowRect(rect, -9999, -9999, VIEWPORT);
  assert.equal(shrunk.width, PLAN_WINDOW_MIN_WIDTH);
  assert.equal(shrunk.height, PLAN_WINDOW_MIN_HEIGHT);

  const grown = resizePlanWindowRect(rect, 9999, 9999, VIEWPORT);
  assert.ok(grown.width < VIEWPORT.width, 'a maximised window still shows the IDE behind it');
  assert.ok(grown.height < VIEWPORT.height);
  assert.ok(fits(grown, VIEWPORT));
});

test('a viewport smaller than the minimum size still leaves the window reachable', () => {
  // Not a hypothetical: the app is rendered inside a CSS zoom, so a 200% UI
  // scale on a small laptop shrinks the app viewport below the minimum width.
  const tiny = { width: 240, height: 180 };
  const rect = clampPlanWindowRect({ x: 5000, y: 5000, width: 520, height: 600 }, tiny);
  assert.equal(rect.width, PLAN_WINDOW_MIN_WIDTH);
  assert.equal(rect.height, PLAN_WINDOW_MIN_HEIGHT);
  // It cannot fit, so it covers the viewport rather than drifting off one side.
  assert.ok(rect.x <= 0 && rect.x + rect.width >= tiny.width);
  assert.ok(rect.y <= 0 && rect.y + rect.height >= tiny.height);
});

test('shrinking the viewport pulls an off-screen window back in', () => {
  const rect = { x: 1200, y: 700, width: 520, height: 400 };
  const pulled = clampPlanWindowRect(rect, { width: 900, height: 700 });
  assert.ok(fits(pulled, { width: 900, height: 700 }), JSON.stringify(pulled));
});

test('a stored rectangle round-trips, and anything else is rejected', () => {
  const rect = { x: 10, y: 20, width: 520, height: 400 };
  assert.deepEqual(parsePlanWindowRect(JSON.stringify(rect)), rect);
  assert.deepEqual(parsePlanWindowRect(rect), rect);

  for (const bad of [null, undefined, '', 'not json', '[]', '{}', '{"x":1}', '{"x":null,"y":0,"width":1,"height":1}', JSON.stringify({ x: 'a', y: 0, width: 1, height: 1 })]) {
    assert.equal(parsePlanWindowRect(bad), null, `accepted ${String(bad)}`);
  }
});
