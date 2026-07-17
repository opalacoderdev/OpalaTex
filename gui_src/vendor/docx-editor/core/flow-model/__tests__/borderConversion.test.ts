import { describe, expect, it } from 'bun:test';
import { convertBorderSpecToLayout } from '../buildBoxTree/borders';

describe('OOXML border conversion', () => {
  it('preserves hairline border widths for layout geometry', () => {
    const border = convertBorderSpecToLayout({
      style: 'single',
      size: 1,
      color: { rgb: '999999' },
    });

    expect(border?.width).toBeCloseTo(1 / 6, 5);
    expect(border?.style).toBe('solid');
  });

  it('keeps a visible default when OOXML omits border size', () => {
    const border = convertBorderSpecToLayout({
      style: 'single',
      color: { rgb: '999999' },
    });

    expect(border?.width).toBe(1);
  });
});
