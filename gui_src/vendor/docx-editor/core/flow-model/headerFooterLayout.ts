/**
 * Header / Footer PageLayout Utilities
 *
 * The header/footer rendering pipeline lives here so any rendering adapter
 * (React, Vue, etc.) can share the conversion logic and just supply its
 * platform-specific {@link MeasureBlocksFn}. Mirrors the footnote pipeline
 * in `footnoteLayout.ts`.
 *
 * Pipeline:
 *   HF.content → headerFooterToProseDoc → buildBoxTree
 *     → measureBlocks (caller-supplied, Canvas-aware)
 *     → HeaderFooterContent (nodes, metrics, height, visualTop/Bottom)
 *
 * The render side uses the normalized block list so paint and measurement stay
 * in lockstep. Visual-bounds calculation still inspects the original block
 * list because floating images can paint above/below the nominal flow box even
 * when they do not contribute to flow height.
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type {
  ContentNode,
  ImageRun,
  LayoutMetrics,
  PageMargins,
  TableBlock,
} from '../pagination-model/types';
import type { HeaderFooter, StyleDefinitions, Theme } from '../types/document';
import type { HeaderFooterContent } from '../painter-model/paintPage';
import {
  pageGeometryFromPage,
  resolveAnchoredObjectVerticalTop,
} from '../painter-model/anchoredObjectPosition';
import { isFloatingTextBoxBlock } from '../pagination-model/textBoxFlow';
import { headerFooterToProseDoc } from '../prosemirror/conversion/toProseDoc';
import { buildBoxTree } from './buildBoxTree';
import type { MeasureBlocksFn } from './footnoteLayout';

// ============================================================================
// 1. Page-level metrics passed in by the caller
// ============================================================================

export type HeaderFooterMetrics = {
  section: 'header' | 'footer';
  pageSize: { w: number; h: number };
  margins: PageMargins;
};

// ============================================================================
// 2. Measurement-time block normalization
// ============================================================================
//
// Two transforms are applied to the ContentNode list before measurement/render:
//
// 1. **Strip style-inherited paragraph spacing** (#380) — Word visibly
//    does NOT honor inherited `spaceBefore` / `spaceAfter` (e.g. Normal's
//    default 8pt-after) inside the HF text frame. Inline `<w:spacing>`
//    set explicitly on the HF paragraph IS honored. The parser flags
//    inline spacing via `spacingOverrides.before` / `.after`; anything
//    not flagged was inherited from the style chain and is zeroed for
//    both measurement and painting.
//
// 2. **Zero trailing empty paragraph after a table** (#381) — OOXML
//    requires a trailing block-level element after the last `<w:tbl>`
//    in any block container, including `<w:hdr>` / `<w:ftr>`. Word
//    renders that empty paragraph as a zero-height anchor (just the
//    paragraph mark glyph) when it has no runs AND no authored visual
//    content (no paragraph borders, no explicit spacing). We mark its
//    measure with `suppressEmptyParagraphHeight` so the BLOCK survives
//    (click-to-position into the empty space below the table places
//    the cursor in the trailing paragraph, matching Word) but the
//    measure returns zero height. Empty paragraphs with authored
//    `pBdr` (e.g. a horizontal rule under the header) or
//    `spacingOverrides` are NOT suppressed — they exist for their
//    visual side effect, not just as a structural anchor.

function hasAuthoredVisualContent(block: ContentNode): boolean {
  if (block.kind !== 'paragraph') return false;
  const attrs = block.attrs;
  if (!attrs) return false;
  if (attrs.borders?.top || attrs.borders?.bottom) return true;
  if (attrs.spacingOverrides?.before || attrs.spacingOverrides?.after) return true;
  return false;
}

export function normalizeHeaderFooterMeasureBlocks(nodes: ContentNode[]): ContentNode[] {
  return normalizeFlowBlockArray(nodes);
}

function normalizeFlowBlockArray(nodes: ContentNode[]): ContentNode[] {
  const trailingEmptyAfterTable = new Set<number>();
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const cur = nodes[i];
    if (prev.kind !== 'table') continue;
    if (cur.kind !== 'paragraph') continue;
    if (cur.runs.length > 0) continue;
    if (hasAuthoredVisualContent(cur)) continue;
    trailingEmptyAfterTable.add(i);
  }

  return nodes.map((block, index) => {
    if (block.kind === 'table') {
      return normalizeTableBlock(block);
    }
    if (block.kind !== 'paragraph') return block;

    const isTrailingEmpty = trailingEmptyAfterTable.has(index);

    const explicit = block.attrs?.spacingOverrides;
    const hasResolvedBefore = block.attrs?.spacing?.before != null;
    const hasResolvedAfter = block.attrs?.spacing?.after != null;
    const beforeIsInherited = hasResolvedBefore && !explicit?.before;
    const afterIsInherited = hasResolvedAfter && !explicit?.after;
    const stripsSpacing = beforeIsInherited || afterIsInherited;

    if (!stripsSpacing && !isTrailingEmpty) return block;

    let attrs = block.attrs;
    if (stripsSpacing && attrs?.spacing) {
      attrs = {
        ...attrs,
        spacing: {
          ...attrs.spacing,
          before: explicit?.before ? attrs.spacing.before : undefined,
          after: explicit?.after ? attrs.spacing.after : undefined,
        },
      };
    }

    if (isTrailingEmpty) {
      attrs = { ...(attrs ?? {}), suppressEmptyParagraphHeight: true };
    }

    return { ...block, attrs };
  });
}

function normalizeTableBlock(block: TableBlock): TableBlock {
  let changed = false;
  const rows = block.rows.map((row) => {
    let rowChanged = false;
    const cells = row.cells.map((cell) => {
      const normalizedNodes = normalizeFlowBlockArray(cell.nodes);
      const cellChanged = normalizedNodes.some(
        (normalizedBlock, idx) => normalizedBlock !== cell.nodes[idx]
      );
      if (!cellChanged) return cell;
      rowChanged = true;
      return { ...cell, nodes: normalizedNodes };
    });
    if (!rowChanged) return row;
    changed = true;
    return { ...row, cells };
  });

  return changed ? { ...block, rows } : block;
}

// ============================================================================
// 3. Visual bounds (account for floating images that paint above/below the
//    nominal flow rectangle so HF clipping & shadow regions size correctly)
// ============================================================================

type PositionedAxis = {
  relativeTo?: string;
  posOffset?: number;
  align?: string;
  alignment?: string;
};

function getPositionAlignment(axis: PositionedAxis | undefined): string | undefined {
  return axis?.align ?? axis?.alignment;
}

export function resolveHeaderFooterVisualTop(
  run: ImageRun,
  paragraphY: number,
  flowHeight: number,
  metrics: HeaderFooterMetrics
): number {
  return resolveHeaderFooterPositionedTop(run, paragraphY, flowHeight, metrics);
}

function resolveHeaderFooterPositionedTop(
  object: Pick<ImageRun, 'height' | 'position'>,
  paragraphY: number,
  flowHeight: number,
  metrics: HeaderFooterMetrics
): number {
  const flowTop = resolveHeaderFooterFlowTop(flowHeight, metrics);
  const vertical = object.position?.vertical;
  const geometry = pageGeometryFromPage({
    size: metrics.pageSize,
    margins: metrics.margins,
  });
  const paragraphContentY = flowTop + paragraphY - metrics.margins.top;
  const resolvedContentTop = resolveAnchoredObjectVerticalTop(
    {
      width: 0,
      height: object.height,
      position: vertical
        ? {
            vertical: {
              relativeTo: vertical.relativeTo,
              posOffset: vertical.posOffset,
              align: getPositionAlignment(vertical),
            },
          }
        : undefined,
    },
    paragraphContentY,
    geometry
  );

  return metrics.margins.top + resolvedContentTop - flowTop;
}

function resolveHeaderFooterFlowTop(flowHeight: number, metrics: HeaderFooterMetrics): number {
  return metrics.section === 'header'
    ? (metrics.margins.header ?? 48)
    : metrics.pageSize.h - (metrics.margins.footer ?? 48) - flowHeight;
}

/**
 * Resolve a floating table's visual top relative to the header/footer flow
 * origin. Keep this coordinate transform aligned with
 * `resolveHeaderFooterFloatingTablePosition`, which the painter uses.
 */
