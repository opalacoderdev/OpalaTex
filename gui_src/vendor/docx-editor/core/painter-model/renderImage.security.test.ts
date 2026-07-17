import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ImageBlock, ImageFragment, ImageMetrics } from '../pagination-model/types';
import { paintFloatingImagesLayer } from './floatingImageLayer';
import type { RenderContext } from './paintPage';
import { paintImageFragment } from './renderImage';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('paintImageFragment source safety', () => {
  test('does not create a fetching src attribute for remote images', () => {
    const fragment: ImageFragment = {
      kind: 'image',
      nodeId: 'image-1',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    };
    const block: ImageBlock = {
      kind: 'image',
      id: 'image-1',
      src: 'https://tracker.test/pixel.png',
      width: 100,
      height: 50,
    };
    const measure: ImageMetrics = { kind: 'image', width: 100, height: 50 };

    const painted = paintImageFragment(fragment, block, measure, {} as RenderContext);
    const image = painted.querySelector('img');

    expect(image).not.toBeNull();
    expect(image!.hasAttribute('src')).toBe(false);
  });

  test('does not create a fetching src attribute for remote floating images', () => {
    const painted = paintFloatingImagesLayer(
      [{ src: 'https://tracker.test/pixel.png', width: 100, height: 50, x: 0, y: 0 }],
      document,
      {
        layerClass: 'float-layer',
        itemClass: 'float-item',
        sizing: 'inset0',
        layerMode: 'front',
      }
    );

    const image = painted.querySelector('img');
    expect(image).not.toBeNull();
    expect(image!.hasAttribute('src')).toBe(false);
  });
});
