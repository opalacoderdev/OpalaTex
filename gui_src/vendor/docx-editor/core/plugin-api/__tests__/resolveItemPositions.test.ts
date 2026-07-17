import { describe, expect, test } from 'bun:test';
import { resolveItemPositions, type ResolvableSidebarItem } from '../resolveItemPositions';

function item(id: string): ResolvableSidebarItem {
  return { id, anchorPos: 0, anchorKey: id, estimatedHeight: 100 };
}

describe('resolveItemPositions', () => {
  test('uses zoomed card height and gap for collision avoidance', () => {
    const anchors = new Map([
      ['a', 100],
      ['b', 105],
    ]);

    const resolved = resolveItemPositions(
      [item('a'), item('b')],
      anchors,
      null,
      0.5,
      new Map([['a', 100]]),
      new Map()
    );

    expect(resolved.map((entry) => entry.y)).toEqual([50, 104]);
  });
});