function resolveHeaderFooterFloatingTableTop(
  floating: NonNullable<TableBlock['floating']>,
  flowHeight: number,
  metrics: HeaderFooterMetrics
): number {
  const flowTop = resolveHeaderFooterFlowTop(flowHeight, metrics);
  let top = floating.tblpY ?? 0;
  if (floating.vertAnchor === 'page') {
    top -= flowTop;
  } else if (floating.vertAnchor === 'margin') {
    top += metrics.margins.top - flowTop;
  }
  return top;
}

/**
 * Whether a header/footer block participates in the in-flow band height that
 * pushes the body margin.
 *
 * OOXML semantics: Word grows the header/footer band — and shifts body text —
 * based only on the story's in-flow content. A floating/anchored object
 * (`wp:anchor` DrawingML or an absolutely-positioned VML shape, e.g. a
 * full-page letterhead anchored to the page in a header) is removed from the
 * text flow and positioned on the page; it does NOT grow the band or push the
 * body. So only inline-flow nodes count here. Anchored image *runs* inside a
 * paragraph are likewise out of flow, but they don't contribute to the
 * paragraph's measured line height, so paragraphs need no special handling.
 *
 * @public
 */
export function contributesToHeaderFooterFlowHeight(block: ContentNode): boolean {
  switch (block.kind) {
    case 'paragraph':
      return true;
    case 'table':
      // `<w:tblpPr>` tables are page/margin/text-positioned by the painter
      // and do not advance its header/footer story cursor.
      return !block.floating;
    case 'image':
      // Inline images count; page/paragraph-anchored floats do not.
      return !block.anchor?.isAnchored;
    case 'textBox':
      // Only genuinely inline text boxes count. Every anchored wrap mode,
      // including topAndBottom's `displayMode: block`, is positioned out of
      // the story flow and must not push the body margin.
      return !isFloatingTextBoxBlock(block);
    default:
      return false; // sectionBreak / pageBreak / columnBreak
  }
}

