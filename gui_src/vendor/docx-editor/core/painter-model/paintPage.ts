/** Paints one composed page and its page-level furniture.
 * @packageDocumentation
 * @public */

import type {
  Page,
  ParagraphBlock,
  ParagraphMetrics,
  TableBlock,
  TextBoxBlock,
  ImageRun,
} from '../pagination-model/types';
import { renderSdtBoundaryBoxes } from './sdtBoundary';
import type { NodeLookup } from './index';
import type { BorderSpec } from '../types/document';
import { borderToStyle } from '../utils/formatToStyle';
import type { Theme, Watermark } from '../types/document';
import { renderWatermarkLayer } from './renderWatermark';
import {
  rectsToFloatingZones,
  type FloatingExclusionRect,
  type FloatingImageZone,
} from '../flow-model/metrics';
import { resolveFontFamily } from '../utils/fontResolver';
import { pointsToPixels } from '../utils/units';
import {
  floatingTextBoxReservesBand,
  floatingTextBoxWrapsText,
  isFloatingTextBoxBlock,
} from '../pagination-model/textBoxFlow';
import {
  floatingImageIsBehindDoc,
  floatingImageWrapsText,
  imageWrapTextFromCssFloat,
  isFloatingImageRun,
} from './floatingImageFlow';
import {
  pageGeometryFromPage,
  resolveAnchoredObjectPosition,
  type PageGeometry,
} from './anchoredObjectPosition';
import { paintFloatingImagesLayer } from './floatingImageLayer';
import {
  renderHeaderFooterContent,
  type HeaderFooterContent,
  type SectionHeaderFooterContent,
  type HeaderFooterLayoutInfo,
} from './paintPage/headerFooter';
import {
  renderFootnoteArea,
  calculateFootnoteAreaRenderHeight,
  type FootnoteRenderItem,
} from './paintPage/footnotes';
import { bodySdtGroupsOf, paintBodyPageFragments } from './paintPage/bodyFragments';
import { getPageFurniture } from './pageFurnitureRegistry';
import type { PageFloatingImage } from './paintPage/pageFloatingImage';
import { appendRevisionBarOverlay, createBodyRevisionBarCollector } from './paintPageRevisionBars';

export {
  floatingImageIsBehindDoc,
  floatingImageWrapsText,
  isFloatingImageRun,
  isTextWrappingFloatingImageRun,
} from './floatingImageFlow';
export {
  paintFloatingImagesLayer,
  type FloatingImagePaintRecord,
  type FloatingImagesLayerOptions,
} from './floatingImageLayer';
export type {
  HeaderFooterContent,
  SectionHeaderFooterContent,
  HeaderFooterLayoutInfo,
} from './paintPage/headerFooter';
export {
  resolveHeaderFooterFloatingTablePosition,
  resolveHeaderFooterFloatLeft,
} from './paintPage/headerFooter';
export type { FootnoteRenderItem } from './paintPage/footnotes';
export {
  paintPages,
  paintAllPagesNow,
  type RenderPagesUpdateKind,
} from './paintPage/virtualization';

/**
 * CSS class names for page elements
 */
export const PAGE_CLASS_NAMES = {
  page: 'layout-page',
  content: 'layout-page-content',
  header: 'layout-page-header',
  footer: 'layout-page-footer',
};

/**
 * Context passed to fragment renderers
 */
export interface RenderContext {
  /** Current page number (1-indexed) */
  pageNumber: number;
  /** Total number of pages */
  totalPages: number;
  /** Which section is being rendered */
  section: 'body' | 'header' | 'footer';
  /** Content width in pixels (page width minus margins) - used for justify */
  contentWidth?: number;
  /** When true, floating images render in-flow instead of being skipped (for table cells) */
  insideTableCell?: boolean;
  /** Comment IDs that are resolved — skip highlight for these */
  resolvedCommentIds?: Set<number>;
  /**
   * How the renderer should position its outer element. The body lays
   * fragments at absolute (x, y) on the page (`'absolute'`, the default),
   * while headers/footers and text boxes flow nodes vertically and let
   * normal document flow handle placement (`'flow'`). The caller passes
   * 'flow' instead of overwriting the renderer's inline styles after the
   * fact (#379).
   */
  positioning?: 'absolute' | 'flow';
}

