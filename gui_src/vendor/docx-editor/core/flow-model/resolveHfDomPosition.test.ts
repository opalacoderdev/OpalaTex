import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { resolveHfDomPosition } from './resolveDomPosition';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

describe('resolveHfDomPosition', () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  test('maps only spans inside the exact header/footer host', () => {
    const host = document.createElement('div');
    host.className = 'layout-page-header';
    const span = document.createElement('span');
    span.dataset.docFrom = '4';
    span.dataset.docTo = '9';
    span.textContent = 'Hello';
    span.getBoundingClientRect = () => rect(100, 20, 50, 16);
    host.appendChild(span);
    document.body.appendChild(host);

    expect(resolveHfDomPosition(host, 90, 28)).toBe(4);
    expect(resolveHfDomPosition(host, 160, 28)).toBe(9);
  });

  test('rejects body containers and unrelated position spaces', () => {
    const body = document.createElement('div');
    body.className = 'layout-page-content';
    const span = document.createElement('span');
    span.dataset.docFrom = '1';
    span.dataset.docTo = '2';
    body.appendChild(span);

    expect(resolveHfDomPosition(body, 0, 0)).toBeNull();
  });
});