function measureFlowHeight(measure: LayoutMetrics | undefined): number {
  if (!measure) return 0;
  if (measure.kind === 'paragraph') return measure.totalHeight;
  if (measure.kind === 'table') return measure.totalHeight;
  if (measure.kind === 'image') return measure.height;
  if (measure.kind === 'textBox') return measure.height;
  return 0;
}

function getParagraphBorderVisualOutsets(block: ContentNode): { top: number; bottom: number } {
  if (block.kind !== 'paragraph') return { top: 0, bottom: 0 };
  const borders = block.attrs?.borders;
  return {
    top: borders?.top ? (borders.top.space ?? 0) : 0,
    bottom: borders?.bottom ? (borders.bottom.space ?? 0) : 0,
  };
}

export function calculateHeaderFooterVisualBounds(
  nodes: ContentNode[],
  layoutMetrics: LayoutMetrics[],
  flowHeight: number,
  pageMetrics: HeaderFooterMetrics
): { visualTop: number; visualBottom: number } {
  let visualTop = 0;
  // Accumulate the real extent from the nodes below. Do NOT seed with the
  // caller's `flowHeight`: when a floating box doesn't advance the cursor,
  // seeding with the in-flow total would still keep `visualBottom` taller than
  // the content actually encountered in malformed block/measure pairs.
  let visualBottom = 0;
  let cursorY = 0;

  for (let i = 0; i < nodes.length; i++) {
    const block = nodes[i];
    const measure = layoutMetrics[i];
    if (!block || !measure) continue;

    if (block.kind === 'paragraph' && measure.kind === 'paragraph') {
      const paragraphStartY = cursorY;
      const paragraphBottomY = paragraphStartY + measure.totalHeight;
      const borderOutsets = getParagraphBorderVisualOutsets(block);
      visualTop = Math.min(visualTop, paragraphStartY - borderOutsets.top);
      visualBottom = Math.max(visualBottom, paragraphBottomY + borderOutsets.bottom);

      for (const run of block.runs) {
        if (run.kind !== 'image' || !run.position) continue;
        const runTop = resolveHeaderFooterVisualTop(run, paragraphStartY, flowHeight, pageMetrics);
        visualTop = Math.min(visualTop, runTop);
        visualBottom = Math.max(visualBottom, runTop + run.height);
      }

      cursorY = paragraphBottomY;
    } else if (block.kind === 'table' && measure.kind === 'table') {
      const positioned = Boolean(block.floating);
      const blockTopY = block.floating
        ? resolveHeaderFooterFloatingTableTop(block.floating, flowHeight, pageMetrics)
        : cursorY;
      const blockBottomY = blockTopY + measure.totalHeight;
      visualTop = Math.min(visualTop, blockTopY);
      visualBottom = Math.max(visualBottom, blockBottomY);
      // Floating tables paint at their resolved anchor without advancing the
      // story cursor, so following paragraphs start where the table's anchor
      // paragraph would have started.
      if (!positioned) {
        cursorY = blockBottomY;
      }
    } else if (block.kind === 'image' && measure.kind === 'image') {
      const blockBottomY = cursorY + measure.height;
      visualTop = Math.min(visualTop, cursorY);
      visualBottom = Math.max(visualBottom, blockBottomY);
      cursorY = blockBottomY;
    } else if (block.kind === 'textBox' && measure.kind === 'textBox') {
      const positioned = isFloatingTextBoxBlock(block);
      const blockTopY = positioned
        ? resolveHeaderFooterPositionedTop(
            { height: measure.height, position: block.position },
            cursorY,
            flowHeight,
            pageMetrics
          )
        : cursorY;
      const blockBottomY = blockTopY + measure.height;
      visualTop = Math.min(visualTop, blockTopY);
      visualBottom = Math.max(visualBottom, blockBottomY);
      // Anchored text boxes extend visual bounds at their resolved page/margin
      // position but never advance the story cursor. This includes
      // topAndBottom boxes, whose `displayMode` is `block` even though the
      // drawing remains positioned out of flow.
      if (!positioned) {
        cursorY += measure.height;
      }
    }
  }

  return { visualTop, visualBottom };
}