export interface RenderPageOptions {
  document?: Document;
  pageClassName?: string;
  showBorders?: boolean;
  backgroundColor?: string;
  showShadow?: boolean;
  headerContent?: HeaderFooterContent;
  footerContent?: HeaderFooterContent;
  firstPageHeaderContent?: HeaderFooterContent;
  firstPageFooterContent?: HeaderFooterContent;
  titlePg?: boolean;
  headerContentByRef?: Map<string, HeaderFooterContent>;
  footerContentByRef?: Map<string, HeaderFooterContent>;
  evenAndOddHeaders?: boolean;
  headerPartRId?: string;
  footerPartRId?: string;
  headerFooterBySection?: SectionHeaderFooterContent[];
  headerDistance?: number;
  footerDistance?: number;
  /** Block lookup for rendering actual content. */
  nodeLookup?: NodeLookup;
  /** OOXML page borders from section properties. */
  pageBorders?: {
    top?: BorderSpec;
    bottom?: BorderSpec;
    left?: BorderSpec;
    right?: BorderSpec;
    display?: 'allPages' | 'firstPage' | 'notFirstPage';
    offsetFrom?: 'page' | 'text';
    zOrder?: 'front' | 'back';
  };
  theme?: Theme | null;
  footnoteArea?: FootnoteRenderItem[];
  resolvedCommentIds?: Set<number>;
  watermark?: Watermark;
}

/**
 * Apply page styles to an element. Exported because virtualization.ts uses it
 * to size lightweight shells before content lands in them.
 */
export function applyPageStyles(
  element: HTMLElement,
  width: number,
  height: number,
  config: RenderPageOptions
): void {
  element.style.position = 'relative';
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  // Resolve via CSS custom properties so dark mode (.ep-root.dark) re-themes
  // the canvas without any adapter wiring. Word renders a dark page with light
  // text in dark mode; this is a VIEW transform only — the saved DOCX is never
  // changed, and authored run colors keep their own inline color.
  element.style.backgroundColor = config.backgroundColor ?? 'var(--doc-page-bg, #ffffff)';
  element.style.overflow = 'hidden';

  // Page-level default (11pt Calibri). Must use the same chain as canvas
  // measurement in textMetrics.ts, otherwise unbreakable runs that lack
  // an explicit fontFamily can overflow the page margin (#334).
  element.style.fontFamily = resolveFontFamily('Calibri').cssFallback;
  // Use pixels to match Canvas-based measurements (11pt = 11 * 96/72 ≈ 14.67px)
  element.style.fontSize = `${(11 * 96) / 72}px`;
  element.style.color = 'var(--doc-page-text, #000000)';

  if (config.showBorders) {
    element.style.border = '1px solid #ccc';
  }

  if (config.showShadow) {
    element.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)';
  }
}

function pageBorderShouldRender(
  pageNumber: number,
  display?: 'allPages' | 'firstPage' | 'notFirstPage'
): boolean {
  switch (display ?? 'allPages') {
    case 'firstPage':
      return pageNumber === 1;
    case 'notFirstPage':
      return pageNumber !== 1;
    case 'allPages':
    default:
      return true;
  }
}

function pageBorderSpacePx(border: BorderSpec | undefined): number {
  return border?.space !== undefined ? pointsToPixels(border.space) : 0;
}

function applyPageBorderSide(
  element: HTMLElement,
  border: BorderSpec | undefined,
  side: 'Top' | 'Bottom' | 'Left' | 'Right',
  theme?: Theme | null
): void {
  if (!border || border.style === 'none' || border.style === 'nil') return;

  const styles = borderToStyle(border, side, theme);
  for (const [key, value] of Object.entries(styles)) {
    (element.style as unknown as Record<string, string>)[key] = String(value);
  }

  const styleKey = `border${side}Style`;
  const widthKey = `border${side}Width`;
  const styleValue = (element.style as unknown as Record<string, string>)[styleKey];
  if (styleValue === 'double') {
    const widthValue = parseFloat((element.style as unknown as Record<string, string>)[widthKey]);
    if (!Number.isFinite(widthValue) || widthValue < 3) {
      (element.style as unknown as Record<string, string>)[widthKey] = '3px';
    }
  }
}

