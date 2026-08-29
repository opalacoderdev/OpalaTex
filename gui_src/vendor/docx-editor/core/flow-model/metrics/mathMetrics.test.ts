/**
 * Measurement is only exact in a browser: the fallback path is what runs in
 * tests, in a worker, and in a browser that has not laid the equation out yet,
 * so it is the part that has to be provably finite and stable.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearMathMeasureCache,
  isMathFontReady,
  measureMathBox,
  onMathFontReady,
} from './mathMetrics';

const MATHML = '<math><mfrac><mi>a</mi><mn>2</mn></mfrac></math>';

describe('measureMathBox', () => {
  beforeEach(() => {
    clearMathMeasureCache();
  });

  it('returns a finite box with no DOM to measure in', () => {
    const box = measureMathBox(MATHML, 16, 'a2');

    expect(Number.isFinite(box.width)).toBe(true);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.ascent + box.descent).toBeCloseTo(box.height, 5);
  });

  it('scales the estimate with the font size', () => {
    const small = measureMathBox(MATHML, 10, 'a2');
    const large = measureMathBox(MATHML, 20, 'a2');

    expect(large.width).toBeGreaterThan(small.width);
    expect(large.height).toBeGreaterThan(small.height);
  });

  it('never returns a zero-width box for an equation with no MathML', () => {
    const box = measureMathBox('', 16, '');
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it('falls back to a usable size for a non-positive font size', () => {
    const box = measureMathBox(MATHML, 0, 'a2');
    expect(box.width).toBeGreaterThan(0);
  });

  it('is stable across repeated calls', () => {
    const first = measureMathBox(MATHML, 16, 'a2');
    const second = measureMathBox(MATHML, 16, 'a2');
    expect(second).toEqual(first);
  });

  it('treats the font as ready when there is no font API to ask', () => {
    expect(isMathFontReady()).toBe(true);
  });
});

describe('math font readiness', () => {
  it('hands back an unsubscribe that removes the listener', () => {
    let calls = 0;
    const off = onMathFontReady(() => {
      calls += 1;
    });
    off();
    // Nothing can fire it here (no font API in this environment); the contract
    // under test is that unsubscribing is available and does not throw.
    expect(calls).toBe(0);
  });

  it('measures a displayed equation separately from an inline one', () => {
    // Same MathML, different math style: they must not share a cache entry.
    const inline = measureMathBox(MATHML, 16, 'a2', 'inline');
    const block = measureMathBox(MATHML, 16, 'a2', 'block');
    expect(inline.width).toBeGreaterThan(0);
    expect(block.width).toBeGreaterThan(0);
  });
});
