import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_PRESETS,
  UI_SCALE_STEP,
  clampUiScale,
  presetForScale,
  roundUiScale,
} from '../uiScale.js';

test('clamps a scale into the supported range', () => {
  assert.equal(clampUiScale(5), UI_SCALE_MAX);
  assert.equal(clampUiScale(0.1), UI_SCALE_MIN);
  assert.equal(clampUiScale(1.25), 1.25);
});

test('falls back to the default rather than shrinking on an unusable value', () => {
  // A corrupted or missing setting must not leave the interface unreadable.
  for (const value of ['not a number', NaN, Infinity, -Infinity, undefined, null, '']) {
    assert.equal(clampUiScale(value), UI_SCALE_DEFAULT, `for ${String(value)}`);
  }
});

test('an explicit zero is a number, and clamps rather than defaulting', () => {
  assert.equal(clampUiScale(0), UI_SCALE_MIN);
});

test('rounds to the fine-tuning step without float drift', () => {
  // 24 * 0.05 is 1.2000000000000002 in IEEE 754; the stored value must be 1.2.
  assert.equal(roundUiScale(1.2000000000000002), 1.2);
  assert.equal(roundUiScale(1.37), 1.35);
  assert.equal(roundUiScale(1.38), 1.4);
});

test('every preset survives a round-trip through rounding', () => {
  for (const preset of UI_SCALE_PRESETS) {
    assert.equal(roundUiScale(preset.scale), preset.scale, preset.id);
    assert.equal(presetForScale(preset.scale)?.id, preset.id);
  }
});

test('presets sit inside the supported range and Medium is unscaled', () => {
  assert.equal(presetForScale(UI_SCALE_DEFAULT)?.id, 'medium');
  for (const preset of UI_SCALE_PRESETS) {
    assert.ok(preset.scale >= UI_SCALE_MIN && preset.scale <= UI_SCALE_MAX, preset.id);
  }
});

test('a value between steps matches no preset', () => {
  assert.equal(presetForScale(1.1), null);
  assert.equal(presetForScale(UI_SCALE_DEFAULT + UI_SCALE_STEP), null);
});

test('presets are ordered and distinct', () => {
  const scales = UI_SCALE_PRESETS.map((p) => p.scale);
  assert.deepEqual(scales, [...scales].sort((a, b) => a - b));
  assert.equal(new Set(scales).size, scales.length);
});