function paintPageBorderOverlay(
  page: Page,
  config: RenderPageOptions,
  doc: Document,
  sectionPageNumber = page.number
): HTMLElement | null {
  const pb = config.pageBorders;
  if (!pb || !pageBorderShouldRender(sectionPageNumber, pb.display)) return null;

  const hasBorder = [pb.top, pb.bottom, pb.left, pb.right].some(
    (border) => border && border.style !== 'none' && border.style !== 'nil'
  );
  if (!hasBorder) return null;

  const offsetFrom = pb.offsetFrom ?? 'text';
  const topOffset = pageBorderSpacePx(pb.top);
  const rightOffset = pageBorderSpacePx(pb.right);
  const bottomOffset = pageBorderSpacePx(pb.bottom);
  const leftOffset = pageBorderSpacePx(pb.left);

  const overlay = doc.createElement('div');
  overlay.className = 'layout-page-border';
  overlay.style.position = 'absolute';
  overlay.style.pointerEvents = 'none';
  overlay.style.boxSizing = 'border-box';
  overlay.style.zIndex = pb.zOrder === 'back' ? '0' : '20';

  if (offsetFrom === 'page') {
    overlay.style.top = `${topOffset}px`;
    overlay.style.right = `${rightOffset}px`;
    overlay.style.bottom = `${bottomOffset}px`;
    overlay.style.left = `${leftOffset}px`;
  } else {
    overlay.style.top = `${Math.max(0, page.margins.top - topOffset)}px`;
    overlay.style.right = `${Math.max(0, page.margins.right - rightOffset)}px`;
    overlay.style.bottom = `${Math.max(0, page.margins.bottom - bottomOffset)}px`;
    overlay.style.left = `${Math.max(0, page.margins.left - leftOffset)}px`;
  }

  applyPageBorderSide(overlay, pb.top, 'Top', config.theme);
  applyPageBorderSide(overlay, pb.bottom, 'Bottom', config.theme);
  applyPageBorderSide(overlay, pb.left, 'Left', config.theme);
  applyPageBorderSide(overlay, pb.right, 'Right', config.theme);

  return overlay;
}

/**
 * Apply content area styles to an element
 */
function applyContentAreaStyles(element: HTMLElement, page: Page): void {
  const margins = page.margins;

  element.style.position = 'absolute';
  element.style.top = `${margins.top}px`;
  element.style.left = `${margins.left}px`;
  element.style.right = `${margins.right}px`;
  element.style.bottom = `${margins.bottom}px`;
  element.style.overflow = 'visible';
}

