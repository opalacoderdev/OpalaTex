export interface PageScrollLayout {
  pages: ReadonlyArray<{ size?: { h: number } }>;
  pageSize?: { h: number };
}

export interface PageScrollInfoInput {
  layout: PageScrollLayout;
  scrollTop: number;
  viewportHeight: number;
  zoom?: number;
  pageGap: number;
  paddingTop: number;
}

export interface PageScrollInfo {
  currentPage: number;
  totalPages: number;
}

export const DEFAULT_SCROLL_BOTTOM_MARGIN_PX = 96;

function safeZoom(zoom: number | undefined): number {
  return zoom != null && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

export function getVisualViewportHeight(layoutHeight: number, zoom: number | undefined): number {
  return Math.max(0, layoutHeight * safeZoom(zoom));
}

export function getVisualScrollHeight(
  layoutHeight: number,
  zoom: number | undefined,
  bottomMarginPx = DEFAULT_SCROLL_BOTTOM_MARGIN_PX
): number {
  return getVisualViewportHeight(layoutHeight, zoom) + Math.max(0, bottomMarginPx);
}

export function getPageScrollInfo(input: PageScrollInfoInput): PageScrollInfo {
  const { layout, scrollTop, viewportHeight, pageGap, paddingTop } = input;
  const totalPages = layout.pages.length;
  if (totalPages === 0) return { currentPage: 1, totalPages: 1 };

  const viewportCenterLayoutY = (scrollTop + viewportHeight / 2) / safeZoom(input.zoom);
  let accumulatedY = paddingTop;
  let currentPage = 1;

  for (let i = 0; i < totalPages; i++) {
    const pageHeight = layout.pages[i].size?.h ?? layout.pageSize?.h ?? 0;
    const pageEnd = accumulatedY + pageHeight;
    if (viewportCenterLayoutY < pageEnd) {
      currentPage = i + 1;
      break;
    }
    accumulatedY = pageEnd + pageGap;
    currentPage = i + 2;
  }

  return { currentPage: Math.min(currentPage, totalPages), totalPages };
}