// ============================================================================
// 4. HeaderFooter → HeaderFooterContent (the public entry point)
// ============================================================================

export type ConvertHeaderFooterOptions = {
  styles?: StyleDefinitions | null;
  theme?: Theme | null;
  measureBlocks: MeasureBlocksFn;
  /**
   * `w:defaultTabMark` (twips) read from `state.doc.attrs.defaultTabMarkTwips`
   * on the body doc — HF content doesn't carry its own doc-level setting,
   * so pass it through so list markers inside headers/footers honor the
   * same tab grid as the body.
   */
  defaultTabMarkTwips?: number | null;
};

/**
 * Convert HeaderFooter (document type) to HeaderFooterContent (render type).
 *
 * Routes through the same pipeline as the body: HF.content →
 * headerFooterToProseDoc → buildBoxTree → measureBlocks. The inline editor
 * uses the same conversion chain, so block support (paragraph, table, image,
 * textBox, fields) and the inline editor's content stay in lockstep.
 */
export function convertHeaderFooterToContent(
  headerFooter: HeaderFooter | null | undefined,
  contentWidth: number,
  metrics: HeaderFooterMetrics,
  config: ConvertHeaderFooterOptions
): HeaderFooterContent | undefined {
  if (!headerFooter || !headerFooter.content || headerFooter.content.length === 0) {
    return undefined;
  }

  const pmDoc = headerFooterToProseDoc(headerFooter.content, {
    styles: config.styles ?? undefined,
    theme: config.theme ?? null,
    defaultTabMarkTwips: config.defaultTabMarkTwips ?? null,
  });
  return convertHeaderFooterPmDocToContent(pmDoc, contentWidth, metrics, config);
}

/**
 * Same pipeline as {@link convertHeaderFooterToContent}, but starts from an
 * already-built ProseMirror document instead of `HeaderFooter.content`.
 *
 * The unified HF editing model (see `openspec/changes/unify-hf-editing/`)
 * maintains one persistent hidden PM EditorView per HF `rId`. The painter
 * reads from that EditorView's current `state.doc` rather than re-parsing
 * the Document-model `HeaderFooter` every layout pass — this is what
 * actually makes the painter and the editor stay in lockstep.
 *
 * `headerFooterToProseDoc` is still the right entry point when there is no
 * mounted PM for the slot (cold load, or rId not yet projected).
 *
 * @public
 */
