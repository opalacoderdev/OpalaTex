import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { styleBorder } from '../renderTableBorders';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('styleBorder', () => {
  test('uses at least 3px for double borders so both strokes render', () => {
    const el = document.createElement('div');

    styleBorder(el, 'top', { width: 1, style: 'double', color: '#2E75B6' });

    expect(el.style.borderTop).toBe('3px double #2E75B6');
  });

  test('keeps non-double border widths unchanged', () => {
    const el = document.createElement('div');

    styleBorder(el, 'right', { width: 1, style: 'dashed', color: '#CC3333' });

    expect(el.style.borderRight).toBe('1px dashed #CC3333');
  });
});
