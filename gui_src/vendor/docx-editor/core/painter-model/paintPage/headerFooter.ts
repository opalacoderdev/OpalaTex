/**
 * Header / footer rendering for paintPage.
 *
 * Owns `renderHeaderFooterContent` — the mini-flow that lays paragraphs and
 * tables inside a header/footer container (separate from the body flow) —
 * plus the floating-image and floating-table positioning helpers used by
 * that flow. Coordinates returned by `resolveHeaderFooterFloatingTablePosition`
 * are relative to the HF container's flow origin (`layout.flowTop`/`flowLeft`)
 * so callers can drop them into `style.top`/`style.left`.
 */

import type {
  ContentNode,
  LayoutMetrics,
  ParagraphBlock,
  ParagraphFragment,
  TableBlock,
  TableFragment,
  ImageFragment,
  TextBoxFragment,
} from '../../pagination-model/types';
import { assertExhaustiveContentNode } from '../../pagination-model/types';
import { isFloatingTextBoxBlock } from '../../pagination-model/textBoxFlow';
import { getParagraphRevisionMetadata, paintParagraphFragment } from '../renderParagraph';
import { getTableRevisionBarSpans, paintTableFragment } from '../renderTable';
import { applyImageRevisionAttrs, getImageRevisionData, paintImageFragment } from '../renderImage';
import { paintTextBoxFragment } from '../renderTextBox';
import { sanitizeImageSrc } from '../../utils/sanitizeImageSrc';
import type { RenderContext, RenderPageOptions } from '../paintPage';
import {
  pageGeometryFromPage,
  resolveAnchoredObjectPosition,
  type AnchoredObjectPositionInput,
} from '../anchoredObjectPosition';
import { RevisionBarCollector } from '../revisionIndicators';

/**
 * Header/footer content for rendering
 */
export interface HeaderFooterContent {
  /** Flow nodes for the header/footer content. */
  nodes: ContentNode[];
  /** Measurements for the nodes. */
  metrics: LayoutMetrics[];
  /** Total height of the content (in-flow stack incl. floating nodes). */
  height: number;
  /**
   * In-flow band height: the height of strictly in-flow content
   * (paragraphs, tables, inline images/text boxes), EXCLUDING anchored /
   * floating objects. This is what grows the header/footer band and pushes
   * the body margin, mirroring Word: a page/margin-anchored shape (e.g. a
   * full-page letterhead in a header) is positioned independently and does
   * NOT push body text down. Use this — not `height`/`visualBottom` — for
   * margin extension. Falls back to `height` when undefined.
   */
  flowHeight?: number;
  /** Top-most visual extent relative to the nominal flow origin. */
  visualTop?: number;
  /** Bottom-most visual extent relative to the nominal flow origin. */
  visualBottom?: number;
}

/**
 * Header/footer render content resolved for one document section.
 */
export interface SectionHeaderFooterContent {
  /** Default header for pages in this section. */
  headerContent?: HeaderFooterContent;
  /** Default footer for pages in this section. */
  footerContent?: HeaderFooterContent;
  /** First-page header for this section when titlePg is set. */
  firstPageHeaderContent?: HeaderFooterContent;
  /** First-page footer for this section when titlePg is set. */
  firstPageFooterContent?: HeaderFooterContent;
  /** Whether this section uses a distinct first page header/footer. */
  titlePg?: boolean;
  /** Distance from page top to header content for this section. */
  headerDistance?: number;
  /** Distance from page bottom to footer content for this section. */
  footerDistance?: number;
  /** OOXML page borders for this section. */
  pageBorders?: RenderPageOptions['pageBorders'];
}

