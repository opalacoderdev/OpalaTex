import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ImageBlock, Page, ParagraphBlock, TextBoxBlock } from '../pagination-model/types';
import { paintPage } from './paintPage';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function emptyPage(overrides?: Partial<Page>): Page {
  return {
    number: 1,
    size: { w: 400, h: 300 },
    margins: { top: 60, right: 50, bottom: 60, left: 50, header: 36, footer: 36 },
    fragments: [],
    ...overrides,
  };
}

describe('header overflow / page clip scoping', () => {
  test('clips a fitting text-only header without unlocking page overflow', () => {
    const paragraph: ParagraphBlock = {
      kind: 'paragraph',
      id: 'header-text',
      runs: [{ kind: 'text', text: 'Header' }],
    };
    const painted = paintPage(
      emptyPage(),
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        headerDistance: 36,
        headerContent: {
          nodes: [paragraph],
          metrics: [{ kind: 'paragraph', lines: [], totalHeight: 16 }],
          height: 16,
          flowHeight: 16,
          visualTop: 0,
          visualBottom: 16,
        },
      }
    );

    const page = painted;
    const header = painted.querySelector<HTMLElement>('.layout-page-header');
    expect(page.style.overflow).toBe('hidden');
    expect(header?.style.overflow).toBe('hidden');
    // availableHeaderHeight = max(margins.top - headerDistance, 48)
    expect(header?.style.maxHeight).toBe('48px');
  });

  test('ordinary in-flow header images do not unlock page overflow', () => {
    const image: ImageBlock = {
      kind: 'image',
      id: 'header-logo',
      src: '',
      width: 40,
      height: 20,
    };
    const painted = paintPage(
      emptyPage(),
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        headerDistance: 36,
        headerContent: {
          nodes: [image],
          metrics: [{ kind: 'image', width: 40, height: 20 }],
          height: 20,
          flowHeight: 20,
          visualTop: 0,
          visualBottom: 20,
        },
      }
    );

    const header = painted.querySelector<HTMLElement>('.layout-page-header');
    expect(header?.querySelector('img')).not.toBeNull();
    // Media disables header clipping so the logo is not cut off, but the page
    // must keep overflow:hidden so body/footer clipping stays intact.
    expect(header?.style.overflow).toBe('visible');
    expect(painted.style.overflow).toBe('hidden');
  });

  test('#856 letterhead shape keeps a short interactive header without unlocking page overflow', () => {
    const shape: TextBoxBlock = {
      kind: 'textBox',
      id: 'letterhead-shape',
      width: 300,
      height: 220,
      content: [],
      displayMode: 'float',
      wrapType: 'none',
      position: {
        horizontal: { relativeTo: 'page', alignment: 'left' },
        vertical: { relativeTo: 'page', posOffset: 0 },
      },
    };
    const flow: ParagraphBlock = {
      kind: 'paragraph',
      id: 'header-flow',
      runs: [{ kind: 'text', text: 'Company' }],
    };
    const painted = paintPage(
      emptyPage({
        size: { w: 400, h: 500 },
        margins: { top: 72, right: 50, bottom: 72, left: 50 },
      }),
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        headerDistance: 36,
        headerContent: {
          nodes: [shape, flow],
          metrics: [
            { kind: 'textBox', width: 300, height: 220, innerMetrics: [] },
            { kind: 'paragraph', lines: [], totalHeight: 16 },
          ],
          height: 236,
          flowHeight: 16,
          visualTop: 0,
          visualBottom: 220,
        },
      }
    );

    const header = painted.querySelector<HTMLElement>('.layout-page-header');
    // Interactive box tracks flowHeight, floored at the 24px hit-target minimum.
    expect(header?.style.height).toBe('24px');
    expect(header?.style.overflow).toBe('visible');
    // Shape overhangs into the body band but stays inside the page box, so
    // page-level clipping must remain on.
    expect(painted.style.overflow).toBe('hidden');
  });

  test('only unlocks page overflow when header paints above the page box', () => {
    const shape: TextBoxBlock = {
      kind: 'textBox',
      id: 'above-page-shape',
      width: 80,
      height: 40,
      content: [],
      displayMode: 'float',
      wrapType: 'none',
      position: {
        vertical: { relativeTo: 'page', posOffset: -20 * 9_525 },
      },
    };
    const painted = paintPage(
      emptyPage(),
      { pageNumber: 1, totalPages: 1, section: 'body' },
      {
        document,
        headerDistance: 36,
        headerContent: {
          nodes: [shape],
          metrics: [{ kind: 'textBox', width: 80, height: 40, innerMetrics: [] }],
          height: 16,
          flowHeight: 16,
          // headerDistance(36) + visualTop(-50) < 0 → paints above page box
          visualTop: -50,
          visualBottom: 16,
        },
      }
    );

    const header = painted.querySelector<HTMLElement>('.layout-page-header');
    expect(header?.style.top).toBe('-14px');
    expect(header?.style.overflow).toBe('visible');
    expect(painted.style.overflow).toBe('visible');
  });
});
