/**
 * Header/footer body-margin extension.
 *
 * Word grows the header (or footer) band when its in-flow content is taller
 * than the authored top (or bottom) margin minus the header/footer distance,
 * pushing the body text down (or up). This module owns that computation so the
 * React and Vue adapters share one implementation instead of byte-identical
 * inline copies (the layout pipelines were drifting candidates — see
 * `docx-editor` engine-unification work, issue #696).
 *
 * Two correctness rules live here:
 *
 *  1. The band height is driven by `HeaderFooterContent.flowHeight` (in-flow
 *     content only), NOT `height` / `visualBottom`. A page/margin-anchored
 *     float — e.g. a full-page letterhead anchored in a header — is positioned
 *     on the page and does not push the body in Word. Counting it inflated the
 *     effective top margin past the page on real-world templates, so the
 *     pageComposer hard-threw "page size and margins yield no content area" and
 *     the document rendered blank (issue #705).
 *
 *  2. A clamp guarantees `top + bottom` never consumes the whole page, so a
 *     pathological in-flow header degrades to a thin content band with a
 *     warning instead of aborting pagination.
 */

import type {
  ContentNode,
  PageHeaderFooterRefs,
  PageMargins,
  SectionMarkerBlock,
} from '../pagination-model/types';
import type { HeaderFooterContent } from '../painter-model/paintPage';

/** Word's default `w:header` / `w:footer` distance (0.5in = 48px). */
const DEFAULT_HF_DISTANCE_PX = 48;

/**
 * Floor on the body content area. Even when header/footer content is absurdly
 * tall, leave at least this much height so pagination produces a page instead
 * of throwing. ~one line at the default body font.
 */
const MIN_CONTENT_HEIGHT_PX = 24;

/** In-flow band height for one HF variant (falls back to total height). */
function bandHeight(hf: HeaderFooterContent | undefined): number {
  if (!hf) return 0;
  return hf.flowHeight ?? hf.height;
}

/** @public */
export interface ExtendMarginsForHeaderFooterInput {
  pageSize: { w: number; h: number };
  /** Body fallback margins. */
  margins: PageMargins;
  /** Final-section margins (last `sectPr`). */
  finalMargins: PageMargins;
  /**
   * Body flow nodes. Each `sectionBreak` block's `margins` is extended IN
   * PLACE so multi-section documents paginate with the same band growth (the
   * layout engine prefers `sectionBreak.margins` over the body fallback).
   */
  bodyNodes?: ContentNode[];
  /** Header variants in play this layout (e.g. default + first-page). */
  headers?: Array<HeaderFooterContent | undefined>;
  /** Footer variants in play this layout. */
  footers?: Array<HeaderFooterContent | undefined>;
  /**
   * Per-section header/footer resolution. When provided, each margin set is
   * extended by the band heights of its own section's referenced parts.
   */
  perSection?: {
    headerContentByRef: Map<string, HeaderFooterContent>;
    footerContentByRef: Map<string, HeaderFooterContent>;
    initialRefs?: PageHeaderFooterRefs;
    finalRefs?: PageHeaderFooterRefs;
  };
  /** Optional diagnostic sink for the clamp (adapters pass `console.warn`). */
  warn?: (message: string) => void;
}

/** @public */
export interface ExtendMarginsForHeaderFooterResult {
  margins: PageMargins;
  finalMargins: PageMargins;
}

/**
 * Extend body margins so the body clears the header/footer bands, mirroring
 * Word. Returns new `margins` / `finalMargins`; mutates `sectionBreak.margins`
 * in place. When no extension is needed the original objects are returned
 * unchanged.
 *
 * @public
 */