export interface HeaderFooterLayoutInfo {
  flowTop: number;
  flowLeft: number;
  contentWidth: number;
  pageWidth: number;
  pageHeight: number;
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

function getPositionAlignment(
  position: { align?: string; alignment?: string } | undefined
): string | undefined {
  return position?.align ?? position?.alignment;
}

type HeaderFooterAnchorPosition = {
  horizontal?: {
    relativeTo?: string;
    posOffset?: number;
    align?: string;
    alignment?: string;
  };
  vertical?: {
    relativeTo?: string;
    posOffset?: number;
    align?: string;
    alignment?: string;
  };
};

function normalizeHeaderFooterAnchorPosition(
  position: HeaderFooterAnchorPosition
): AnchoredObjectPositionInput['position'] {
  const normalizeAxis = (
    axis:
      | {
          relativeTo?: string;
          posOffset?: number;
          align?: string;
          alignment?: string;
        }
      | undefined
  ): { relativeTo?: string; posOffset?: number; align?: string } | undefined =>
    axis
      ? {
          relativeTo: axis.relativeTo,
          posOffset: axis.posOffset,
          align: getPositionAlignment(axis),
        }
      : undefined;

  return {
    horizontal: normalizeAxis(position.horizontal),
    vertical: normalizeAxis(position.vertical),
  };
}

/**
 * Resolve a header/footer anchor through the same content-relative geometry
 * used by the body painter, then translate it to the HF flow container.
 */
function resolveHeaderFooterAnchorPosition(
  width: number,
  height: number,
  paragraphY: number,
  position: HeaderFooterAnchorPosition,
  layout: HeaderFooterLayoutInfo
): { left: number; top: number } {
  const geometry = pageGeometryFromPage({
    size: { w: layout.pageWidth, h: layout.pageHeight },
    margins: layout.margins,
  });
  const paragraphContentY = layout.flowTop + paragraphY - layout.margins.top;
  const resolved = resolveAnchoredObjectPosition(
    {
      width,
      height,
      position: normalizeHeaderFooterAnchorPosition(position),
    },
    paragraphContentY,
    layout.contentWidth,
    geometry
  );

  return {
    left: layout.margins.left + resolved.x - layout.flowLeft,
    top: layout.margins.top + resolved.y - layout.flowTop,
  };
}

function resolveHeaderFooterFloatTop(
  floatImg: {
    height: number;
    paragraphY: number;
    position: {
      vertical?: { relativeTo?: string; posOffset?: number; align?: string; alignment?: string };
    };
  },
  layout: HeaderFooterLayoutInfo
): number {
  return resolveHeaderFooterAnchorPosition(
    0,
    floatImg.height,
    floatImg.paragraphY,
    floatImg.position,
    layout
  ).top;
}

/**
 * Resolve the CSS `left` (px) for an anchored object (image or text box) in a
 * header/footer, honoring `wp:positionH` (relativeTo page/margin, align
 * left/center/right, or posOffset). Shared by floating images and text boxes so
 * a page-centered text box in the header lands centered like Word, not pinned
 * to the left.
 */
export function resolveHeaderFooterFloatLeft(
  width: number,
  h: { relativeTo?: string; posOffset?: number; align?: string; alignment?: string } | undefined,
  layout: HeaderFooterLayoutInfo
): string {
  const { left } = resolveHeaderFooterAnchorPosition(width, 0, 0, { horizontal: h }, layout);
  return left ? `${left}px` : '0';
}

function applyHeaderFooterFloatHorizontalPosition(
  img: HTMLElement,
  floatImg: {
    width: number;
    position: {
      horizontal?: { relativeTo?: string; posOffset?: number; align?: string; alignment?: string };
    };
  },
  layout: HeaderFooterLayoutInfo
): void {
  img.style.left = resolveHeaderFooterFloatLeft(
    floatImg.width,
    floatImg.position.horizontal,
    layout
  );
}

/**
 * Resolve the (left, top) position for a floating table inside a header/
 * footer container, per ECMA-376 §17.4.57. The table's `floating.tblpX/tblpY`
 * are already in pixels (parser converted from twips); `horzAnchor`/
 * `vertAnchor` decide whether the offset is relative to the page, the
 * margins, or the surrounding text/column. Coordinates returned are
 * relative to the HF container's flow origin (`layout.flowTop` /
 * `layout.flowLeft`) so the caller can drop them straight into
 * `style.top` / `style.left`.
 */
export function resolveHeaderFooterFloatingTablePosition(
  floating: NonNullable<TableBlock['floating']>,
  layout: HeaderFooterLayoutInfo
): { left: number; top: number } {
  // Vertical: tblpY relative to vertAnchor.
  let top = floating.tblpY ?? 0;
  if (floating.vertAnchor === 'page') {
    top -= layout.flowTop;
  } else if (floating.vertAnchor === 'margin') {
    top += layout.margins.top - layout.flowTop;
  }

  // Horizontal: tblpX relative to horzAnchor.
  let left = floating.tblpX ?? 0;
  if (floating.horzAnchor === 'page') {
    left -= layout.flowLeft;
  } else if (floating.horzAnchor === 'margin') {
    left += layout.margins.left - layout.flowLeft;
  }

  return { left, top };
}

/**
 * Render header or footer content
 */
export function renderHeaderFooterContent(
  content: HeaderFooterContent,
  context: RenderContext,
  config: RenderPageOptions,
  layout: HeaderFooterLayoutInfo
): HTMLElement {
  const doc = config.document ?? document;
  const containerEl = doc.createElement('div');
  containerEl.style.position = 'relative';

  // Use content width from context if available, otherwise default to reasonable width
  const contentWidth = context.contentWidth ?? 600;

  // Collect floating images to render separately, with their paragraph's Y position
  const floatingImages: Array<{
    src: string;
    width: number;
    height: number;
    alt?: string;
    isInsertion?: boolean;
    isDeletion?: boolean;
    changeAuthor?: string;
    changeDate?: string;
    changeRevisionId?: number;
    paragraphY: number; // Y position of the containing paragraph
    position: {
      horizontal?: {
        relativeTo?: string;
        posOffset?: number;
        align?: string;
        alignment?: string;
      };
      vertical?: {
        relativeTo?: string;
        posOffset?: number;
        align?: string;
        alignment?: string;
      };
    };
  }> = [];
  const revisionBars = new RevisionBarCollector();

  let cursorY = 0;

  for (let i = 0; i < content.nodes.length; i++) {
    const block = content.nodes[i];
    const measure = content.metrics[i];
    if (!block || !measure) continue;

    if (block.kind === 'paragraph') {
      if (measure.kind !== 'paragraph') continue;
      const paragraphBlock = block;
      const paragraphMetrics = measure;
      const blockSpacingRulesBefore = paragraphBlock.attrs?.spacing?.before ?? 0;

      // Track the Y position where this paragraph starts
      const paragraphStartY = cursorY;

      // Extract floating images and filter them from runs
      const inlineRuns: typeof paragraphBlock.runs = [];
      for (const run of paragraphBlock.runs) {
        if (run.kind === 'image' && 'position' in run && run.position) {
          const imgRun = run as {
            kind: 'image';
            src: string;
            width: number;
            height: number;
            alt?: string;
            position: {
              horizontal?: {
                relativeTo?: string;
                posOffset?: number;
                align?: string;
                alignment?: string;
              };
              vertical?: {
                relativeTo?: string;
                posOffset?: number;
                align?: string;
                alignment?: string;
              };
            };
          };
          floatingImages.push({
            src: imgRun.src,
            width: imgRun.width,
            height: imgRun.height,
            alt: imgRun.alt,
            isInsertion: (run as { isInsertion?: boolean }).isInsertion,
            isDeletion: (run as { isDeletion?: boolean }).isDeletion,
            changeAuthor: (run as { changeAuthor?: string }).changeAuthor,
            changeDate: (run as { changeDate?: string }).changeDate,
            changeRevisionId: (run as { changeRevisionId?: number }).changeRevisionId,
            paragraphY: paragraphStartY, // Store where this paragraph starts
            position: imgRun.position,
          });
        } else {
          // Keep non-floating runs for inline rendering
          inlineRuns.push(run);
        }
      }

      // Create a modified paragraph block without floating images
      const inlineBlock: ParagraphBlock = {
        ...paragraphBlock,
        runs: inlineRuns,
      };

      // Create a synthetic fragment for the paragraph. `docFrom` / `docTo`
      // are essential for HF caret resolution — without them the painter
      // emits no `data-pm-*` markers on this paragraph wrapper, and empty
      // paragraphs (or cursors at line boundaries) lose any anchor at all.
      // `computeHfCaretRectFromView`'s fallback chain depends on these.
      const syntheticFragment: ParagraphFragment = {
        kind: 'paragraph',
        nodeId: paragraphBlock.id,
        x: 0,
        y: cursorY + blockSpacingRulesBefore,
        width: contentWidth,
        height: paragraphMetrics.totalHeight,
        fromLine: 0,
        toLine: paragraphMetrics.lines.length,
        docFrom: paragraphBlock.docFrom,
        docTo: paragraphBlock.docTo,
      };

      // Render paragraph fragment (with floating images filtered out). The
      // HF context positions nodes absolutely within its own container,
      // stacking vertically via `cursorY` — `paragraphMetrics.totalHeight`
      // already includes `spaceBefore` / `spaceAfter`. Pass `positioning:
      // 'absolute'` so the renderer applies that mode itself instead of the
      // caller having to flip its inline style after the fact (#379).
      const fragEl = paintParagraphFragment(
        syntheticFragment,
        inlineBlock,
        paragraphMetrics,
        { ...context, positioning: 'absolute' },
        {
          document: doc,
          inlineImageRevisionBars: {
            collector: revisionBars,
            originTop: syntheticFragment.y,
            clipTop: syntheticFragment.y,
            clipBottom: syntheticFragment.y + syntheticFragment.height,
          },
        }
      );
      const paragraphRevision = getParagraphRevisionMetadata(paragraphBlock);
      if (paragraphRevision) {
        revisionBars.register({
          top: syntheticFragment.y,
          height: syntheticFragment.height,
          kind: paragraphRevision.kind,
          ...paragraphRevision.metadata,
        });
      }

      fragEl.style.top = `${cursorY + blockSpacingRulesBefore}px`;
      fragEl.style.left = '0';
      fragEl.style.width = `${contentWidth}px`;

      containerEl.appendChild(fragEl);
      cursorY += paragraphMetrics.totalHeight;
    } else if (block.kind === 'table') {
      if (measure.kind !== 'table') continue;
      // HF tables don't paginate, so the synthetic fragment covers all rows.
      const syntheticFragment: TableFragment = {
        kind: 'table',
        nodeId: block.id,
        x: 0,
        y: cursorY,
        width: measure.totalWidth,
        height: measure.totalHeight,
        fromRow: 0,
        toRow: measure.rows.length,
        docFrom: block.docFrom,
        docTo: block.docTo,
      };
      const floatingPosition = block.floating
        ? resolveHeaderFooterFloatingTablePosition(block.floating, layout)
        : null;
      const fragEl = paintTableFragment(
        syntheticFragment,
        block,
        measure,
        { ...context, positioning: 'absolute' },
        {
          document: doc,
          revisionBars: {
            collector: revisionBars,
            originTop: floatingPosition?.top ?? syntheticFragment.y,
          },
        }
      );
      for (const span of getTableRevisionBarSpans(
        syntheticFragment,
        block,
        measure,
        floatingPosition?.top ?? syntheticFragment.y
      )) {
        revisionBars.register(span);
      }

      // Floating tables (`<w:tblpPr>`) opt out of the cursorY flow. They
      // anchor at (tblpX, tblpY) relative to the page/margin/column per
      // ECMA-376 §17.4.57 and don't advance cursorY (#382). Inline tables
      // keep their cursorY-based stacking.
      if (floatingPosition) {
        fragEl.style.top = `${floatingPosition.top}px`;
        fragEl.style.left = `${floatingPosition.left}px`;
        containerEl.appendChild(fragEl);
        // Floating tables do NOT advance cursorY — surrounding HF nodes
        // flow as if the table weren't there. Word renders text behind
        // floating tables when no wrap behavior is requested; we match.
      } else {
        // Inline placement: top/left stack within the HF container at cursorY.
        fragEl.style.top = `${cursorY}px`;
        fragEl.style.left = '0';
        containerEl.appendChild(fragEl);
        cursorY += measure.totalHeight;
      }
    } else if (block.kind === 'image') {
      if (measure.kind !== 'image') continue;
      // Block-level images stack in the HF flow like paragraphs/tables.
      const syntheticFragment: ImageFragment = {
        kind: 'image',
        nodeId: block.id,
        x: 0,
        y: cursorY,
        width: measure.width,
        height: measure.height,
        docFrom: block.docFrom,
        docTo: block.docTo,
      };
      const fragEl = paintImageFragment(
        syntheticFragment,
        block,
        measure,
        { ...context, positioning: 'absolute' },
        { document: doc }
      );
      fragEl.style.top = `${cursorY}px`;
      fragEl.style.left = '0';
      containerEl.appendChild(fragEl);
      const imageRevision = getImageRevisionData(block);
      if (imageRevision) {
        revisionBars.register({
          top: cursorY,
          height: measure.height,
          kind: imageRevision.kind,
          ...imageRevision.metadata,
        });
      }
      cursorY += measure.height;
    } else if (block.kind === 'textBox') {
      if (measure.kind !== 'textBox') continue;
      // Text boxes stack in the HF flow. headerFooterLayout already reserves
      // their height; without this branch they were measured but never
      // painted, so they showed in the inline editor but not the page view.
      const syntheticFragment: TextBoxFragment = {
        kind: 'textBox',
        nodeId: block.id,
        x: 0,
        y: cursorY,
        width: measure.width,
        height: measure.height,
        docFrom: block.docFrom,
        docTo: block.docTo,
      };
      const fragEl = paintTextBoxFragment(
        syntheticFragment,
        block,
        measure,
        { ...context, positioning: 'absolute' },
        { document: doc }
      );
      // Every non-inline text box uses the same positionV resolver as floating
      // images. This includes topAndBottom boxes (`displayMode: block`): the
      // wrap mode affects surrounding body text, but the drawing itself remains
      // anchored and positioned out of the header/footer story flow.
      const positioned = isFloatingTextBoxBlock(block);
      const textBoxTop = positioned
        ? resolveHeaderFooterFloatTop(
            {
              height: measure.height,
              paragraphY: cursorY,
              position: block.position ?? {},
            },
            layout
          )
        : cursorY;
      fragEl.style.top = `${textBoxTop}px`;
      // Honor the anchor's horizontal position (e.g. centered relative to the
      // page) instead of pinning the box to the left.
      fragEl.style.left = resolveHeaderFooterFloatLeft(
        measure.width,
        block.position?.horizontal,
        layout
      );
      containerEl.appendChild(fragEl);
      // Positioned text boxes (square/tight/through/behind/inFront and
      // topAndBottom) do NOT advance the flow — following HF content starts at
      // the same story cursor. This mirrors floating tables and keeps the
      // painter aligned with `flowHeight`, which excludes these boxes.
      if (!positioned) {
        cursorY += measure.height;
      }
    } else if (
      block.kind === 'sectionBreak' ||
      block.kind === 'pageBreak' ||
      block.kind === 'columnBreak'
    ) {
      // Section/page/column breaks carry no rendering in the header/footer
      // flow — headers and footers reflow per page, so a break has no meaning.
    } else {
      // Exhaustiveness guard: every ContentNode variant must be handled above.
      // A new variant fails the typecheck here instead of silently vanishing
      // from the header/footer page view.
      assertExhaustiveContentNode(block, 'renderHeaderFooterContent');
    }
  }

  // Render floating images with absolute positioning
  for (const floatImg of floatingImages) {
    const wrapper = doc.createElement('div');
    wrapper.className = 'layout-header-footer-floating-image';
    // Keep a semantic metadata wrapper without introducing a containing block:
    // the painted <img> itself owns the historical absolute-position contract.
    wrapper.style.display = 'contents';
    const img = doc.createElement('img');
    const imageSrc = sanitizeImageSrc(floatImg.src);
    if (imageSrc) img.src = imageSrc;
    img.width = floatImg.width;
    img.height = floatImg.height;
    if (floatImg.alt) img.alt = floatImg.alt;

    img.style.position = 'absolute';
    img.style.display = 'block';
    img.style.pointerEvents = 'auto';
    // Header/footer images can intentionally extend beyond the text area.
    // Override global img resets (for example max-width: 100%) so the DOCX
    // anchor extent is honored instead of shrinking to the header/footer box.
    img.style.width = `${floatImg.width}px`;
    img.style.height = `${floatImg.height}px`;
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';

    applyHeaderFooterFloatHorizontalPosition(img, floatImg, layout);
    const top = resolveHeaderFooterFloatTop(floatImg, layout);
    img.style.top = `${top}px`;
    const imageRevision = getImageRevisionData(floatImg);
    if (imageRevision) {
      // The display:contents wrapper retains only the class needed by the
      // descendant outline CSS. Sidebar identity belongs to the positioned
      // image, whose rect is meaningful; duplicate wrapper metadata would win
      // query order and then be deduped despite its zero-sized rect.
      wrapper.classList.add(imageRevision.kind === 'ins' ? 'docx-insertion' : 'docx-deletion');
      applyImageRevisionAttrs(img, floatImg);
      revisionBars.register({
        top,
        height: floatImg.height,
        kind: imageRevision.kind,
        ...imageRevision.metadata,
      });
    }

    wrapper.appendChild(img);
    containerEl.appendChild(wrapper);
  }

  const revisionOverlay = revisionBars.paint(doc);
  if (revisionOverlay) {
    containerEl.appendChild(revisionOverlay);
  }

  return containerEl;
}
