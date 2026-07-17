/**
 * Stable DOM-facing rendering facade.
 *
 * This module intentionally exposes only browser and document vocabulary.
 * The page-flow, measurement, and paint models behind it are implementation
 * details and may change without affecting this contract.
 *
 * @packageDocumentation
 * @public
 */

import { EditorState } from 'prosemirror-state';

import type { Document as OoxmlDocument } from './types/document';
import { schema } from './prosemirror/schema';
import { toProseDoc } from './prosemirror/conversion/toProseDoc';
import { computeLayout } from './editor/computeLayout';
import {
  getColumns,
  getMargins,
  getPageSize,
  measureBlocksWithFloats,
  paragraphLayout,
  measureTable,
  resolveHeaderFooter,
  type FloatingImageZone,
} from './flow-model';
import {
  DEFAULT_TEXTBOX_MARGINS,
  DEFAULT_TEXTBOX_WIDTH,
  assertExhaustiveContentNode,
  type ContentNode,
  type LayoutMetrics,
} from './pagination-model';
import { indexNodesById, paintPages, type RenderPageOptions } from './painter-model';
import { getCaretPositionFromDom, readSelectionGeometry } from './flow-model/resolveDomPosition';

/** The independent ProseMirror position space that owns a painted box. */
export type RenderedRegion = 'body' | 'header' | 'footer';

/** A CSS-pixel rectangle within a rendered document. */
export interface RenderedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
  region: RenderedRegion;
  docFrom?: number;
  docTo?: number;
}

/** One painted page and the positioned DOM boxes it contains. */
export interface RenderedPage {
  element: HTMLElement;
  boxes: readonly RenderedBox[];
}

/** A snapshot of the pages currently painted below a DOM root. */
export interface RenderedDocument {
  root: HTMLElement;
  pages: readonly RenderedPage[];
}

/**
 * Render an OOXML document into paged DOM below `root`.
 *
 * The returned coordinates are CSS pixels relative to the root. Calling this
 * again replaces the current painted pages with a fresh rendering.
 */
export function renderDocument(document: OoxmlDocument, root: HTMLElement): RenderedDocument {
  const body = document.package.document;
  const sectionProperties =
    body.sections?.[0]?.properties ?? body.finalSectionProperties ?? undefined;
  const finalSectionProperties = body.finalSectionProperties ?? sectionProperties;
  const pageSize = getPageSize(sectionProperties);
  const margins = getMargins(sectionProperties);
  const columns = getColumns(sectionProperties);
  const finalPageSize = getPageSize(finalSectionProperties);
  const finalMargins = getMargins(finalSectionProperties);
  const finalColumns = getColumns(finalSectionProperties);
  const pageGap = 24;
  const contentWidth = pageSize.w - margins.left - margins.right;
  const state = EditorState.create({
    schema,
    doc: toProseDoc(document, { styles: document.package.styles ?? undefined }),
  });
  const { header, footer, firstHeader, firstFooter } = resolveHeaderFooter(
    document,
    sectionProperties
  );
  const result = computeLayout({
    state,
    document,
    pageSize,
    margins,
    columns,
    finalPageSize,
    finalMargins,
    finalColumns,
    pageGap,
    contentWidth,
    theme: document.package.theme,
    styles: document.package.styles,
    sectionProperties,
    finalSectionProperties,
    headerContent: header,
    footerContent: footer,
    firstPageHeaderContent: firstHeader,
    firstPageFooterContent: firstFooter,
    measureBlocks,
    getHfPmDoc: () => null,
  });

  const nodeLookup = indexNodesById(result.nodes, result.metrics);
  paintPages(result.layout.pages, root, {
    document: root.ownerDocument,
    pageGap,
    showShadow: true,
    pageBackground: 'var(--doc-page-bg, #ffffff)',
    nodeLookup,
    headerContent: result.headerContentForRender,
    footerContent: result.footerContentForRender,
    firstPageHeaderContent: result.firstPageHeaderForRender,
    firstPageFooterContent: result.firstPageFooterForRender,
    titlePg: result.hasTitlePg,
    headerDistance: result.headerDistancePx,
    footerDistance: result.footerDistancePx,
    pageBorders: result.pageBorders,
    theme: document.package.theme,
    watermark: result.watermark,
    footnotesByPage: result.footnotesByPage,
    virtualize: false,
  } as RenderPageOptions & { pageGap: number });

  return snapshotRenderedDocument(root);
}

