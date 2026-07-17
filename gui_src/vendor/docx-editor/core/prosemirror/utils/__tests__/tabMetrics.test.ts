/**
 * Tab stops (tasks §10a.10 — the gate for tasks §3.4).
 *
 * Until now the only coverage was a single right-aligned dot-leader case inside
 * a TOC e2e spec. The default 720-twip grid and the `end`/`center`/`decimal`/`bar`
 * anchoring had no oracle at all — which is to say the tab engine was untested,
 * and a tab is how every table of contents, every numbered list body, and every
 * right-aligned page number finds its column.
 *
 * Source: **[OOXML]** `w:tabs` §17.3.1.38, `w:tab` §17.3.1.37, `ST_TabJc`
 * §17.18.84, `w:defaultTabStop` §17.15.1.25. The 720-twip *default value* is
 * **[Word/test]** — the format mandates the setting, not the number.
 */

import { describe, expect, test } from 'bun:test';

import {
  calculatePositionalTabWidth,
  calculateTabWidth,
  type TabMark,
  type TabRuler,
} from '../tabMetrics';

/** 1440 twips = 1 inch = 96px, so 720 twips = 48px. */
const GRID_PX = 48;

const plainRuler: TabRuler = { leftIndent: 0 };

/** Where the pen ends up after a tab from `x`. */
function penAfterTab(x: number, ruler: TabRuler = plainRuler, options = {}): number {
  return x + calculateTabWidth(x, ruler, options).width;
}

describe('default tab grid (720 twips)', () => {
  test('a tab at the left margin advances to the first grid stop', () => {
    expect(penAfterTab(0)).toBe(GRID_PX);
  });

  test('a tab mid-column advances to the NEXT grid stop, not by a full interval', () => {
    // The pen is 10px into the first cell. The tab takes it to 48, not to 58 —
    // a tab moves to a column, it is not a fixed-width space.
    expect(penAfterTab(10)).toBe(GRID_PX);
    expect(penAfterTab(47)).toBe(GRID_PX);
  });

  test('a tab exactly ON a stop advances to the following one', () => {
    // Otherwise a tab would be a no-op wherever the pen already sits on a
    // column, and two tabs in a row would land in the same place as one.
    expect(penAfterTab(GRID_PX)).toBe(GRID_PX * 2);
    expect(penAfterTab(GRID_PX * 3)).toBe(GRID_PX * 4);
  });

  test('a negative pen (negative w:ind) still lands on the 0tw grid stop', () => {
    // No authored stops: the grid must not be floored at 0 as if a custom stop
    // lived there — the first multiple past the pen is position 0 itself.
    expect(penAfterTab(-30)).toBe(0);
  });

  test('the grid interval is configurable — Word writes it as w:defaultTabStop', () => {
    const halfGrid: TabRuler = { leftIndent: 0, defaultStopTwips: 360 };
    expect(penAfterTab(0, halfGrid)).toBe(24);
    expect(penAfterTab(25, halfGrid)).toBe(48);
  });
});

describe('explicit stops (w:tabs)', () => {
  test('an explicit stop the pen has not passed wins over the grid', () => {
    // Stop at 300 twips = 20px, nearer than the 48px grid stop.
    const ruler: TabRuler = { leftIndent: 0, explicitStops: [{ val: 'start', pos: 300 }] };
    expect(penAfterTab(0, ruler)).toBe(20);
  });

  test('a custom stop clears the default grid to its left', () => {
    // [Word/test]: setting a custom stop removes every default stop before it,
    // so a tab jumps straight to the custom stop — this is how a header's
    // "title<tab>CONFIDENTIAL" with one right stop at the margin reaches the
    // margin instead of stopping at the next half-inch.
    const ruler: TabRuler = { leftIndent: 0, explicitStops: [{ val: 'start', pos: 2880 }] };
    expect(penAfterTab(20, ruler)).toBe(192);
  });

  test('the grid resumes AFTER the rightmost custom stop', () => {
    // Custom stop at 720tw (48px); pen already past it at 60px. The next
    // landing place is the first grid stop beyond the custom stop: 96px.
    const ruler: TabRuler = { leftIndent: 0, explicitStops: [{ val: 'start', pos: 720 }] };
    expect(penAfterTab(60, ruler)).toBe(GRID_PX * 2);
  });

  test('an end stop the content cannot fit at falls through to the grid past it', () => {
    // Right stop at 1440tw (96px), pen at 90px with 30px of following content —
    // anchoring would start the content behind the pen, so the stop is skipped
    // and the grid past the custom stop is used instead (144px).
    const ruler: TabRuler = { leftIndent: 0, explicitStops: [{ val: 'end', pos: 1440 }] };
    expect(penAfterTab(90, ruler, { followingWidth: 30 })).toBe(GRID_PX * 3);
  });

  test('`clear` removes a stop rather than being one', () => {
    const ruler: TabRuler = { leftIndent: 0, explicitStops: [{ val: 'clear', pos: 300 }] };
    // The cleared stop at 20px is not a landing place — fall through to the grid.
    expect(penAfterTab(0, ruler)).toBe(GRID_PX);
  });

  test('`bar` draws a rule and is not a landing place', () => {
    // §17.3.1.37: a bar tab paints a vertical line at its position without
    // advancing content to it.
    const ruler: TabRuler = { leftIndent: 0, explicitStops: [{ val: 'bar', pos: 300 }] };
    expect(penAfterTab(0, ruler)).toBe(GRID_PX);
  });
});

