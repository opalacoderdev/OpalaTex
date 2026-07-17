import { describe, expect, test } from 'bun:test';
import { resolveColorValueToHex } from '../drawingUtils';

describe('DrawingML default theme colors', () => {
  test('uses the canonical Office 2016 palette', () => {
    expect(resolveColorValueToHex({ themeColor: 'accent1' })).toBe('#4472C4');
    expect(resolveColorValueToHex({ themeColor: 'accent5' })).toBe('#5B9BD5');
    expect(resolveColorValueToHex({ themeColor: 'dk2' })).toBe('#44546A');
    expect(resolveColorValueToHex({ themeColor: 'lt2' })).toBe('#E7E6E6');
  });

  test('maps DrawingML text and background aliases to canonical slots', () => {
    expect(resolveColorValueToHex({ themeColor: 'text1' })).toBe('#000000');
    expect(resolveColorValueToHex({ themeColor: 'text2' })).toBe('#44546A');
    expect(resolveColorValueToHex({ themeColor: 'background1' })).toBe('#FFFFFF');
    expect(resolveColorValueToHex({ themeColor: 'background2' })).toBe('#E7E6E6');
  });
});