export function convertHeaderFooterPmDocToContent(
  pmDoc: PMNode,
  contentWidth: number,
  pageMetrics: HeaderFooterMetrics,
  config: ConvertHeaderFooterOptions
): HeaderFooterContent | undefined {
  const nodes = buildBoxTree(pmDoc, { theme: config.theme ?? undefined });
  if (nodes.length === 0) return undefined;

  const nodesForMeasure = normalizeHeaderFooterMeasureBlocks(nodes);
  const layoutMetrics = config.measureBlocks(nodesForMeasure, contentWidth);
  let totalHeight = 0;
  let flowHeight = 0;
  for (let i = 0; i < nodesForMeasure.length; i++) {
    const h = measureFlowHeight(layoutMetrics[i]);
    totalHeight += h;
    if (contributesToHeaderFooterFlowHeight(nodesForMeasure[i])) flowHeight += h;
  }
  // Use `nodesForMeasure` (the normalized list the `metrics` were computed
  // from), NOT the raw `nodes` — otherwise block[i] and measure[i] can desync
  // and per-block flags like `displayMode` are read off the wrong block.
  const { visualTop, visualBottom } = calculateHeaderFooterVisualBounds(
    nodesForMeasure,
    layoutMetrics,
    flowHeight,
    pageMetrics
  );

  return {
    nodes: nodesForMeasure,
    metrics: layoutMetrics,
    height: totalHeight,
    flowHeight,
    visualTop,
    visualBottom,
  };
}

// ============================================================================
// HF caret rect — used by both React and Vue adapters
// ============================================================================

/**
 * Viewport-relative caret rect for a persistent HF EditorView's selection
 * head. Resolves against the painter's `data-doc-from`/`data-doc-to` spans
 * inside `.layout-page-header` / `.layout-page-footer`. The same HF doc is
 * painted on every page (multi-page docs, titlePg), so this walks every
 * candidate host and picks the one whose spans bracket the PM head; falls
 * back to the first so empty paragraphs still resolve to a paragraph anchor.
 *
 * Public so the React + Vue adapters can share a single implementation
 * (`packages/{react,vue}` adapters used to carry byte-identical copies).
 *
 * @public
 */
type HfDomSnapshot = {
  host: HTMLElement;
  rId: string | null;
  spans: HTMLElement[];
  ranged: HTMLElement[];
};

// Resolved HF DOM snapshot cached between calls, keyed by section. Invalidated
// by the painter's `painter:painted` event (`invalidateHfDomCache()` below) so
// the snapshot is always at most one paint stale. Without this, every
// HF caret + selection-rect computation re-walked every span on every
// page, which on multi-page docs is O(pages × spans) per scroll-rAF.
//
// Keyed by section because the header and footer are distinct PM docs painted
// in distinct hosts. A single shared slot let the first match in DOM order
// (always the header) shadow the footer, so an active footer's caret/selection
// resolved against the header's spans (#671).
const hfDomCache: { header: HfDomSnapshot | null; footer: HfDomSnapshot | null } = {
  header: null,
  footer: null,
};

/**
 * Drop the cached HF host + span lists. Hosts/painters call this after
 * a repaint (or HF mode toggle) so the next caret / selection compute
 * re-walks the DOM. Public so adapters can call it from their painter
 * commit signal.
 *
 * @public
 */
export function invalidateHfDomCache(): void {
  hfDomCache.header = null;
  hfDomCache.footer = null;
}

function getHfDomSnapshot(
  section: 'header' | 'footer',
  doc: globalThis.Document,
  rId: string | null
): HfDomSnapshot | null {
  // The same HF doc is painted on every page (shared by `r:id`), so any painted
  // instance carries the right PM coords. But the caret/selection overlay must
  // render on the instance the user is actually editing — pick the host nearest
  // the viewport center. Always taking the first (page 1) host drew the overlay
  // on page 1 even while editing a header/footer on a later page, so the user
  // saw no caret or highlight where they were typing (#691 footer).
  // Scoping to `.layout-page-${section}` keeps the header and footer from
  // shadowing each other (#671).
  const allHosts = Array.from(doc.querySelectorAll<HTMLElement>(`.layout-page-${section}`));
  const hosts = rId ? allHosts.filter((candidate) => candidate.dataset.hfRId === rId) : allHosts;
  if (hosts.length === 0) return null;
  const win = doc.defaultView;
  const vpCenter = win ? win.innerHeight / 2 : 0;
  let host = hosts[0];
  let bestDist = Infinity;
  for (const h of hosts) {
    const r = h.getBoundingClientRect();
    const dist = Math.abs((r.top + r.bottom) / 2 - vpCenter);
    if (dist < bestDist) {
      bestDist = dist;
      host = h;
    }
  }
  // Reuse the cached span lists only when they belong to the same painted host
  // (and it's still live). The host changes as the user scrolls between pages,
  // so a section-only cache would keep resolving against the wrong instance.
  const cached = hfDomCache[section];
  if (cached && cached.host === host && cached.rId === rId && cached.host.isConnected)
    return cached;
  const spans = Array.from(host.querySelectorAll<HTMLElement>('span[data-doc-from][data-doc-to]'));
  const ranged = Array.from(host.querySelectorAll<HTMLElement>('[data-doc-from][data-doc-to]'));
  const snapshot = { host, rId, spans, ranged };
  hfDomCache[section] = snapshot;
  return snapshot;
}