function extractFloatingImagesFromParagraph(
  block: ParagraphBlock,
  measure: ParagraphMetrics,
  fromLine: number,
  toLine: number,
  fragmentY: number, // Y position of the paragraph fragment on the page (relative to content area)
  contentWidth: number, // Width of the content area
  geometry?: PageGeometry
): PageFloatingImage[] {
  const floatingImages: PageFloatingImage[] = [];

  const fragmentLines = measure.lines.slice(fromLine, toLine);
  const containsRun = (runIndex: number): boolean =>
    fragmentLines.some((line) => {
      const startsBeforeRun =
        line.fromRun < runIndex || (line.fromRun === runIndex && line.fromChar <= 0);
      const endsAfterRun = line.toRun > runIndex || (line.toRun === runIndex && line.toChar >= 1);
      return startsBeforeRun && endsAfterRun;
    });

  for (let runIndex = 0; runIndex < block.runs.length; runIndex++) {
    const run = block.runs[runIndex];
    if (run.kind !== 'image') continue;
    const imgRun = run as ImageRun;

    if (!isFloatingImageRun(imgRun)) continue;
    if (!containsRun(runIndex)) continue;

    const distTop = imgRun.distTop ?? 0;
    const distBottom = imgRun.distBottom ?? 0;
    const distLeft = imgRun.distLeft ?? 12;
    const distRight = imgRun.distRight ?? 12;
    const { x, y, side } = resolveAnchoredObjectPosition(imgRun, fragmentY, contentWidth, geometry);

    floatingImages.push({
      src: imgRun.src,
      width: imgRun.width,
      height: imgRun.height,
      alt: imgRun.alt,
      transform: imgRun.transform,
      side,
      x,
      y,
      distTop,
      distBottom,
      distLeft,
      distRight,
      docFrom: imgRun.docFrom,
      docTo: imgRun.docTo,
      wrapText: imageWrapTextFromCssFloat(imgRun.cssFloat),
      wrapType: imgRun.wrapType,
      cropTop: imgRun.cropTop,
      cropRight: imgRun.cropRight,
      cropBottom: imgRun.cropBottom,
      cropLeft: imgRun.cropLeft,
      opacity: imgRun.opacity,
      isInsertion: imgRun.isInsertion,
      isDeletion: imgRun.isDeletion,
      changeAuthor: imgRun.changeAuthor,
      changeDate: imgRun.changeDate,
      changeRevisionId: imgRun.changeRevisionId,
    });
  }

  return floatingImages;
}

/**
 * Render a single page to DOM
 *
 * @param page - The page to render
 * @param context - Rendering context
 * @param config - Rendering config
 * @returns The page DOM element
 */
