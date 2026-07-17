import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { convertBorderSpecToLayout } from '../flow-model/buildBoxTree/borders';
import { makeTableBodyClip, styleBorder } from './renderTableBorders';

describe('styleBorder', () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  test('maps OOXML single borders to valid CSS solid borders', () => {
    const element = document.createElement('div');
    const border = convertBorderSpecToLayout({
      style: 'single',
      size: 4,
      color: { rgb: '000000' },
    });

    styleBorder(element, 'top', border);

    expect(element.style.borderTopStyle).toBe('solid');
    expect(Number.parseFloat(element.style.borderTopWidth)).toBeCloseTo(2 / 3, 5);
    expect(element.style.borderTopColor).toBe('#000000');
  });

  test('preserves CSS-compatible OOXML border kinds', () => {
    const element = document.createElement('div');

    styleBorder(element, 'left', {
      style: 'double',
      width: 3,
      color: '#123456',
    });

    expect(element.style.borderLeftStyle).toBe('double');
    expect(element.style.borderLeftWidth).toBe('3px');
    expect(element.style.borderLeftColor).toBe('#123456');
  });

  test('marks the repeated-header body clipping window for selection geometry', () => {
    const table = document.createElement('div');

    const { bodyParent, bodyOriginY } = makeTableBodyClip(table, 24, 100, 300, document);

    expect(bodyParent.dataset.tableBodyClip).toBe('true');
    expect(bodyParent.style.top).toBe('24px');
    expect(bodyParent.style.height).toBe('76px');
    expect(bodyOriginY).toBe(24);
    expect(table.firstElementChild).toBe(bodyParent);
  });
});