/**
 * TODO(unify-hf-editing follow-up): this function duplicates the
 * span-walking + Range/TreeWalker logic in
 * `packages/react/src/components/DocxEditor/internals/domSelection.ts:getCaretFromDom`
 * (body). The body's helper is scoped to `.layout-page-content` via
 * `collectBodySpans`; we walk the same shape scoped to `.layout-page-header /
 * .layout-page-footer` here. Unification path:
 *   1. Add `findHfPmSpans` / `findHfEmptyRuns` mirrors next to the body
 *      ones in `packages/core/src/flow-model/collectBodySpans.ts`.
 *   2. Add `scope: 'body' | 'hf'` param to `getCaretFromDom` +
 *      `computeSelectionGeometryFromDom`; switch the helper internally.
 *   3. Move the (now scope-aware) helpers into core so React + Vue both
 *      call them.
 *   4. Delete this function and `readHfSelectionGeometry` —
 *      `DocxEditorPagedArea` calls `getCaretFromDom(scope: 'hf', ...)`.
 * Reviewer estimate: ~30 LOC net deletion + body↔HF parity for free
 * (lineHeight from `.layout-line` ancestor, empty-paragraph fallback
 * via `findBodyEmptyRuns`, etc.). Deferred because it's a multi-file
 * shape change that doesn't affect observable behavior.
 *
 * @public
 */
export function computeHfCaretRectFromView(
  view: EditorView,
  section: 'header' | 'footer',
  doc: globalThis.Document = globalThis.document,
  rId: string | null = null
): { top: number; left: number; height: number } | null {
  const sel = view.state.selection;
  if (!sel.empty) return null;
  const pmPos = sel.head;
  const snapshot = getHfDomSnapshot(section, doc, rId);
  if (!snapshot) return null;
  const { host, spans } = snapshot;
  for (const span of spans) {
    const start = Number(span.dataset.docFrom);
    const end = Number(span.dataset.docTo);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (pmPos >= start && pmPos <= end) {
      const range = host.ownerDocument.createRange();
      const walker = host.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let remaining = pmPos - start;
      let textNode = walker.nextNode() as Text | null;
      while (textNode) {
        const len = textNode.data.length;
        if (remaining <= len) {
          try {
            range.setStart(textNode, remaining);
            range.setEnd(textNode, remaining);
            const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
            if (rect && rect.height > 0) {
              return { top: rect.top, left: rect.left, height: rect.height };
            }
          } catch {
            // fall through
          }
          break;
        }
        remaining -= len;
        textNode = walker.nextNode() as Text | null;
      }
      const spanRect = span.getBoundingClientRect();
      const ratio = (pmPos - start) / Math.max(1, end - start);
      return {
        top: spanRect.top,
        left: spanRect.left + spanRect.width * ratio,
        height: spanRect.height,
      };
    }
  }
  // Exact paragraph/line anchor at `pmPos` (when the painter emits one).
  // `pmPos` is interpolated into a selector, so it must be an integer and
  // nothing else — same guard as the body's `findBodyPmAnchor`.
  const anchor = Number.isInteger(pmPos)
    ? host.querySelector<HTMLElement>(`[data-doc-from="${pmPos}"]`)
    : null;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    return { top: rect.top, left: rect.left + 1, height: rect.height || 16 };
  }

  // Fallback for empty paragraphs / line-ends: walk every painted element
  // that carries `[data-doc-from][data-doc-to]` and find the one whose
  // range brackets `pmPos`. Use its rect — left edge for an empty
  // paragraph (cursor at the paragraph's start), right edge if the cursor
  // is at the paragraph's end. Without this, hitting Enter into a new
  // empty paragraph hid the caret entirely until the user typed.
  const ranged = snapshot.ranged;
  let bestEl: HTMLElement | null = null;
  let bestSpan = Infinity;
  for (const el of ranged) {
    const start = Number(el.dataset.docFrom);
    const end = Number(el.dataset.docTo);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (pmPos < start || pmPos > end) continue;
    const span = end - start;
    if (span < bestSpan) {
      bestSpan = span;
      bestEl = el;
    }
  }
  if (bestEl) {
    const rect = bestEl.getBoundingClientRect();
    const end = Number(bestEl.dataset.docTo);
    const atEnd = pmPos >= end;
    return {
      top: rect.top,
      left: atEnd ? rect.right : rect.left + 1,
      height: rect.height || 16,
    };
  }

  // LayoutCursor sits past every painted element's `[docFrom, docTo]` range —
  // typically because the cursor is at `doc.content.size` (end of last
  // paragraph). Find the painted element with the largest `docFrom` that
  // is still `<= pmPos` and snap the caret to its trailing edge. This is
  // a much better visual than "top-left of host" when the user has just
  // hit Enter to add a paragraph and is now sitting at the end of the
  // content.
  let trailingEl: HTMLElement | null = null;
  let trailingStart = -Infinity;
  for (const el of ranged) {
    const start = Number(el.dataset.docFrom);
    if (!Number.isFinite(start)) continue;
    if (start > pmPos) continue;
    if (start > trailingStart) {
      trailingStart = start;
      trailingEl = el;
    }
  }
  if (trailingEl) {
    const rect = trailingEl.getBoundingClientRect();
    return { top: rect.top, left: rect.right, height: rect.height || 16 };
  }

  // Last resort: anchor at the host's top-left so the caret is at least
  // visible while in HF edit mode. Better than disappearing.
  const hostRect = host.getBoundingClientRect();
  return {
    top: hostRect.top + 2,
    left: hostRect.left + 2,
    height: 16,
  };
}