export function extendMarginsForHeaderFooter(
  input: ExtendMarginsForHeaderFooterInput
): ExtendMarginsForHeaderFooterResult {
  const { pageSize, margins, finalMargins, bodyNodes, headers, footers, perSection, warn } = input;

  const globalHeaderHeight = Math.max(0, ...(headers ?? []).map(bandHeight));
  const globalFooterHeight = Math.max(0, ...(footers ?? []).map(bandHeight));
  const heightsForRefs = (
    refs: PageHeaderFooterRefs | undefined
  ): { header: number; footer: number } => {
    if (!perSection || !refs) return { header: globalHeaderHeight, footer: globalFooterHeight };
    const headerHeights = [refs.headerDefault, refs.headerFirst, refs.headerEven].map((rId) =>
      bandHeight(rId ? perSection.headerContentByRef.get(rId) : undefined)
    );
    const footerHeights = [refs.footerDefault, refs.footerFirst, refs.footerEven].map((rId) =>
      bandHeight(rId ? perSection.footerContentByRef.get(rId) : undefined)
    );
    return { header: Math.max(0, ...headerHeights), footer: Math.max(0, ...footerHeights) };
  };

  // No header/footer content anywhere → nothing can push a body margin.
  const anyPerSectionContent =
    perSection &&
    (perSection.headerContentByRef.size > 0 || perSection.footerContentByRef.size > 0);
  if (globalHeaderHeight === 0 && globalFooterHeight === 0 && !anyPerSectionContent) {
    return { margins, finalMargins };
  }

  const maxMargins = Math.max(0, pageSize.h - MIN_CONTENT_HEIGHT_PX);
  let clamped = false;

  // Whether the band overflows is decided PER margin set, using that set's own
  // top/bottom and header/footer distances — not the body section's. A document
  // can mix sections whose margins differ (e.g. a landscape table section with a
  // thin 0.5in bottom margin embedded in a 1in-margin portrait body): the footer
  // fits the body's roomy margin yet overflows the landscape section's thin one,
  // so the band must grow there alone. Deciding once from the body margins left
  // the landscape footer overlapping the footnote area / body text (the page
  // number rode up next to the last footnote instead of sitting below it).
  const extend = (m: PageMargins, refs?: PageHeaderFooterRefs): PageMargins => {
    const { header: headerContentHeight, footer: footerContentHeight } = heightsForRefs(refs);
    const headerDistance = m.header ?? DEFAULT_HF_DISTANCE_PX;
    const footerDistance = m.footer ?? DEFAULT_HF_DISTANCE_PX;
    const extendHeader = headerContentHeight > m.top - headerDistance;
    const extendFooter = footerContentHeight > m.bottom - footerDistance;
    if (!extendHeader && !extendFooter) return m;

    const out = { ...m };
    if (extendHeader) out.top = Math.max(m.top, headerDistance + headerContentHeight);
    if (extendFooter) out.bottom = Math.max(m.bottom, footerDistance + footerContentHeight);
    // Safety net: never let header + footer consume the whole page. Clamp the
    // footer band first (it sits at the page bottom), then the header band if
    // it alone still overflows, so the body keeps a positive content area.
    if (out.top + out.bottom > maxMargins) {
      clamped = true;
      out.bottom = Math.max(0, Math.min(out.bottom, maxMargins - out.top));
      if (out.top + out.bottom > maxMargins) {
        out.top = Math.max(0, maxMargins - out.bottom);
      }
    }
    return out;
  };

  const extendedMargins = extend(margins, perSection?.initialRefs);
  const extendedFinal = extend(finalMargins, perSection?.finalRefs);
  if (bodyNodes) {
    for (const block of bodyNodes) {
      if (block.kind !== 'sectionBreak') continue;
      const sb = block as SectionMarkerBlock;
      if (sb.margins) sb.margins = extend(sb.margins, sb.headerFooterRefs);
    }
  }

  if (clamped && warn) {
    warn(
      '[layout] header/footer content exceeds page height; clamping margins to ' +
        `preserve a content area. pageHeight=${Math.round(pageSize.h)} ` +
        `headerBand=${Math.round(globalHeaderHeight)} footerBand=${Math.round(globalFooterHeight)} ` +
        `top=${Math.round(extendedMargins.top)} bottom=${Math.round(extendedMargins.bottom)}`
    );
  }

  return { margins: extendedMargins, finalMargins: extendedFinal };
}
