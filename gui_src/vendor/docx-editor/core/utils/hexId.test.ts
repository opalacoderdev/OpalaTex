import { describe, test, expect } from 'bun:test';
import { generateHexId, isValidLongHexId, MAX_HEX_ID_EXCLUSIVE, normalizeLongHexId } from './hexId';

describe('MAX_HEX_ID_EXCLUSIVE', () => {
  test('matches the strictest ST_LongHexNumber cap (durableId)', () => {
    // Pins the constant so a future "let's bump it back to 0x80000000"
    // diff is caught at review time. The value is the spec cap for
    // w16cid:commentId/@durableId, which is the tightest of every
    // field generateHexId feeds.
    expect(MAX_HEX_ID_EXCLUSIVE).toBe(0x7fffffff);
  });
});

describe('generateHexId', () => {
  test('always produces 8 uppercase hex characters', () => {
    for (let i = 0; i < 1000; i += 1) {
      const id = generateHexId();
      expect(id).toMatch(/^[0-9A-F]{8}$/);
    }
  });

  // OOXML ST_LongHexNumber (w14:paraId / w14:textId) caps values at
  // < 0x80000000. Word silently recovers any over-cap paraId/textId on
  // open and surfaces it as a "Document Recovery — Table Properties"
  // dialog, so values >= 0x80000000 are spec-invalid even though they
  // fit in 8 hex chars.
  test('never produces a value >= 0x80000000 (ST_LongHexNumber cap)', () => {
    const TRIALS = 20_000;
    for (let i = 0; i < TRIALS; i += 1) {
      const id = generateHexId();
      const value = parseInt(id, 16);
      expect(value).toBeLessThan(0x80000000);
    }
  });

  test('covers the full valid range up to (but not including) the cap', () => {
    // With 20,000 trials, a uniform generator should readily reach the
    // upper half of the accepted 31-bit range.
    let sawUpperHalf = false;
    for (let i = 0; i < 20_000 && !sawUpperHalf; i += 1) {
      const value = parseInt(generateHexId(), 16);
      if (value >= 0x40000000 && value < 0x7fffffff) sawUpperHalf = true;
    }
    expect(sawUpperHalf).toBe(true);
  });

  // Comment durable IDs exclude the single all-ones 31-bit value. Pin the
  // byte generator's worst input so every shared call site remains valid.
  test('worst-case random bytes stay under the durableId cap (< 0x7FFFFFFF)', () => {
    const original = Math.random;
    Math.random = () => 1 - Number.EPSILON;
    try {
      const value = parseInt(generateHexId(), 16);
      expect(value).toBeLessThan(0x7fffffff);
    } finally {
      Math.random = original;
    }
  });
});

describe('isValidLongHexId', () => {
  test('accepts 8-hex ids below the cap, rejects malformed or over-cap ids', () => {
    expect(isValidLongHexId('0000ABCD')).toBe(true);
    expect(isValidLongHexId('7FFFFFFE')).toBe(true);
    expect(isValidLongHexId('7FFFFFFF')).toBe(false); // == cap
    expect(isValidLongHexId('F2345678')).toBe(false); // > cap
    expect(isValidLongHexId('ABC')).toBe(false); // too short
    expect(isValidLongHexId('GHIJKLMN')).toBe(false); // non-hex
    expect(isValidLongHexId(undefined)).toBe(false);
  });
});

describe('normalizeLongHexId', () => {
  test('passes valid ids through unchanged', () => {
    expect(normalizeLongHexId('0000ABCD')).toBe('0000ABCD');
    expect(normalizeLongHexId('7FFFFFFE')).toBe('7FFFFFFE');
  });

  test('maps undefined to undefined', () => {
    expect(normalizeLongHexId(undefined)).toBeUndefined();
  });

  test('replaces out-of-range/malformed ids with a freshly valid id', () => {
    for (const bad of ['F2345678', '80000000', 'XYZ', '123']) {
      const out = normalizeLongHexId(bad);
      expect(out).not.toBe(bad);
      expect(isValidLongHexId(out)).toBe(true);
    }
  });
});