export function paintPage(
  page: Page,
  context: RenderContext,
  config: RenderPageOptions = {}
): HTMLElement {
  const furniture = getPageFurniture(page);
  if (furniture) {
    config = {
      ...config,
      headerContent: furniture.headerContent,
      footerContent: furniture.footerContent,
      firstPageHeaderContent: undefined,
      firstPageFooterContent: undefined,
      titlePg: false,
      headerDistance: furniture.headerDistance,
      footerDistance: furniture.footerDistance,
      pageBorders: furniture.pageBorders,
    };
  }
  const doc = config.document ?? document;

  const pageEl = doc.createElement('div');
  pageEl.className = config.pageClassName ?? PAGE_CLASS_NAMES.page;
  pageEl.dataset.pageNumber = String(page.number);
  if (furniture) {
    pageEl.dataset.sectionIndex = String(furniture.sectionIndex);
    pageEl.dataset.sectionPageNumber = String(furniture.sectionPageNumber);
  }

  applyPageStyles(pageEl, page.size.w, page.size.h, config);

  // Watermark layer: painted first so it sits behind the body content area
  // (which is appended later), matching Word's behind-text watermark.
  if (config.watermark) {
    const watermarkLayer = renderWatermarkLayer(config.watermark, page, doc);
    if (watermarkLayer) {
      pageEl.appendChild(watermarkLayer);
    }
  }

  const pageBorderEl = paintPageBorderOverlay(
    page,
    config,
    doc,
    furniture?.sectionPageNumber ?? page.number
  );
  if (pageBorderEl && config.pageBorders?.zOrder === 'back') {
    pageEl.appendChild(pageBorderEl);
  }

  const contentEl = doc.createElement('div');
  contentEl.className = PAGE_CLASS_NAMES.content;
  applyContentAreaStyles(contentEl, page);

  const pageGeometry = pageGeometryFromPage(page);
  const contentWidth = pageGeometry.contentWidth;

  const allFloatingImages: PageFloatingImage[] = [];
  const floatingRects: FloatingExclusionRect[] = [];

  for (const fragment of page.fragments) {
    if (fragment.kind === 'paragraph' && config.nodeLookup) {
      const nodeData = config.nodeLookup.get(String(fragment.nodeId));
      if (nodeData?.node.kind === 'paragraph' && nodeData.metrics.kind === 'paragraph') {
        const paragraphBlock = nodeData.node as ParagraphBlock;
        // Fragment Y is relative to page top, we need it relative to content area
        const contentRelativeY = fragment.y - page.margins.top;
        const extracted = extractFloatingImagesFromParagraph(
          paragraphBlock,
          nodeData.metrics as ParagraphMetrics,
          fragment.fromLine,
          fragment.toLine,
          contentRelativeY,
          contentWidth,
          pageGeometry
        );
        allFloatingImages.push(...extracted);
      }
    }
  }

  for (const img of allFloatingImages) {
    if (!floatingImageWrapsText(img) && img.wrapType !== 'topAndBottom') continue;

    floatingRects.push({
      side: img.side,
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
      distTop: img.distTop,
      distBottom: img.distBottom,
      distLeft: img.distLeft,
      distRight: img.distRight,
      wrapText: img.wrapText,
      wrapType: img.wrapType,
    });
  }

  // Collect floating table exclusion rectangles
  if (config.nodeLookup) {
    for (const fragment of page.fragments) {
      if (fragment.kind !== 'table') continue;
      const nodeData = config.nodeLookup.get(String(fragment.nodeId));
      if (nodeData?.node.kind !== 'table') continue;
      const tableBlock = nodeData.node as TableBlock;
      const floating = tableBlock.floating;
      if (!floating) continue;

      const contentX = fragment.x - page.margins.left;
      const contentY = fragment.y - page.margins.top;

      const distTop = floating.topFromText ?? 0;
      const distBottom = floating.bottomFromText ?? 0;
      const distLeft = floating.leftFromText ?? 12;
      const distRight = floating.rightFromText ?? 12;

      const side = contentX < contentWidth / 2 ? 'left' : 'right';

      floatingRects.push({
        side,
        x: contentX,
        y: contentY,
        width: fragment.width,
        height: fragment.height,
        distTop,
        distBottom,
        distLeft,
        distRight,
      });
    }
  }

  // Collect floating text box exclusion rectangles and resolve their final page positions.
  if (config.nodeLookup) {
    for (const fragment of page.fragments) {
      if (fragment.kind !== 'textBox') continue;
      const nodeData = config.nodeLookup.get(String(fragment.nodeId));
      if (nodeData?.node.kind !== 'textBox') continue;
      const textBoxBlock = nodeData.node as TextBoxBlock;
      if (!isFloatingTextBoxBlock(textBoxBlock)) continue;

      const anchorContentY = fragment.y - page.margins.top;
      const resolved = resolveAnchoredObjectPosition(
        {
          width: fragment.width,
          height: fragment.height,
          position: textBoxBlock.position,
          cssFloat: textBoxBlock.cssFloat,
        },
        anchorContentY,
        contentWidth,
        pageGeometry
      );

      fragment.x = page.margins.left + resolved.x;
      fragment.y = page.margins.top + resolved.y;

      // topAndBottom reserves a full-width band (text flows above/below);
      // side-wrap types reserve a side exclusion. Both push a rect — the band
      // is distinguished by `wrapType` in rectsToFloatingZones.
      const reservesBand = floatingTextBoxReservesBand(textBoxBlock);
      if (!reservesBand && !floatingTextBoxWrapsText(textBoxBlock)) continue;

      floatingRects.push({
        side: resolved.side,
        x: resolved.x,
        y: resolved.y,
        width: fragment.width,
        height: fragment.height,
        distTop: textBoxBlock.distTop ?? 0,
        distBottom: textBoxBlock.distBottom ?? 0,
        distLeft: textBoxBlock.distLeft ?? 12,
        distRight: textBoxBlock.distRight ?? 12,
        wrapText: textBoxBlock.wrapText,
        wrapType: textBoxBlock.wrapType,
      });
    }
  }

  const floatingZones: FloatingImageZone[] =
    floatingRects.length > 0 ? rectsToFloatingZones(floatingRects, contentWidth) : [];

  const behindFloatingImages = allFloatingImages.filter(floatingImageIsBehindDoc);
  const frontFloatingImages = allFloatingImages.filter((img) => !floatingImageIsBehindDoc(img));
  if (behindFloatingImages.length > 0) {
    const floatingLayer = paintFloatingImagesLayer(behindFloatingImages, doc, {
      layerClass: 'layout-floating-images-layer',
      itemClass: 'layout-page-floating-image',
      sizing: 'inset0',
      layerMode: 'behind',
    });
    contentEl.appendChild(floatingLayer);
  }

  const revisionBars = createBodyRevisionBarCollector(allFloatingImages);

  paintBodyPageFragments({
    page,
    contentEl,
    doc,
    contentWidth,
    context,
    nodeLookup: config.nodeLookup,
    floatingZones,
    revisionBars,
  });

  renderSdtBoundaryBoxes(page, contentEl, contentWidth, bodySdtGroupsOf(config.nodeLookup), doc);

  // Render in-front floating images after text fragments so wrapNone and
  // wrapping images paint above body text without participating in flow.
  if (frontFloatingImages.length > 0) {
    const floatingLayer = paintFloatingImagesLayer(frontFloatingImages, doc, {
      layerClass: 'layout-floating-images-layer',
      itemClass: 'layout-page-floating-image',
      sizing: 'inset0',
      layerMode: 'front',
    });
    contentEl.appendChild(floatingLayer);
  }

  // Render column separator lines between columns (when w:sep is set)
  if (page.columns && page.columns.separator && page.columns.count > 1) {
    const colCount = page.columns.count;
    const colGap = page.columns.gap;
    const colWidth = (contentWidth - (colCount - 1) * colGap) / colCount;
    const contentHeight = page.size.h - page.margins.top - page.margins.bottom;
    const columnXPositions = Array.from(
      { length: colCount },
      (_, col) => page.margins.left + col * (colWidth + colGap)
    );
    const columnFragments = page.fragments
      .map((fragment) => ({
        fragment,
        columnIndex: columnXPositions.findIndex((x) => Math.abs(fragment.x - x) <= 1),
      }))
      .filter(({ columnIndex }) => columnIndex >= 0);
    const nonFirstColumnFragments = columnFragments.filter(({ columnIndex }) => columnIndex > 0);
    const rawSeparatorTop =
      nonFirstColumnFragments.length > 0
        ? Math.min(...nonFirstColumnFragments.map(({ fragment }) => fragment.y - page.margins.top))
        : columnFragments.length > 0
          ? Math.min(...columnFragments.map(({ fragment }) => fragment.y - page.margins.top))
          : 0;
    const separatorTop = Math.max(0, Math.min(contentHeight, rawSeparatorTop));
    const fragmentsInUsedBand = columnFragments.filter(({ fragment }) => {
      const height = 'height' in fragment ? fragment.height : 0;
      return fragment.y - page.margins.top + height >= separatorTop;
    });
    const separatorBottom =
      fragmentsInUsedBand.length > 0
        ? Math.max(
            ...fragmentsInUsedBand.map(({ fragment }) => {
              const height = 'height' in fragment ? fragment.height : 0;
              return fragment.y - page.margins.top + height;
            })
          )
        : 0;
    const separatorHeight = Math.max(0, Math.min(contentHeight, separatorBottom) - separatorTop);

    for (let col = 0; col < colCount - 1; col++) {
      const lineX = (col + 1) * colWidth + col * colGap + colGap / 2;
      const line = doc.createElement('div');
      line.className = 'layout-column-separator';
      line.style.position = 'absolute';
      line.style.left = `${lineX}px`;
      line.style.top = `${separatorTop}px`;
      line.style.height = `${separatorHeight}px`;
      line.style.width = '0.5px';
      line.style.backgroundColor = '#000';
      line.style.pointerEvents = 'none';
      contentEl.appendChild(line);
    }
  }

  // Render footnote area at the bottom of the content area (above footer)
  if (config.footnoteArea && config.footnoteArea.length > 0) {
    const footnoteColumns = page.footnoteColumns ?? 1;
    const fnAreaEl = renderFootnoteArea(
      config.footnoteArea,
      contentWidth,
      context,
      doc,
      footnoteColumns
    );
    fnAreaEl.style.position = 'absolute';
    // Position at page bottom minus bottom margin (bottom of content area).
    // The reserved height includes the separator + the tallest footnote column
    // (multi-column footnotes sit side by side, so the area is as tall as the
    // tallest column, not the sum of every footnote).
    const reservedHeight = Math.max(
      page.footnoteReservedHeight ?? 0,
      calculateFootnoteAreaRenderHeight(config.footnoteArea, footnoteColumns)
    );
    const contentAreaBottom = page.size.h - page.margins.bottom - page.margins.top;
    fnAreaEl.style.top = `${Math.max(-page.margins.top, contentAreaBottom - reservedHeight)}px`;
    fnAreaEl.style.left = '0';
    fnAreaEl.style.right = '0';
    contentEl.appendChild(fnAreaEl);
  }

  appendRevisionBarOverlay(revisionBars, contentEl, doc);

  pageEl.appendChild(contentEl);

  {
    const defaultHeaderDistance = 48;
    const headerDistance = config.headerDistance ?? page.margins.header ?? defaultHeaderDistance;
    const headerContentWidth = page.size.w - page.margins.left - page.margins.right;
    const availableHeaderHeight = Math.max(page.margins.top - headerDistance, 48);
    const headerVisualTop = config.headerContent?.visualTop ?? 0;
    const headerFlowHeight = config.headerContent?.flowHeight ?? config.headerContent?.height ?? 0;
    const headerVisualBottom = config.headerContent?.visualBottom ?? headerFlowHeight;
    // Interactive box tracks in-flow `flowHeight`, not float-inclusive
    // `visualBottom`, so a letterhead shape can't swallow body clicks (#856).
    const interactiveHeaderHeight = Math.max(headerFlowHeight - Math.min(0, headerVisualTop), 24);
    // Clip when content fits the margin band; otherwise leave unclipped.
    const headerVisualHeight =
      Math.max(headerFlowHeight, headerVisualBottom) - Math.min(0, headerVisualTop);
    const headerOverflows = headerVisualHeight > availableHeaderHeight;
    const headerExtendsBeyondFlow = headerVisualBottom > headerFlowHeight;

    const headerEl = doc.createElement('div');
    headerEl.className = PAGE_CLASS_NAMES.header;
    if (furniture?.headerRId) headerEl.dataset.hfRId = furniture.headerRId;
    if (furniture) {
      headerEl.dataset.hfVariant = furniture.headerVariant;
      headerEl.dataset.sectionIndex = String(furniture.sectionIndex);
      headerEl.dataset.sectionPageNumber = String(furniture.sectionPageNumber);
    }
    headerEl.style.position = 'absolute';
    headerEl.style.top = `${headerDistance + headerVisualTop}px`;
    headerEl.style.left = `${page.margins.left}px`;
    headerEl.style.right = `${page.margins.right}px`;
    headerEl.style.width = `${headerContentWidth}px`;
    headerEl.style.height = `${interactiveHeaderHeight}px`;
    headerEl.style.minHeight = `${interactiveHeaderHeight}px`;

    let shouldClipHeader = !headerOverflows && !headerExtendsBeyondFlow;
    if (config.headerContent && config.headerContent.nodes.length > 0) {
      const layout: HeaderFooterLayoutInfo = {
        flowTop: headerDistance,
        flowLeft: page.margins.left,
        contentWidth: headerContentWidth,
        pageWidth: page.size.w,
        pageHeight: page.size.h,
        margins: page.margins,
      };
      const headerContentEl = renderHeaderFooterContent(
        config.headerContent,
        { ...context, section: 'header', contentWidth: headerContentWidth },
        config,
        layout
      );
      headerContentEl.style.top = `${-headerVisualTop}px`;
      // Do not clip headers with media — measured height can miss abspos runs.
      if (headerContentEl.querySelector('img')) {
        shouldClipHeader = false;
      }
      headerEl.appendChild(headerContentEl);
    }
    if (shouldClipHeader) {
      headerEl.style.maxHeight = `${availableHeaderHeight}px`;
      headerEl.style.overflow = 'hidden';
    } else {
      // Unclip the header band; unlock page clip only for above-page overhang.
      headerEl.style.overflow = 'visible';
      if (headerDistance + headerVisualTop < 0) {
        pageEl.style.overflow = 'visible';
      }
    }
    pageEl.appendChild(headerEl);
  }

  // Render footer area (always rendered for hover hint / double-click target)
  {
    const defaultFooterDistance = 48;
    const footerDistance = config.footerDistance ?? page.margins.footer ?? defaultFooterDistance;
    const footerContentWidth = page.size.w - page.margins.left - page.margins.right;
    const availableFooterHeight = Math.max(page.margins.bottom - footerDistance, 48);
    const footerVisualTop = config.footerContent?.visualTop ?? 0;
    const footerFlowHeight = config.footerContent?.flowHeight ?? config.footerContent?.height ?? 0;
    const footerVisualBottom = config.footerContent?.visualBottom ?? footerFlowHeight;
    const footerVisualHeight =
      Math.max(footerFlowHeight, footerVisualBottom) - Math.min(0, footerVisualTop);
    const footerOverflows = footerVisualHeight > availableFooterHeight;
    const footerExtendsBeyondFlow = footerVisualBottom > footerFlowHeight;
    // Same as the header: the interactive box tracks the in-flow band, not a
    // floating shape's extent, so a tall anchored footer object can't cover the
    // body and swallow clicks (#856). The box stays bottom-anchored at the
    // footer line; floating content overflows upward (visible) and is made
    // non-interactive in normal mode via CSS.
    const interactiveFooterHeight = Math.max(footerFlowHeight - Math.min(0, footerVisualTop), 24);

    const footerEl = doc.createElement('div');
    footerEl.className = PAGE_CLASS_NAMES.footer;
    if (furniture?.footerRId) footerEl.dataset.hfRId = furniture.footerRId;
    if (furniture) {
      footerEl.dataset.hfVariant = furniture.footerVariant;
      footerEl.dataset.sectionIndex = String(furniture.sectionIndex);
      footerEl.dataset.sectionPageNumber = String(furniture.sectionPageNumber);
    }
    footerEl.style.position = 'absolute';
    footerEl.style.top = `${page.size.h - footerDistance - interactiveFooterHeight}px`;
    footerEl.style.left = `${page.margins.left}px`;
    footerEl.style.right = `${page.margins.right}px`;
    footerEl.style.width = `${footerContentWidth}px`;
    footerEl.style.height = `${interactiveFooterHeight}px`;
    footerEl.style.minHeight = `${interactiveFooterHeight}px`;

    let shouldClipFooter = !footerOverflows && !footerExtendsBeyondFlow;
    if (config.footerContent && config.footerContent.nodes.length > 0) {
      const layout: HeaderFooterLayoutInfo = {
        flowTop: page.size.h - footerDistance - footerFlowHeight,
        flowLeft: page.margins.left,
        contentWidth: footerContentWidth,
        pageWidth: page.size.w,
        pageHeight: page.size.h,
        margins: page.margins,
      };
      const footerContentEl = renderHeaderFooterContent(
        config.footerContent,
        { ...context, section: 'footer', contentWidth: footerContentWidth },
        config,
        layout
      );
      // Keep the content origin at the in-flow footer line even when the wrapper
      // expands upward for visual bounds or for the 24px interaction minimum.
      footerContentEl.style.top = `${interactiveFooterHeight - footerFlowHeight}px`;
      if (footerContentEl.querySelector('img')) {
        shouldClipFooter = false;
      }
      footerEl.appendChild(footerContentEl);
    }
    if (shouldClipFooter) {
      footerEl.style.maxHeight = `${availableFooterHeight}px`;
      footerEl.style.overflow = 'hidden';
    }
    pageEl.appendChild(footerEl);
  }

  if (pageBorderEl && config.pageBorders?.zOrder !== 'back') {
    pageEl.appendChild(pageBorderEl);
  }

  return pageEl;
}
