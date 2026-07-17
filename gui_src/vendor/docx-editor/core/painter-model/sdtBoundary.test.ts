import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { isPointInsideSdtBoundary } from './sdtBoundary';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('SDT boundary hover reveal', () => {
  test('stays active while the pointer targets a descendant above the boundary', () => {
    const box = document.createElement('div');
    const button = document.createElement('button');
    box.appendChild(button);
    box.getBoundingClientRect = () =>
      ({
        left: 10,
        right: 110,
        top: 30,
        bottom: 130,
        width: 100,
        height: 100,
        x: 10,
        y: 30,
        toJSON: () => ({}),
      }) as DOMRect;

    expect(isPointInsideSdtBoundary(box, button, 20, 20)).toBe(true);
    expect(isPointInsideSdtBoundary(box, document.body, 20, 20)).toBe(false);
  });
});
