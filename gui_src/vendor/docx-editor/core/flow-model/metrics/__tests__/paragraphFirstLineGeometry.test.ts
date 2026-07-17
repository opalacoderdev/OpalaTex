import { describe, expect, test } from 'bun:test';
import { resolveParagraphFirstLineGeometry } from '../paragraphFirstLineGeometry';

describe('paragraph first-line geometry', () => {
  test('reserves a hanging marker slot from the expanded first-line box', () => {
    const geometry = resolveParagraphFirstLineGeometry(
      713,
      { left: 96, right: 24, hanging: 48 },
      48
    );

    expect(geometry.markerStart).toBe(48);
    expect(geometry.inlineWidth).toBe(641);
    expect(geometry.painterLineWidth).toBe(641);
    expect(geometry.markerInlineWidth).toBe(48);
    expect(geometry.textStart).toBe(96);
    expect(geometry.textWidth).toBe(593);
    expect(geometry.bodyWidth).toBe(593);
  });

  test('keeps marker width explicit when it differs from the hanging indent', () => {
    const geometry = resolveParagraphFirstLineGeometry(
      500,
      { left: 80, right: 20, hanging: 30 },
      42
    );

    expect(geometry.markerStart).toBe(50);
    expect(geometry.inlineWidth).toBe(430);
    expect(geometry.painterLineWidth).toBe(430);
    expect(geometry.textStart).toBe(92);
    expect(geometry.textWidth).toBe(388);
  });

  test('handles first-line indentation with and without a marker', () => {
    const withoutMarker = resolveParagraphFirstLineGeometry(
      500,
      { left: 40, right: 20, firstLine: 24 },
      0
    );
    const withMarker = resolveParagraphFirstLineGeometry(
      500,
      { left: 40, right: 20, firstLine: 24 },
      36
    );

    expect(withoutMarker.textStart).toBe(64);
    expect(withoutMarker.textWidth).toBe(416);
    expect(withoutMarker.painterLineWidth).toBe(440);
    expect(withMarker.markerStart).toBe(64);
    expect(withMarker.inlineWidth).toBe(416);
    expect(withMarker.painterLineWidth).toBe(416);
    expect(withMarker.textWidth).toBe(380);
  });

  test('handles a hanging indent larger than left and the zero-left marker convention', () => {
    const inMargin = resolveParagraphFirstLineGeometry(
      400,
      { left: 15, right: 10, hanging: 38 },
      38
    );
    const zeroLeft = resolveParagraphFirstLineGeometry(
      400,
      { left: 0, right: 10, hanging: 24 },
      24
    );
    const noMarker = resolveParagraphFirstLineGeometry(
      400,
      { left: 15, right: 10, hanging: 38 },
      0
    );

    expect(inMargin.markerStart).toBe(-23);
    expect(inMargin.textStart).toBe(15);
    expect(inMargin.textWidth).toBe(375);
    expect(inMargin.inlineWidth).toBe(390);
    expect(inMargin.painterLineWidth).toBe(390);
    expect(zeroLeft.markerStart).toBe(0);
    expect(zeroLeft.textStart).toBe(24);
    expect(zeroLeft.textWidth).toBe(366);
    expect(noMarker.textStart).toBe(-23);
    expect(noMarker.textWidth).toBe(413);
    expect(noMarker.painterLineWidth).toBe(375);
  });
});
