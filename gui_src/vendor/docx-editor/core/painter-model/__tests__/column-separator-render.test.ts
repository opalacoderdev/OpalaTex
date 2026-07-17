import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from '../../pagination-model/types';
import { paintPage } from '../paintPage';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('paintPage column separators', () => {
  test('spans only the used multi-column content height', () => {
    const page: Page = {
      number: 1,
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      size: { w: 500, h: 700 },
      columns: { count: 2, gap: 20, separator: true },
      fragments: [
        {
          kind: 'paragraph',
          nodeId: 'heading',
          x: 50,
          y: 60,
          width: 400,
          height: 24,
          fromLine: 0,
          toLine: 1,
        },
        {
          kind: 'paragraph',
          nodeId: 'left-column',
          x: 50,
          y: 110,
          width: 190,
          height: 60,
          fromLine: 0,
          toLine: 1,
        },
        {
          kind: 'paragraph',
          nodeId: 'right-column',
          x: 260,
          y: 110,
          width: 190,
          height: 90,
          fromLine: 0,
          toLine: 1,
        },
      ],
    };

    const el = paintPage(page, { pageNumber: 1, totalPages: 1, section: 'body' }, { document });
    const separator = el.querySelector<HTMLElement>('.layout-column-separator');

    expect(separator).toBeTruthy();
    expect(separator!.style.top).toBe('60px');
    expect(separator!.style.height).toBe('90px');
  });
});
