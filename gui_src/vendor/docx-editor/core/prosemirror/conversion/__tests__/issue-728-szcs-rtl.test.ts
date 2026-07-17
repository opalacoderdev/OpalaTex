/**
 * Regression test for #728 & #727 — Hebrew/RTL text ignores complex-script font size (w:szCs) & family (w:cs).
 */
import { describe, test, expect } from 'bun:test';
import { textFormattingToMarks } from '../toProseDoc/marks';
import { marksToTextFormatting } from '../fromProseDoc/marks';
import type { TextFormatting } from '../../../types/document';

describe('Issue #728 & #727 — Hebrew/RTL text complex script styling and round-trip preservation', () => {
  test('round-trip preserves both fontSize and fontSizeCs separately without data loss', () => {
    const original: TextFormatting = {
      fontSize: 24,
      fontSizeCs: 36,
    };
    const marks = textFormattingToMarks(original);
    const roundTripped = marksToTextFormatting(marks);
    expect(roundTripped.fontSize).toBe(24);
    expect(roundTripped.fontSizeCs).toBe(36);
  });

  test('round-trip preserves fontFamily attributes separately without data loss', () => {
    const original: TextFormatting = {
      fontFamily: {
        ascii: 'Arial',
        hAnsi: 'Arial',
        cs: 'David',
      },
    };
    const marks = textFormattingToMarks(original);
    const roundTripped = marksToTextFormatting(marks);
    expect(roundTripped.fontFamily?.ascii).toBe('Arial');
    expect(roundTripped.fontFamily?.cs).toBe('David');
  });

  test('round-trip preserves sizeCs only when size is absent', () => {
    const original: TextFormatting = {
      fontSizeCs: 36,
    };
    const marks = textFormattingToMarks(original);
    const roundTripped = marksToTextFormatting(marks);
    expect(roundTripped.fontSize).toBeUndefined();
    expect(roundTripped.fontSizeCs).toBe(36);
  });
});