describe('alignment anchors the content that follows the tab', () => {
  const stopAt = (val: TabMark['val'], twips: number): TabRuler => ({
    leftIndent: 0,
    explicitStops: [{ val, pos: twips }],
    // Silence the grid so the assertion is about the explicit stop alone.
    defaultStopTwips: 0,
  });

  test('`start` puts the content LEFT edge on the stop', () => {
    // Stop at 1440tw = 96px. Content is 30px wide; it begins at 96.
    const result = calculateTabWidth(0, stopAt('start', 1440), { followingWidth: 30 });
    expect(result.alignment).toBe('start');
    expect(result.width).toBe(96);
  });

  test('`end` puts the content RIGHT edge on the stop', () => {
    // The page number in a TOC. Content is 30px wide and must END at 96, so it
    // begins at 66 — the tab advances 66, not 96.
    const result = calculateTabWidth(0, stopAt('end', 1440), { followingWidth: 30 });
    expect(result.alignment).toBe('end');
    expect(result.width).toBe(66);
  });

  test('`center` straddles the content across the stop', () => {
    // 30px of content centred on 96 begins at 96 - 15 = 81.
    const result = calculateTabWidth(0, stopAt('center', 1440), { followingWidth: 30 });
    expect(result.alignment).toBe('center');
    expect(result.width).toBe(81);
  });

  test('`decimal` puts the decimal separator on the stop', () => {
    // "12.34": the "12" before the point is 20px. The point must land on 96, so
    // the number begins at 76 — this is what makes a column of figures line up
    // on the decimal regardless of how many digits precede it.
    const result = calculateTabWidth(0, stopAt('decimal', 1440), {
      followingWidth: 50,
      decimalPrefixWidth: 20,
    });
    expect(result.alignment).toBe('decimal');
    expect(result.width).toBe(76);
  });

  test('a stop whose anchored content would start behind the pen is skipped', () => {
    // An `end` stop at 96px with 120px of content would anchor the content at
    // -24px — behind the pen. That stop is unusable, so the search moves on
    // rather than emitting a negative (or zero) advance that would collapse the
    // line and paint the runs on top of each other.
    const ruler: TabRuler = {
      leftIndent: 0,
      explicitStops: [
        { val: 'end', pos: 1440 },
        { val: 'start', pos: 2880 },
      ],
      defaultStopTwips: 0,
    };
    const result = calculateTabWidth(0, ruler, { followingWidth: 120 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.width).toBe(192); // The next stop, 2880tw.
  });

  test('a tab always advances the pen, even with nowhere to go', () => {
    // No stops, no grid: still must not return 0. A zero-width tab collapses the
    // line and the run after it paints over the run before it.
    const nowhere: TabRuler = { leftIndent: 0, defaultStopTwips: 0 };
    expect(calculateTabWidth(500, nowhere).width).toBeGreaterThan(0);
  });
});

describe('hanging indent', () => {
  test('the left indent is an implicit stop — this is how a list body aligns', () => {
    // A list item paints "1." then a tab, and the body text hangs at the left
    // indent. Left indent 720tw = 48px; the marker leaves the pen at 12px.
    const ruler: TabRuler = { leftIndent: 720, defaultStopTwips: 0 };
    expect(penAfterTab(12, ruler)).toBe(GRID_PX);
  });

  test('once the pen is past the indent, it is no longer a stop', () => {
    const ruler: TabRuler = { leftIndent: 720 };
    // Pen at 60px is already past the 48px indent — fall through to the grid.
    expect(penAfterTab(60, ruler)).toBe(GRID_PX * 2);
  });
});

describe('leaders', () => {
  test('the stop the tab lands on carries its leader glyph', () => {
    const ruler: TabRuler = {
      leftIndent: 0,
      explicitStops: [{ val: 'end', pos: 1440, leader: 'dot' }],
      defaultStopTwips: 0,
    };
    expect(calculateTabWidth(0, ruler, { followingWidth: 20 }).leader).toBe('dot');
  });
});

describe('positional tabs (w:ptab)', () => {
  test('right-aligns following content to the target and preserves the leader', () => {
    const result = calculatePositionalTabWidth(
      120,
      640,
      { alignment: 'right', leader: 'dot' },
      { followingWidth: 20 }
    );

    expect(result).toEqual({ width: 500, alignment: 'end', leader: 'dot' });
  });
});
