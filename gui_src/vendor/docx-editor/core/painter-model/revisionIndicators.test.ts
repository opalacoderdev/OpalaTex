import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { applyRevisionMetadata, RevisionBarCollector } from './revisionIndicators';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('RevisionBarCollector', () => {
  test('merges touching spans with the same kind and revision id', () => {
    const collector = new RevisionBarCollector();

    collector.register({ top: 10, height: 20, kind: 'ins', revisionId: 7 });
    collector.register({ top: 30, height: 10, kind: 'ins', revisionId: 7 });
    collector.register({ top: 50, height: 5, kind: 'del', revisionId: 8 });

    expect(collector.getMergedSpans()).toEqual([
      { top: 10, height: 30, kind: 'ins', revisionId: 7 },
      { top: 50, height: 5, kind: 'del', revisionId: 8 },
    ]);
  });

  test('does not merge different kinds or revision ids, and ignores zero-height spans', () => {
    const collector = new RevisionBarCollector();

    collector.register({ top: 0, height: 0, kind: 'ins', revisionId: 1 });
    collector.register({ top: 10, height: 10, kind: 'ins', revisionId: 1 });
    collector.register({ top: 20, height: 10, kind: 'del', revisionId: 1 });
    collector.register({ top: 30, height: 10, kind: 'ins', revisionId: 2 });

    expect(collector.getMergedSpans()).toEqual([
      { top: 10, height: 10, kind: 'ins', revisionId: 1 },
      { top: 20, height: 10, kind: 'del', revisionId: 1 },
      { top: 30, height: 10, kind: 'ins', revisionId: 2 },
    ]);
  });

  test('does not merge touching anonymous revision spans', () => {
    const collector = new RevisionBarCollector();

    collector.register({ top: 10, height: 20, kind: 'ins' });
    collector.register({ top: 30, height: 10, kind: 'ins' });

    expect(collector.getMergedSpans()).toEqual([
      { top: 10, height: 20, kind: 'ins' },
      { top: 30, height: 10, kind: 'ins' },
    ]);
  });

  test('paints non-interactive bars with the shared left offset and metadata classes', () => {
    const collector = new RevisionBarCollector();
    collector.register({
      top: 10,
      height: 20,
      kind: 'ins',
      revisionId: 7,
      author: 'Alice',
      date: '2026-07-16T17:00:00Z',
    });
    collector.register({ top: 50, height: 5, kind: 'del', revisionId: 8 });

    const overlay = collector.paint(document);

    expect(overlay).not.toBeNull();
    expect(overlay?.className).toBe('layout-revision-bars');
    expect(overlay?.style.pointerEvents).toBe('none');

    const bars = Array.from(overlay?.children ?? []) as HTMLElement[];
    expect(bars).toHaveLength(2);

    for (const bar of bars) {
      expect(bar.classList.contains('layout-revision-change-bar')).toBe(true);
      expect(bar.style.left).toBe('-10px');
      expect(bar.style.width).toBe('2px');
      expect(bar.style.pointerEvents).toBe('none');
    }

    expect(bars[0]?.classList.contains('layout-revision-ins')).toBe(true);
    expect(bars[0]?.style.top).toBe('10px');
    expect(bars[0]?.style.height).toBe('20px');
    expect(bars[0]?.dataset.revisionId).toBe('7');
    expect(bars[0]?.dataset.revisionAuthor).toBe('Alice');
    expect(bars[0]?.dataset.revisionDate).toBe('2026-07-16T17:00:00Z');

    expect(bars[1]?.classList.contains('layout-revision-del')).toBe(true);
    expect(bars[1]?.style.top).toBe('50px');
    expect(bars[1]?.style.height).toBe('5px');
  });
});

describe('applyRevisionMetadata', () => {
  test('adds the scope class, revision kind class, and metadata dataset', () => {
    const element = document.createElement('div');

    applyRevisionMetadata(element, 'layout-revision-change-bar', 'ins', {
      revisionId: 12,
      author: 'Bob',
      date: '2026-07-16',
    });

    expect(element.classList.contains('layout-revision-change-bar')).toBe(true);
    expect(element.classList.contains('layout-revision-ins')).toBe(true);
    expect(element.dataset.revisionId).toBe('12');
    expect(element.dataset.revisionAuthor).toBe('Bob');
    expect(element.dataset.revisionDate).toBe('2026-07-16');
  });
});