/**
 * Selection-rect set for a non-empty HF selection, projected against the
 * painted HF spans. Mirror of `computeSelectionGeometryFromDom` but scoped to
 * `.layout-page-header` / `.layout-page-footer` instead of the body. Used
 * so the painter draws a visible highlight when the user drag-selects
 * inside a header/footer in edit mode.
 *
 * Returns viewport-relative `{top, left, width, height}` rects. Empty
 * array when selection is collapsed or no painted spans overlap the range.
 *
 * @public
 */
export function readHfSelectionGeometry(
  view: EditorView,
  section: 'header' | 'footer',
  doc: globalThis.Document = globalThis.document,
  rId: string | null = null
): Array<{ top: number; left: number; width: number; height: number }> {
  const sel = view.state.selection;
  if (sel.empty) return [];
  const from = sel.from;
  const to = sel.to;
  const out: Array<{ top: number; left: number; width: number; height: number }> = [];

  // Reuse the cached HF DOM snapshot for this section. Every painted HF host
  // for the section shares the same PM coord space (only one HF doc, painted N
  // times for the N pages), so a single host's spans suffice for selection
  // rects.
  const snapshot = getHfDomSnapshot(section, doc, rId);
  if (!snapshot) return out;
  const { host, spans } = snapshot;
  for (const spanEl of spans) {
    const docFrom = Number(spanEl.dataset.docFrom);
    const docTo = Number(spanEl.dataset.docTo);
    if (!Number.isFinite(docFrom) || !Number.isFinite(docTo)) continue;
    if (docTo <= from || docFrom >= to) continue;

    // Tab spans: full-span highlight.
    if (spanEl.classList.contains('layout-run-tab')) {
      const rect = spanEl.getBoundingClientRect();
      out.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
      continue;
    }

    let textNode: Text | null = null;
    if (spanEl.firstChild?.nodeType === Node.TEXT_NODE) {
      textNode = spanEl.firstChild as Text;
    } else if (
      spanEl.firstChild?.nodeType === Node.ELEMENT_NODE &&
      (spanEl.firstChild as HTMLElement).tagName === 'A' &&
      spanEl.firstChild.firstChild?.nodeType === Node.TEXT_NODE
    ) {
      textNode = spanEl.firstChild.firstChild as Text;
    }
    if (!textNode) continue;

    const startChar = Math.max(0, from - docFrom);
    const endChar = Math.min(textNode.length, to - docFrom);
    if (startChar >= endChar) continue;

    const range = host.ownerDocument.createRange();
    range.setStart(textNode, startChar);
    range.setEnd(textNode, endChar);
    for (const rect of Array.from(range.getClientRects())) {
      out.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    }
  }

  return out;
}