function snapshotRenderedDocument(root: HTMLElement): RenderedDocument {
  const geometry = rootGeometry(root);
  const pages = Array.from(root.querySelectorAll<HTMLElement>('.layout-page')).map(
    (element, pageIndex): RenderedPage => {
      const boxes = Array.from(element.querySelectorAll<HTMLElement>('[data-doc-from]')).map(
        (box): RenderedBox => {
          const rect = box.getBoundingClientRect();
          const docFrom = numberData(box.dataset.docFrom);
          const docTo = numberData(box.dataset.docTo);
          return {
            x: (rect.left - geometry.rect.left) / geometry.scaleX,
            y: (rect.top - geometry.rect.top) / geometry.scaleY,
            width: rect.width / geometry.scaleX,
            height: rect.height / geometry.scaleY,
            pageIndex,
            region: regionOf(box),
            ...(docFrom === undefined ? {} : { docFrom }),
            ...(docTo === undefined ? {} : { docTo }),
          };
        }
      );
      return { element, boxes };
    }
  );

  return { root, pages };
}

function measureBlocks(
  nodes: ContentNode[],
  contentWidth: number | number[],
  pageGeometry?: Parameters<typeof measureBlocksWithFloats>[3],
  finalPageGeometry?: Parameters<typeof measureBlocksWithFloats>[4]
): LayoutMetrics[] {
  return measureBlocksWithFloats(
    nodes,
    contentWidth,
    measureBlock,
    pageGeometry,
    finalPageGeometry
  );
}

function measureBlock(
  block: ContentNode,
  contentWidth: number,
  floatingZones?: FloatingImageZone[],
  cumulativeY?: number
): LayoutMetrics {
  switch (block.kind) {
    case 'paragraph':
      return paragraphLayout(block, contentWidth, {
        floatingZones,
        paragraphYOffset: cumulativeY ?? 0,
      });
    case 'table':
      return measureTable(block, contentWidth, measureBlock);
    case 'image':
      return { kind: 'image', width: block.width ?? 100, height: block.height ?? 100 };
    case 'textBox': {
      const margins = block.margins ?? DEFAULT_TEXTBOX_MARGINS;
      const width = block.width ?? DEFAULT_TEXTBOX_WIDTH;
      const innerWidth = width - margins.left - margins.right;
      const innerMetrics = block.content.map((paragraph) => paragraphLayout(paragraph, innerWidth));
      const contentHeight = innerMetrics.reduce((sum, measure) => sum + measure.totalHeight, 0);
      return {
        kind: 'textBox',
        width,
        height: block.height ?? contentHeight + margins.top + margins.bottom,
        innerMetrics,
      };
    }
    case 'pageBreak':
      return { kind: 'pageBreak' };
    case 'columnBreak':
      return { kind: 'columnBreak' };
    case 'sectionBreak':
      return { kind: 'sectionBreak' };
    default:
      return assertExhaustiveContentNode(block, 'api renderDocument measureBlock');
  }
}

/**
 * Return the root-local CSS-pixel caret box for a body document position.
 *
 * Header and footer positions live in separate ProseMirror documents and are
 * deliberately not searched by this backward-compatible numeric API.
 */
export function caretAt(document: RenderedDocument, position: number): RenderedBox | null {
  const geometry = rootGeometry(document.root);
  const rect = getCaretPositionFromDom(document.root, position, geometry.rect, geometry.scaleY);
  if (!rect) return null;
  return {
    x: rect.x / geometry.scaleX,
    y: rect.y / geometry.scaleY,
    width: 0,
    height: rect.height,
    pageIndex: rect.pageIndex,
    region: 'body',
    docFrom: position,
    docTo: position,
  };
}

/**
 * Return root-local CSS-pixel boxes for a half-open body position range.
 *
 * The result may contain boxes from multiple pages. Header/footer ranges are
 * excluded because their numeric positions belong to independent documents.
 */
export function rectsFor(
  document: RenderedDocument,
  from: number,
  to: number
): readonly RenderedBox[] {
  const geometry = rootGeometry(document.root);
  return readSelectionGeometry(document.root, from, to, geometry.rect).map((rect) => ({
    x: rect.x / geometry.scaleX,
    y: rect.y / geometry.scaleY,
    width: rect.width / geometry.scaleX,
    height: rect.height / geometry.scaleY,
    pageIndex: rect.pageIndex,
    region: 'body',
    docFrom: from,
    docTo: to,
  }));
}

function regionOf(element: HTMLElement): RenderedRegion {
  if (element.closest('.layout-page-header')) return 'header';
  if (element.closest('.layout-page-footer')) return 'footer';
  return 'body';
}

function rootGeometry(root: HTMLElement): {
  rect: DOMRect;
  scaleX: number;
  scaleY: number;
} {
  const rect = root.getBoundingClientRect();
  const scaleX = root.offsetWidth > 0 ? rect.width / root.offsetWidth : 1;
  const scaleY = root.offsetHeight > 0 ? rect.height / root.offsetHeight : scaleX;
  return {
    rect,
    scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
    scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
  };
}

function numberData(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
