/**
 * Regression: markUtils DTF ↔ marks conversion must not drop underline
 * color, doubleStrike, eastAsian/cs fonts, or theme font attrs — those were
 * wiped when EmptyParagraphFormat / saveStoredMarksToParagraph rewrote
 * defaultTextFormatting through the lossy converters.
 */

import { describe, test, expect } from 'bun:test';
import { singletonManager } from '../../../schema';
import {
  marksToTextFormatting,
  textFormattingToMarks,
  defaultTextFormattingFromMarks,
} from '../markUtils';
import type { TextFormatting } from '../../../../types/document';

const schema = singletonManager.getSchema();

const richFormatting: TextFormatting = {
  underline: { style: 'wave', color: { rgb: '112233', themeColor: 'accent1' } },
  doubleStrike: true,
  fontFamily: {
    ascii: 'Calibri',
    hAnsi: 'Calibri',
    eastAsia: 'MS Gothic',
    cs: 'Arial',
    asciiTheme: 'minorAscii',
    hAnsiTheme: 'minorHAnsi',
    eastAsiaTheme: 'minorEastAsia',
    csTheme: 'minorBidi',
  },
  fontSize: 22,
  smallCaps: true,
  emboss: true,
};

describe('markUtils empty-para DTF round-trip', () => {
  test('marksToTextFormatting keeps underline color, doubleStrike, EA/CS/theme fonts', () => {
    const marks = textFormattingToMarks(richFormatting, schema);
    const back = marksToTextFormatting(marks);

    expect(back.underline).toEqual({
      style: 'wave',
      color: { rgb: '112233', themeColor: 'accent1' },
    });
    expect(back.doubleStrike).toBe(true);
    expect(back.strike).toBeUndefined();
    expect(back.fontFamily).toMatchObject({
      ascii: 'Calibri',
      hAnsi: 'Calibri',
      eastAsia: 'MS Gothic',
      cs: 'Arial',
      asciiTheme: 'minorAscii',
      hAnsiTheme: 'minorHAnsi',
      eastAsiaTheme: 'minorEastAsia',
      csTheme: 'minorBidi',
    });
    // DOCX-only fields are not mark-backed — not expected on pure mark→DTF.
    expect(back.smallCaps).toBeUndefined();
  });

  test('defaultTextFormattingFromMarks merges mark patch onto existing DTF', () => {
    const next = defaultTextFormattingFromMarks(richFormatting, [
      schema.marks.bold.create(),
      ...textFormattingToMarks(richFormatting, schema),
    ]);

    expect(next?.bold).toBe(true);
    expect(next?.underline).toEqual(richFormatting.underline);
    expect(next?.doubleStrike).toBe(true);
    expect(next?.fontFamily).toMatchObject(richFormatting.fontFamily!);
    expect(next?.smallCaps).toBe(true);
    expect(next?.emboss).toBe(true);
  });

  test('defaultTextFormattingFromMarks preserves DOCX-only fields when marks are partial', () => {
    const next = defaultTextFormattingFromMarks(richFormatting, [schema.marks.italic.create()]);

    expect(next?.italic).toBe(true);
    expect(next?.bold).toBeUndefined();
    expect(next?.underline).toBeUndefined(); // mark-backed, absent from marks → cleared
    expect(next?.smallCaps).toBe(true); // not mark-backed → kept
    expect(next?.emboss).toBe(true);
    expect(next?.fontFamily).toBeUndefined();
  });
});
