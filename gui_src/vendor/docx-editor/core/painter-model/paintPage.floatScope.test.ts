import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type {
  Page,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMetrics,
} from '../pagination-model/types';
import { paintPage } from './paintPage';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const block: ParagraphBlock = {
  kind: 'paragraph',
  id: 'split',
  runs: [
    {
      kind: 'image',
      src: 'embedded.png',
      width: 40,
      height: 40,
      displayMode: 'float',
      wrapType: 'square',
      position: {
        horizontal: { relativeTo: 'margin', align: 'left' },
        vertical: { relativeTo: 'paragraph', align: 'top' },
      },
    },
    { kind: 'text', text: 'abcdefgh' },
  ],
};

const measure: ParagraphMetrics = {
  kind: 'paragraph',
  totalHeight: 60,
  lines: [
    {
      fromRun: 0,
      fromChar: 0,
      toRun: 1,
      toChar: 2,
      width: 20,
      ascent: 15,
      descent: 5,
      lineHeight: 20,
      leftOffset: 52,
    },
    {
      fromRun: 1,
      fromChar: 2,
      toRun: 1,
      toChar: 4,
      width: 20,
      ascent: 15,
      descent: 5,
      lineHeight: 20,
      leftOffset: 52,
    },
    {
      fromRun: 1,
      fromChar: 4,
      toRun: 1,
      toChar: 8,
      width: 40,
      ascent: 15,
      descent: 5,
      lineHeight: 20,
    },
  ],
};

function pageWithFragment(number: number, fragment: ParagraphFragment): Page {
  return {
    number,
    size: { w: 300, h: 200 },
    margins: { top: 20, right: 20, bottom: 20, left: 20 },
    fragments: [fragment],
  };
}

test('paints an anchored image only on its split-paragraph fragment', () => {
  const first = paintPage(
    pageWithFragment(1, {
      kind: 'paragraph',
      nodeId: 'split',
      x: 20,
      y: 20,
      width: 260,
      height: 40,
      fromLine: 0,
      toLine: 2,
      continuesOnNext: true,
    }),
    { pageNumber: 1, totalPages: 2, section: 'body' },
    { document, nodeLookup: new Map([['split', { node: block, metrics: measure }]]) }
  );
  const continuation = paintPage(
    pageWithFragment(2, {
      kind: 'paragraph',
      nodeId: 'split',
      x: 20,
      y: 20,
      width: 260,
      height: 20,
      fromLine: 2,
      toLine: 3,
      continuesFromPrev: true,
    }),
    { pageNumber: 2, totalPages: 2, section: 'body' },
    { document, nodeLookup: new Map([['split', { node: block, metrics: measure }]]) }
  );

  expect(first.querySelectorAll('.layout-page-floating-image')).toHaveLength(1);
  expect(continuation.querySelectorAll('.layout-page-floating-image')).toHaveLength(0);
});
