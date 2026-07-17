/**
 * The pure layout COMPUTE pass shared by the React and Vue adapters — issue
 * #696 Tier 2, the clean half of the engine spine.
 *
 * This is the 6-step pass from React's `useLayoutPipeline` minus the DOM paint
 * + scroll/event side-effects (which stay adapter-side, where the framework
 * timing lives): PM doc → flow nodes → measure → header/footer resolve →
 * margin extension → `layOutPages` (+ two-pass footnote stabilization) →
 * footnote render items. It is pure (no DOM, no refs, no rAF) and returns
 * everything the adapter needs to paint.
 *
 * The one injected seam is `measureBlocks` — each adapter passes its own
 * measurer (React's is caching), same pattern as `measureBlocksWithFloats`.
 * `getHfPmDoc` is the HF-unification seam (prefer the persistent PM doc over
 * re-parsing `HeaderFooter.content`).
 */

import type { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

import {
  layOutPages,
  type ColumnLayout,
  type ContentNode,
  type FootnoteContent,
  type PageLayout,
  type LayoutMetrics,
  type Page,
  type PageMargins,
  type SectionMarkerBlock,
} from '../pagination-model';
import {
  buildBoxTree,
  computePerBlockWidths,
  demoteBlockLikeFloatingTables,
  buildEndnoteFlowBlocks,
  collectEndnoteRefs,
  collectFootnoteRefs,
  convertHeaderFooterToContent,
  convertHeaderFooterPmDocToContent,
  FOOTNOTE_COLUMN_GAP_PX,
  getColumns,
  getMargins,
  getPageSize,
  resolvePageHeaderFooter,
  type FloatPageGeometry,
} from '../flow-model';
import {
  buildFootnoteRenderItemsForPages,
  createWidthSpecificFootnoteContentResolver,
  stabilizeFootnoteLayoutWithPageContent,
} from '../flow-model/footnoteLayout';
import {
  pageGeometryFromPage,
  type FootnoteRenderItem,
  type HeaderFooterContent,
} from '../painter-model';
import type {
  Document,
  HeaderFooter,
  SectionProperties,
  StyleDefinitions,
  Theme,
  Watermark,
} from '../types/document';
import { registerPageFurniture, type PageFurniture } from '../painter-model/pageFurnitureRegistry';

interface PageSizePx {
  w: number;
  h: number;
}

/** Adapter-supplied block measurer (React's is caching). */
export type MeasureBlocksFn = (
  nodes: ContentNode[],
  contentWidth: number | number[],
  pageGeometry?: FloatPageGeometry,
  finalPageGeometry?: FloatPageGeometry
) => LayoutMetrics[];

export interface ComputeLayoutInputs {
  state: EditorState;
  document: Document | null;
  pageSize: PageSizePx;
  margins: PageMargins;
  columns: ColumnLayout | undefined;
  finalPageSize: PageSizePx;
  finalMargins: PageMargins;
  finalColumns: ColumnLayout | undefined;
  pageGap: number;
  contentWidth: number;
  theme: Theme | null | undefined;
  styles: StyleDefinitions | null | undefined;
  sectionProperties: SectionProperties | null | undefined;
  finalSectionProperties: SectionProperties | null | undefined;
  /** Resolved HF objects for the section (default + first-page). */
  headerContent: HeaderFooter | null | undefined;
  footerContent: HeaderFooter | null | undefined;
  firstPageHeaderContent: HeaderFooter | null | undefined;
  firstPageFooterContent: HeaderFooter | null | undefined;
  measureBlocks: MeasureBlocksFn;
  /** HF unification: the persistent PM doc for an HF, or null to re-parse content. */
  getHfPmDoc: (hf: HeaderFooter) => PMNode | null | undefined;
}

export interface LayoutComputation {
  nodes: ContentNode[];
  metrics: LayoutMetrics[];
  layout: PageLayout;
  headerContentForRender: HeaderFooterContent | undefined;
  footerContentForRender: HeaderFooterContent | undefined;
  firstPageHeaderForRender: HeaderFooterContent | undefined;
  firstPageFooterForRender: HeaderFooterContent | undefined;
  hasTitlePg: boolean;
  watermark: Watermark | undefined;
  headerDistancePx: number | undefined;
  footerDistancePx: number | undefined;
  pageBorders: SectionProperties['pageBorders'] | undefined;
  footnotesByPage: Map<number, FootnoteRenderItem[]> | undefined;
}

/**
 * Resolve one section's footnote column geometry. Footnotes span the section's
 * full content box independently of the body's `w:cols`.
 */
function resolveFootnoteColumnLayout(
  properties: SectionProperties | null | undefined,
  fallbackColumnWidth: number,
  page?: Page
): { columns: number; columnWidth: number } {
  if (!properties) return { columns: 1, columnWidth: fallbackColumnWidth };
  const columns = Math.max(1, Math.floor(properties.footnoteColumns ?? 1));
  const sectionContentWidthPx = page
    ? page.size.w - page.margins.left - page.margins.right
    : (() => {
        const sectionPageSize = getPageSize(properties);
        const sectionMargins = getMargins(properties);
        return sectionPageSize.w - sectionMargins.left - sectionMargins.right;
      })();
  const columnWidth = (sectionContentWidthPx - (columns - 1) * FOOTNOTE_COLUMN_GAP_PX) / columns;
  return { columns, columnWidth: Math.max(1, columnWidth) };
}

/**
 * Run the pure layout compute pass (the 6 steps in this file's header), lifted
 * verbatim from `useLayoutPipeline`. The adapter performs the DOM paint
 * (`paintPages`), scroll-restore, `painter:painted`, and state writeback with
 * the returned values.
 */
export function computeLayout(inputs: ComputeLayoutInputs): LayoutComputation {
  const {
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
    theme,
    styles,
    sectionProperties,
    finalSectionProperties,
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    measureBlocks,
    getHfPmDoc,
  } = inputs;

  const sectionProps =
    document?.package.document.sections?.map((section) => section.properties) ?? [];
  if (sectionProps.length === 0) {
    sectionProps.push(sectionProperties ?? finalSectionProperties ?? {});
  }
  const firstSectionProps = sectionProps[0] ?? sectionProperties ?? {};
  const lastSectionProps = sectionProps[sectionProps.length - 1] ?? finalSectionProperties ?? {};
  const resolvedPageSize = document ? getPageSize(firstSectionProps) : pageSize;
  const resolvedMargins = document ? getMargins(firstSectionProps) : margins;
  const resolvedColumns = document ? getColumns(firstSectionProps) : columns;
  const resolvedFinalPageSize = document ? getPageSize(lastSectionProps) : finalPageSize;
  const resolvedFinalMargins = document ? getMargins(lastSectionProps) : finalMargins;
  const resolvedFinalColumns = document ? getColumns(lastSectionProps) : finalColumns;

  // Step 1: PM doc → flow nodes.
  const pageContentHeight = resolvedPageSize.h - resolvedMargins.top - resolvedMargins.bottom;
  const nodes = buildBoxTree(state.doc, { theme, pageContentHeight });
  const endnoteRefs = collectEndnoteRefs(nodes);
  if (endnoteRefs.length > 0 && document?.package?.endnotes?.length) {
    const endnoteContentWidth =
      resolvedFinalPageSize.w - resolvedFinalMargins.left - resolvedFinalMargins.right;
    nodes.push(
      ...buildEndnoteFlowBlocks(document.package.endnotes, endnoteRefs, {
        styles: styles ?? undefined,
        theme: theme ?? null,
        defaultTabMarkTwips: state.doc.attrs?.defaultTabMarkTwips as number | null,
        numFmt: finalSectionProperties?.endnotePr?.numFmt ?? 'lowerRoman',
        numStart: finalSectionProperties?.endnotePr?.numStart ?? 1,
        contentWidth: endnoteContentWidth,
      })
    );
  }

  // Section markers in the PM carry the authored sectPr that closes each
  // section. Rebind them to the parser's effective section list so inherited
  // HF refs plus explicit zero distances survive and every later section gets
  // its own complete geometry.
  let markerIndex = 0;
  for (const block of nodes) {
    if (block.kind !== 'sectionBreak') continue;
    const properties = sectionProps[markerIndex++] ?? firstSectionProps;
    const marker = block as SectionMarkerBlock;
    marker.pageSize = getPageSize(properties);
    marker.margins = getMargins(properties);
    marker.columns = getColumns(properties);
    marker.type = properties.sectionStart;
  }

  // Step 2: Measure all nodes (per-section widths; full measure for float context).
  const blockWidths = computePerBlockWidths(
    nodes,
    {
      pageSize: resolvedPageSize,
      margins: resolvedMargins,
      columns: resolvedColumns,
    },
    {
      pageSize: resolvedFinalPageSize,
      margins: resolvedFinalMargins,
      columns: resolvedFinalColumns,
    }
  );

  // Step 1.5: Demote full-width "floating" tables to inline. A positioned table
  // that leaves no room for text to wrap beside it (a common full-width contract
  // form table) is block-like in Word/Google Docs — it paginates across pages.
  // Our floating path instead paints it as one overflowing fragment AND makes
  // the next paragraph skip past the whole table height (a wrap zone), stranding
  // it off-page. Clearing `floating` here — before measure and layout — routes
  // it through `layoutTable` (which breaks rows across pages) and suppresses the
  // wrap zone. Purely a layout transform on the ephemeral FlowBlocks; the PM doc
  // and the saved DOCX keep the original floating table.
  demoteBlockLikeFloatingTables(nodes, blockWidths, contentWidth);

  const metrics = measureBlocks(
    nodes,
    blockWidths,
    {
      ...pageGeometryFromPage({
        size: resolvedPageSize,
        margins: resolvedMargins,
      }),
      ...(resolvedColumns ? { columns: resolvedColumns } : {}),
    },
    {
      ...pageGeometryFromPage({
        size: resolvedFinalPageSize,
        margins: resolvedFinalMargins,
      }),
      ...(resolvedFinalColumns ? { columns: resolvedFinalColumns } : {}),
    }
  );

  // Step 2.5: Footnote references.
  const footnoteRefs = collectFootnoteRefs(nodes, metrics);
  const hasFootnotes = footnoteRefs.length > 0 && !!document?.package?.footnotes;

  // Step 2.75: Header/footer content is resolved per physical page. Conversion
  // is cached per section/rId because the same story can wrap differently when
  // later sections change page width or margins.
  const defaultTabMarkTwips = state.doc.attrs?.defaultTabMarkTwips as number | null;
  const hfConfig = { styles, theme, measureBlocks, defaultTabMarkTwips };
  const converted = new Map<string, HeaderFooterContent | undefined>();

  const convertHf = (
    hf: HeaderFooter | null | undefined,
    region: 'header' | 'footer',
    sectionIndex: number,
    rId: string | null
  ): HeaderFooterContent | undefined => {
    if (!hf) return undefined;
    const key = `${sectionIndex}:${region}:${rId ?? 'anonymous'}`;
    if (converted.has(key)) return converted.get(key);
    const properties = sectionProps[sectionIndex] ?? firstSectionProps;
    const sectionPageSize = getPageSize(properties);
    const sectionMargins = getMargins(properties);
    const sectionContentWidth = sectionPageSize.w - sectionMargins.left - sectionMargins.right;
    const metrics = { section: region, pageSize: sectionPageSize, margins: sectionMargins };
    const pmDoc = getHfPmDoc(hf);
    const value = pmDoc
      ? convertHeaderFooterPmDocToContent(pmDoc, sectionContentWidth, metrics, hfConfig)
      : convertHeaderFooterToContent(hf, sectionContentWidth, metrics, hfConfig);
    converted.set(key, value);
    return value;
  };

  const furnitureByPageNumber = new Map<number, PageFurniture>();
  const sectionIndexByPageNumber = new Map<number, number>();
  const resolveFurniture = (
    pageNumber: number,
    sectionIndex: number,
    sectionPageNumber: number
  ): PageFurniture => {
    if (!document) {
      const firstVariant = sectionPageNumber === 1 && sectionProperties?.titlePg === true;
      return {
        sectionIndex,
        sectionPageNumber,
        headerRId: null,
        footerRId: null,
        headerVariant: firstVariant ? 'first' : 'default',
        footerVariant: firstVariant ? 'first' : 'default',
        headerContent: convertHf(
          firstVariant ? firstPageHeaderContent : headerContent,
          'header',
          sectionIndex,
          null
        ),
        footerContent: convertHf(
          firstVariant ? firstPageFooterContent : footerContent,
          'footer',
          sectionIndex,
          null
        ),
        headerDistance: resolvedMargins.header ?? 48,
        footerDistance: resolvedMargins.footer ?? 48,
        pageBorders: firstSectionProps.pageBorders,
      };
    }
    const resolved = resolvePageHeaderFooter(document, pageNumber, sectionIndex, sectionPageNumber);
    return {
      sectionIndex,
      sectionPageNumber,
      headerRId: resolved.header.rId,
      footerRId: resolved.footer.rId,
      headerVariant: resolved.header.variant,
      footerVariant: resolved.footer.variant,
      headerContent: convertHf(
        resolved.header.content,
        'header',
        sectionIndex,
        resolved.header.rId
      ),
      footerContent: convertHf(
        resolved.footer.content,
        'footer',
        sectionIndex,
        resolved.footer.rId
      ),
      headerDistance: resolved.headerDistance,
      footerDistance: resolved.footerDistance,
      pageBorders: resolved.pageBorders,
    };
  };

  // Watermark rides PM state as a doc attr (so it's undoable).
  const watermark = (state.doc.attrs?.watermark as Watermark | null) ?? undefined;

  // Step 3: PageLayout onto pages (two-pass when footnotes exist).
  const bodyBreakType = lastSectionProps.sectionStart as
    | 'continuous'
    | 'nextPage'
    | 'evenPage'
    | 'oddPage'
    | undefined;
  const layoutConfig = {
    pageSize: resolvedPageSize,
    margins: resolvedMargins,
    finalPageSize: resolvedFinalPageSize,
    finalMargins: resolvedFinalMargins,
    columns: resolvedFinalColumns,
    bodyBreakType,
    pageGap,
    resolvePageMargins: ({
      base,
      pageNumber,
      sectionIndex,
      sectionPageNumber,
    }: {
      base: PageMargins;
      pageNumber: number;
      sectionIndex: number;
      sectionPageNumber: number;
    }): PageMargins => {
      const furniture = resolveFurniture(pageNumber, sectionIndex, sectionPageNumber);
      const headerHeight =
        furniture.headerContent?.flowHeight ?? furniture.headerContent?.height ?? 0;
      const footerHeight =
        furniture.footerContent?.flowHeight ?? furniture.footerContent?.height ?? 0;
      const out = { ...base };
      if (headerHeight > base.top - furniture.headerDistance) {
        out.top = Math.max(base.top, furniture.headerDistance + headerHeight);
      }
      if (footerHeight > base.bottom - furniture.footerDistance) {
        out.bottom = Math.max(base.bottom, furniture.footerDistance + footerHeight);
      }
      const sectionHeight = getPageSize(sectionProps[sectionIndex] ?? firstSectionProps).h;
      const maxMargins = Math.max(0, sectionHeight - 24);
      if (out.top + out.bottom > maxMargins) {
        out.bottom = Math.max(0, Math.min(out.bottom, maxMargins - out.top));
        if (out.top + out.bottom > maxMargins) out.top = Math.max(0, maxMargins - out.bottom);
      }
      return out;
    },
    onPageStart: ({
      pageNumber,
      sectionIndex,
      sectionPageNumber,
    }: {
      pageNumber: number;
      sectionIndex: number;
      sectionPageNumber: number;
    }) => {
      sectionIndexByPageNumber.set(pageNumber, sectionIndex);
      furnitureByPageNumber.set(
        pageNumber,
        resolveFurniture(pageNumber, sectionIndex, sectionPageNumber)
      );
    },
  };

  let layout: PageLayout;
  let pageFootnoteMap = new Map<number, number[]>();
  const footnoteContentMap = new Map<number, FootnoteContent>();
  let resolveFootnoteContent:
    | ((footnoteId: number, pageNumber: number, page?: Page) => FootnoteContent | undefined)
    | undefined;

  if (hasFootnotes) {
    const pass1Layout = layOutPages(nodes, metrics, layoutConfig);
    const footnoteLayoutForPage = (pageNumber: number, page?: Page) => {
      const physicalPageNumber = page?.number ?? pageNumber;
      const sectionIndex =
        sectionIndexByPageNumber.get(physicalPageNumber) ?? sectionProps.length - 1;
      const properties = sectionProps[Math.max(0, sectionIndex)] ?? lastSectionProps;
      return resolveFootnoteColumnLayout(properties, contentWidth, page);
    };

    const resolveContentAtWidth = createWidthSpecificFootnoteContentResolver(
      document!.package.footnotes!,
      footnoteRefs,
      {
        styles: styles ?? undefined,
        theme: theme ?? null,
        measureBlocks,
        defaultTabMarkTwips,
      }
    );
    resolveFootnoteContent = (footnoteId: number, pageNumber: number, page?: Page) =>
      resolveContentAtWidth(footnoteId, footnoteLayoutForPage(pageNumber, page).columnWidth);
    const stabilized = stabilizeFootnoteLayoutWithPageContent({
      nodes,
      metrics,
      layoutConfig,
      footnoteRefs,
      footnoteContentMap,
      initialLayout: pass1Layout,
      resolveFootnoteColumns: (pageNumber, page) => footnoteLayoutForPage(pageNumber, page).columns,
      resolveFootnoteContent,
    });
    layout = stabilized.layout;
    pageFootnoteMap = stabilized.pageFootnoteMap;
  } else {
    layout = layOutPages(nodes, metrics, layoutConfig);
  }

  const footnotesByPage = hasFootnotes
    ? buildFootnoteRenderItemsForPages(
        pageFootnoteMap,
        footnoteContentMap,
        document,
        layout.pages,
        resolveFootnoteContent!
      )
    : undefined;

  for (const page of layout.pages) {
    const furniture = furnitureByPageNumber.get(page.number);
    if (furniture) registerPageFurniture(page, furniture);
  }
  const firstFurniture = furnitureByPageNumber.get(1);
  const headerContentForRender = firstFurniture?.headerContent;
  const footerContentForRender = firstFurniture?.footerContent;
  const hasTitlePg = firstSectionProps.titlePg === true;
  const firstPageHeaderForRender =
    hasTitlePg && firstFurniture?.headerVariant === 'first'
      ? firstFurniture.headerContent
      : undefined;
  const firstPageFooterForRender =
    hasTitlePg && firstFurniture?.footerVariant === 'first'
      ? firstFurniture.footerContent
      : undefined;

  return {
    nodes,
    metrics,
    layout,
    headerContentForRender,
    footerContentForRender,
    firstPageHeaderForRender,
    firstPageFooterForRender,
    hasTitlePg,
    watermark,
    headerDistancePx: firstFurniture?.headerDistance,
    footerDistancePx: firstFurniture?.footerDistance,
    pageBorders: firstFurniture?.pageBorders,
    footnotesByPage: footnotesByPage?.size ? footnotesByPage : undefined,
  };
}
