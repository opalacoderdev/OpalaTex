import { describe, expect, test } from 'bun:test';
import type { PageLayout } from '../../pagination-model';
import {
  DEFAULT_SCROLL_BOTTOM_MARGIN_PX,
  getPageScrollInfo,
  getVisualScrollHeight,
  getVisualViewportHeight,
} from '../scrollGeometry';

function layoutWithPages(heights: number[]): PageLayout {
  return {
    pageSize: { w: 600, h: 1000 },
    pages: heights.map((h, index) => ({
      number: index + 1,
      size: { w: 600, h },
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
      fragments: [],
    })),
    pageGap: 24,
  };
}

describe('scrollGeometry', () => {
  test('maps zoomed scroll coordinates back to layout page coordinates', () => {
    const layout = layoutWithPages([1000, 1000, 1000]);

    expect(
      getPageScrollInfo({
        layout,
        scrollTop: 0,
        viewportHeight: 800,
        zoom: 0.5,
        pageGap: 24,
        paddingTop: 24,
      }).currentPage
    ).toBe(1);

    expect(
      getPageScrollInfo({
        layout,
        scrollTop: (24 + 1000 + 24) * 0.5,
        viewportHeight: 800,
        zoom: 0.5,
        pageGap: 24,
        paddingTop: 24,
      }).currentPage
    ).toBe(2);

    expect(
      getPageScrollInfo({
        layout,
        scrollTop: (24 + 1000 + 24) * 1.5,
        viewportHeight: 800,
        zoom: 1.5,
        pageGap: 24,
        paddingTop: 24,
      }).currentPage
    ).toBe(2);
  });

  test('computes the visual scroll spacer height from layout height and zoom', () => {
    expect(getVisualViewportHeight(2000, 0.5)).toBe(1000);
    expect(getVisualViewportHeight(2000, 1)).toBe(2000);
    expect(getVisualViewportHeight(2000, 1.5)).toBe(3000);
  });

  test('adds bottom breathing room to the scrollable height', () => {
    expect(getVisualScrollHeight(2000, 0.5)).toBe(1000 + DEFAULT_SCROLL_BOTTOM_MARGIN_PX);
    expect(getVisualScrollHeight(2000, 1.5, 120)).toBe(3120);
  });
});
