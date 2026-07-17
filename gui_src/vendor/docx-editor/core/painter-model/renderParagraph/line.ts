/**
 * Line-level rendering.
 *
 * Owns `paintLine` and its helpers: slicing the paragraph's runs to the
 * line's character range, justify decisions, per-line floating margins,
 * tab-width calculation through the tabMetrics (explicit stops + default
 * intervals), inline image dedup, and field-value substitution width math.
 */

import type {
  ParagraphBlock,
  MeasuredLine,
  Run,
  ImageRun,
  LineBreakRun,
  TabMark,
} from '../../pagination-model/types';
import type { RenderContext } from '../paintPage';
import { isFloatingImageRun } from '../floatingImageFlow';
import {
  calculatePositionalTabWidth,
  calculateTabWidth,
  type TabRuler,
  type TabMark as TabCalcStop,
} from '../../prosemirror/utils/tabMetrics';
import { measureTextWidth, resolveFontStyle } from '../../flow-model/metrics/textMetrics';
import {
  PARAGRAPH_CLASS_NAMES,
  getImagePaintGeometry,
  isTextRun,
  isTabRun,
  isImageRun,
  isLineBreakRun,
  isFieldRun,
} from './shared';
import {
  paintTextRun,
  paintTabRun,
  paintImageRun,
  paintLineBreakRun,
  paintFieldRun,
  paintRun,
  applyPmPositions,
} from './runs';

/**
 * Slice runs for a specific line
 *
 * @param block - The paragraph block
 * @param line - The line measurement
 * @returns Array of runs for this line
 */
export function runsWithinLine(block: ParagraphBlock, line: MeasuredLine): Run[] {
  const result: Run[] = [];
  const runs = block.runs;

  for (let runIndex = line.fromRun; runIndex <= line.toRun; runIndex++) {
    const run = runs[runIndex];
    if (!run) continue;

    if (isTextRun(run)) {
      // Get the character range for this run
      const startChar = runIndex === line.fromRun ? line.fromChar : 0;
      const endChar = runIndex === line.toRun ? line.toChar : run.text.length;

      // Slice the text if needed
      if (startChar > 0 || endChar < run.text.length) {
        const slicedText = run.text.slice(startChar, endChar);
        result.push({
          ...run,
          text: slicedText,
          docFrom: run.docFrom !== undefined ? run.docFrom + startChar : undefined,
          docTo: run.docFrom !== undefined ? run.docFrom + endChar : undefined,
        });
      } else {
        result.push(run);
      }
    } else {
      // Non-text runs are included as-is
      result.push(run);
    }
  }

  return result;
}

/**
 * Options for rendering a line with justify support
 */
interface RenderLineOptions {
  /** Available width for the line (content area width minus indentation) */
  availableWidth: number;
  /** Whether this is the last line of the paragraph */
  isLastLine: boolean;
  /** Whether this is the first line of the paragraph */
  isFirstLine: boolean;
  /** Whether the paragraph ends with a line break */
  paragraphEndsWithLineBreak: boolean;
  /** Tab stops from paragraph attributes */
  tabMarks?: TabMark[];
  /** Render context for field substitution */
  context?: RenderContext;
  /** Left indent in pixels */
  leftIndentPx?: number;
  /** First line indent in pixels (positive) or hanging indent (negative) */
  firstLineIndentPx?: number;
  /** Line-specific floating image margins (calculated per-line based on Y overlap) */
  floatingMargins?: { leftMargin: number; rightMargin: number };
  /** Track inline image runs already rendered in this paragraph fragment to prevent duplicates */
  renderedInlineImageKeys?: Set<string>;
  /**
   * Rightmost x where inline content may render, in content-area coords. Used
   * by the right-tab anchor; passed in directly (rather than recomposed from
   * `leftIndentPx + availableWidth`) because `availableWidth` excludes the
   * hung-out region for some inputs and would drift.
   */
  lineRightEdgePx?: number;
  /** Reports each inline image only when this line actually appends it. */
  onInlineImageRendered?: (run: ImageRun, span: InlineImagePaintSpan) => void;
}

export interface InlineImagePaintSpan {
  top: number;
  height: number;
}

function reportInlineImageSpan(
  run: ImageRun,
  line: MeasuredLine,
  runIndex: number,
  imageOnly: boolean,
  callback: RenderLineOptions['onInlineImageRendered']
): void {
  if (!callback) return;

  const rendersAsBlock = run.displayMode === 'block' || run.wrapType === 'topAndBottom';
  const geometry = getImagePaintGeometry(run, {
    paintedWidth: rendersAsBlock ? run.width : (line.atomAdvances?.[runIndex] ?? run.width),
    defaultMargin: rendersAsBlock ? 6 : 0,
  });
  const imageTop = imageOnly
    ? (line.lineHeight - geometry.boxHeight - geometry.marginTop - geometry.marginBottom) / 2 +
      geometry.marginTop
    : line.lineHeight - geometry.marginBottom - geometry.boxHeight;
  const visibleTop = Math.max(0, imageTop);
  const visibleBottom = Math.min(line.lineHeight, imageTop + geometry.boxHeight);
  if (visibleBottom > visibleTop) {
    callback(run, { top: visibleTop, height: visibleBottom - visibleTop });
  }
}

/**
 * Map a paragraph/image alignment to the `justify-content` value used when a
 * line is laid out as a flex row. `left`, `justify`, and unset all pack left.
 */
function alignToJustifyContent(align: string | undefined): string {
  return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
}

/**
 * Horizontal alignment for an image alone on a line. An anchored image
 * (`wp:positionH`, i.e. `position.horizontal` present) is positioned by its OWN
 * alignment, independent of the paragraph's `jc` — defaulting to left like Word,
 * NOT the paragraph alignment (which would wrongly center a left-anchored header
 * logo whose paragraph happens to be centered). An inline image with no anchor
 * follows the paragraph alignment. (issue #777)
 */
export function resolveImageLineAlign(
  imageRun: ImageRun,
  paragraphAlignment: 'left' | 'center' | 'right' | 'justify' | undefined
): string | undefined {
  const horizontal = imageRun.position?.horizontal;
  return horizontal ? (horizontal.align ?? 'left') : paragraphAlignment;
}

/**
 * Build a stable key for an inline image run.
 * PM positions are preferred because they uniquely identify the source node.
 */
function getInlineImageRunKey(run: ImageRun): string {
  return [
    run.docFrom ?? 'no-start',
    run.docTo ?? 'no-end',
    run.src,
    run.width,
    run.height,
    run.displayMode ?? 'inline',
    run.wrapType ?? 'none',
  ].join('|');
}

/**
 * Convert layout engine TabMark to tab calculator TabMark format
 */
function convertTabMarkToCalc(stop: TabMark): TabCalcStop {
  return {
    val: stop.val,
    pos: stop.pos,
    leader: stop.leader as TabCalcStop['leader'],
  };
}

/**
 * Get the text content immediately following a tab run in the runs array
 * Used for center/end/decimal tab alignment calculations
 */
function getTextAfterTab(runs: Run[], tabRunIndex: number, context?: RenderContext): string {
  let text = '';
  for (let i = tabRunIndex + 1; i < runs.length; i++) {
    const run = runs[i];
    if (isTextRun(run)) {
      text += run.text;
    } else if (isFieldRun(run)) {
      // Resolve field values for TOC page numbers
      if (run.fieldType === 'PAGE' && context) {
        text += String(context.pageNumber);
      } else if (run.fieldType === 'NUMPAGES' && context) {
        text += String(context.totalPages);
      } else {
        text += run.fallback ?? '';
      }
    } else if (isTabRun(run) || isLineBreakRun(run)) {
      // Stop at next tab or line break
      break;
    }
  }
  return text;
}

/**
 * Sub-pixel tolerance when comparing canvas-measured widths against the DOM's
 * actual right edge. Without this, accumulated rounding from `measureText`
 * vs. browser layout can leave a right-anchored tab one pixel short, and the
 * flex anchor fails to trigger when it should.
 */
const RIGHT_EDGE_EPSILON_PX = 0.5;

/**
 * Sum the pixel widths of runs that follow a tab, up to the next tab or line
 * break. Measures per-run so the tab clamp reserves exact space when trailing
 * runs use a different font/size from the default (e.g. TOC page numbers).
 */
function measureFollowingContentWidth(
  runs: Run[],
  tabRunIndex: number,
  context?: RenderContext
): number {
  let width = 0;
  for (let i = tabRunIndex + 1; i < runs.length; i++) {
    const run = runs[i];
    if (isTabRun(run) || isLineBreakRun(run)) break;
    if (isTextRun(run)) {
      width += measureTextWidth(run.text || '', resolveFontStyle(run));
    } else if (isFieldRun(run)) {
      let fieldText: string;
      if (run.fieldType === 'PAGE' && context) {
        fieldText = String(context.pageNumber);
      } else if (run.fieldType === 'NUMPAGES' && context) {
        fieldText = String(context.totalPages);
      } else {
        fieldText = run.fallback ?? '';
      }
      width += measureTextWidth(fieldText, resolveFontStyle(run));
    } else if (isImageRun(run) && !isFloatingImageRun(run)) {
      // Floating images render at the page level — they contribute 0 inline
      // width, so don't count them in the right-edge clamp budget.
      width += run.width || 0;
    }
  }
  return width;
}

/**
 * Measure unformatted helper text used only for a tab's decimal probe.
 */
function measureDefaultText(text: string): number {
  return measureTextWidth(text, resolveFontStyle(undefined));
}

/**
 * Render a single line
 *
 * @param block - The paragraph block
 * @param line - The line measurement
 * @param alignment - Text alignment
 * @param doc - Document to create elements in
 * @param config - Additional config for justify calculation
 * @returns The line DOM element
 */
export function paintLine(
  block: ParagraphBlock,
  line: MeasuredLine,
  alignment: 'left' | 'center' | 'right' | 'justify' | undefined,
  doc: Document,
  config?: RenderLineOptions
): HTMLElement {
  const lineEl = doc.createElement('div');
  lineEl.className = PARAGRAPH_CLASS_NAMES.line;

  // Apply line height
  lineEl.style.height = `${line.lineHeight}px`;
  lineEl.style.lineHeight = `${line.lineHeight}px`;

  // Get runs for this line
  const runsForLine = runsWithinLine(block, line);

  // Image-only line: vAlign-center the image inside the line's box. Without
  // this, vertical-align math (baseline / middle / top) all leave the image
  // either flush with one edge or overflowing — the line's ascent/descent
  // can't be reconciled with parent-font baseline rules well enough to
  // center automatically. Flex centering is unambiguous.
  //
  // The flex container also needs `justify-content` to honor the image's
  // horizontal alignment. Two paths feed it:
  //   1. `pPr/jc` on the containing paragraph — we get this via `alignment`.
  //   2. The image's own `wp:positionH` `wp:align` (e.g. demo.docx centers
  //      its topAndBottom green dot via `relativeFrom="page" align="center"`
  //      and leaves the paragraph alignment untouched).
  // Image-level alignment wins when present — it's the more specific signal
  // from OOXML, and it's the only signal Word writes for that kind of
  // anchored layout.
  const imageOnlyLine = runsForLine.length === 1 && isImageRun(runsForLine[0]);
  if (imageOnlyLine) {
    const imageRun = runsForLine[0] as ImageRun;
    const effectiveAlign = resolveImageLineAlign(imageRun, alignment);
    lineEl.style.display = 'flex';
    lineEl.style.alignItems = 'center';
    lineEl.style.justifyContent = alignToJustifyContent(effectiveAlign);
    lineEl.dataset.flexLine = 'true';
  } else if (runsForLine.some(isImageRun)) {
    // Image flowing alongside text/tabs (logo + label header line). Word seats
    // an inline image as a tall glyph on the text baseline, so baseline-align
    // the row — the image bottom then lands on the text baseline. The line
    // height was measured to match (imageH + text descent).
    lineEl.style.display = 'flex';
    lineEl.style.alignItems = 'baseline';
    lineEl.style.justifyContent = alignToJustifyContent(alignment);
    // Flex blockifies the run spans, so they'd otherwise inherit the line's
    // image-inflated line-height as their own box height — fattening each
    // text run to the full band and breaking baseline alignment. Reset to the
    // font's natural line box; the line div keeps its explicit `height`.
    lineEl.style.lineHeight = 'normal';
    lineEl.dataset.flexLine = 'true';
  }

  // Handle empty lines
  if (runsForLine.length === 0) {
    const emptySpan = doc.createElement('span');
    emptySpan.className = `${PARAGRAPH_CLASS_NAMES.run} layout-empty-run`;
    emptySpan.innerHTML = '&nbsp;';
    lineEl.appendChild(emptySpan);
    return lineEl;
  }

  // Calculate justify spacing if needed
  const isJustify = alignment === 'justify';
  let shouldJustify = false;

  if (isJustify && config) {
    // Justify all lines except the last line (unless it ends with line break)
    shouldJustify = !config.isLastLine || config.paragraphEndsWithLineBreak;

    if (shouldJustify) {
      // Use CSS text-align: justify with text-align-last: justify
      // This forces the browser to justify even single-line nodes
      lineEl.style.textAlign = 'justify';
      lineEl.style.textAlignLast = 'justify';
      // Set explicit width so browser knows how wide to justify to
      lineEl.style.width = `${config.availableWidth}px`;
    }
  }

  // Use white-space: pre to prevent internal wrapping AND preserve consecutive spaces.
  // All line breaking is done during measurement. 'pre' ensures multiple spaces
  // are rendered visually (unlike 'nowrap' which collapses them).
  lineEl.style.whiteSpace = 'pre';

  // Check if any run in this line has a highlight. If so, we need overflow:hidden
  // to prevent the padding-extended background from bleeding into adjacent lines.
  const hasHighlight = runsForLine.some((r) => isTextRun(r) && r.highlight);
  lineEl.style.overflow = hasHighlight ? 'hidden' : 'visible';

  // Per-line floating margins (leftOffset/rightOffset) are now applied by
  // paintParagraphFragment via MeasuredLine offsets from re-measurement.

  // Build tab context if we have tab runs - also create for text measurement
  const hasTabRuns = runsForLine.some(isTabRun);
  let tabRuler: TabRuler | undefined;

  if (hasTabRuns) {
    // Convert tab stops from layout engine format to tab calculator format
    const explicitStops = config?.tabMarks?.map(convertTabMarkToCalc);

    // Convert left indent from pixels to twips for tab calculation
    // The leftIndent serves two purposes in the tab calculator:
    // 1. For hanging indent paragraphs, it adds an implicit tab stop at the left margin
    // 2. Default tab stops are generated at regular intervals from the left margin
    const leftIndentTwips = config?.leftIndentPx ? Math.round(config.leftIndentPx * 15) : 0;

    tabRuler = {
      explicitStops,
      leftIndent: leftIndentTwips,
      // `w:defaultTabStop` — without it this ruler silently falls back to the
      // 720-twip default while the measurer uses the document's actual grid.
      defaultStopTwips: block.attrs?.defaultTabMarkTwips,
    };
  }

  // Track current X position for tab calculations
  // Tab stops are measured from the content area left edge (page text area)
  // We need to track where on that coordinate system our text is
  let currentX = 0;
  const leftIndentPx = config?.leftIndentPx ?? 0;

  if (config?.isFirstLine) {
    // First line position depends on first-line indent or hanging indent:
    // - With hanging indent (firstLineIndentPx < 0): starts at leftIndent + firstLineIndent
    // - With first-line indent (firstLineIndentPx > 0): starts at leftIndent + firstLineIndent
    // - No indent: starts at leftIndent
    const firstLineIndentPx = config?.firstLineIndentPx ?? 0;
    currentX = leftIndentPx + firstLineIndentPx;
  } else {
    // Non-first lines start at the left indent position
    currentX = leftIndentPx;
  }

  // Render each run
  for (let i = 0; i < runsForLine.length; i++) {
    const run = runsForLine[i];

    if (isTabRun(run) && tabRuler) {
      // Measure the content after this tab so end/center/decimal stops can
      // anchor it to the stop. Per-run measurement (not a single-font pass)
      // keeps the tab width accurate when trailing runs differ in font/size.
      const followingWidth = measureFollowingContentWidth(runsForLine, i, config?.context);
      const followingText = getTextAfterTab(runsForLine, i, config?.context);
      const decimalIndex = followingText.indexOf('.');
      const decimalPrefixWidth =
        decimalIndex >= 0 ? measureDefaultText(followingText.slice(0, decimalIndex)) : 0;

      // The measurer already resolved this tab's advance and recorded it on the
      // line (`MeasuredLine.advances`). Read it back rather than re-deriving it.
      //
      // Re-deriving is how the painter and the measurer come to disagree: the
      // ruler built here has no `defaultStopTwips`, so a document with
      // `<w:defaultTabStop w:val="1440"/>` gets a 720-twip grid at paint time and
      // a 1440-twip grid at measure time — the glyph paints in one column and the
      // caret goes to another. The recorded value makes all three parties (line
      // breaker, painter, hit-tester) agree by construction, which is the whole
      // point of `tabMetrics` being one module.
      //
      // `calculateTabWidth` remains the fallback for a synthetic line that
      // carries no advances (a hand-built fixture, a re-measured segment).
      const positionalTarget =
        run.positional?.relativeTo === 'indent'
          ? leftIndentPx + (config?.availableWidth ?? 0)
          : (config?.lineRightEdgePx ?? leftIndentPx + (config?.availableWidth ?? 0));
      const calculated = run.positional
        ? calculatePositionalTabWidth(currentX, positionalTarget, run.positional, {
            followingWidth,
            decimalPrefixWidth,
          })
        : calculateTabWidth(currentX, tabRuler, { followingWidth, decimalPrefixWidth });
      const recorded = line.atomAdvances?.[line.fromRun + i];
      const tabResult =
        recorded !== undefined
          ? {
              ...calculated,
              width: recorded,
            }
          : calculated;

      // Right-tab anchor (TOC pattern): when an end-aligned tab's stop is at
      // the line's right edge, let flex layout pin the trailing content there
      // (tab gets flex: 1) — sidesteps canvas-vs-DOM measurement drift.
      const lineRightEdgeX = config?.lineRightEdgePx;
      const followingWidthForCheck = followingWidth;
      // Gated to the last tab on the line — a trailing tab after a flex-anchored
      // item would push the anchor left.
      let hasFollowingTab = false;
      for (let j = i + 1; j < runsForLine.length; j++) {
        if (isLineBreakRun(runsForLine[j])) break;
        if (isTabRun(runsForLine[j])) {
          hasFollowingTab = true;
          break;
        }
      }
      const useRightAnchor =
        lineRightEdgeX !== undefined &&
        tabResult.alignment === 'end' &&
        !hasFollowingTab &&
        currentX + tabResult.width + followingWidthForCheck >=
          lineRightEdgeX - RIGHT_EDGE_EPSILON_PX;

      if (useRightAnchor) {
        // text-indent applies per flex item (not to the group), so a hanging
        // indent would pull every text-containing item left, including the
        // page number. Strip it here and re-apply as margin-left on the first
        // child. white-space: pre stops trailing items wrapping mid-line AND
        // keeps authored spaces inside them — nowrap collapses a trailing
        // space at a flex-item edge, fusing "Page " + "2" into "Page2".
        lineEl.style.display = 'flex';
        lineEl.style.alignItems = 'baseline';
        lineEl.style.whiteSpace = 'pre';
        lineEl.style.textIndent = '0';
        lineEl.dataset.flexLine = 'true';
        if (
          config?.isFirstLine &&
          config.firstLineIndentPx &&
          config.firstLineIndentPx < 0 &&
          lineEl.firstElementChild instanceof HTMLElement
        ) {
          // Re-apply the hanging indent (text-indent doesn't work for flex
          // items). Negative margin-left on the first flex item pulls it back
          // into the padding area, matching the original text-indent behaviour.
          lineEl.firstElementChild.style.marginLeft = `${config.firstLineIndentPx}px`;
        }

        // The tab — flex-grow to fill remaining line space after the trailing
        // content takes its natural width. The leader inside is already
        // absolutely positioned to fill the outer's box.
        const tabEl = paintTabRun(run, doc, 0, tabResult.leader);
        tabEl.style.flex = '1 1 0';
        tabEl.style.minWidth = '0';
        tabEl.style.width = 'auto';
        lineEl.appendChild(tabEl);

        // Render the remaining runs into the line at their natural width.
        // Flex layout puts them flush against the line's right edge.
        for (let j = i + 1; j < runsForLine.length; j++) {
          const next = runsForLine[j];
          if (isTabRun(next) || isLineBreakRun(next)) break;
          if (isTextRun(next)) {
            lineEl.appendChild(paintTextRun(next, doc, config?.context?.resolvedCommentIds));
          } else if (isFieldRun(next) && config?.context) {
            lineEl.appendChild(paintFieldRun(next, doc, config.context));
          } else if (isImageRun(next)) {
            // Floating images render at the page level (or in dedicated cell
            // layers) — skip here to avoid double-rendering, matching the
            // main loop's behaviour.
            if (isFloatingImageRun(next)) continue;
            const imageKey = getInlineImageRunKey(next);
            if (!config?.renderedInlineImageKeys?.has(imageKey)) {
              config?.renderedInlineImageKeys?.add(imageKey);
              lineEl.appendChild(
                paintImageRun(next, doc, line.atomAdvances?.[line.fromRun + j] ?? next.width)
              );
              reportInlineImageSpan(
                next,
                line,
                line.fromRun + j,
                imageOnlyLine,
                config?.onInlineImageRendered
              );
            }
          } else {
            lineEl.appendChild(paintRun(next, doc, config?.context));
          }
        }

        break;
      }

      // Fallback path: not a right-anchored tab. Apply the existing clamp
      // so a tab that overshoots the line edge doesn't bleed past it.
      let tabWidth = tabResult.width;
      if (lineRightEdgeX !== undefined) {
        if (currentX + tabWidth + followingWidthForCheck > lineRightEdgeX) {
          tabWidth = Math.max(1, lineRightEdgeX - currentX - followingWidthForCheck);
        }
      }

      const tabEl = paintTabRun(run, doc, tabWidth, tabResult.leader);
      lineEl.appendChild(tabEl);
      currentX += tabWidth;
    } else if (isTextRun(run)) {
      const runEl = paintTextRun(run, doc, config?.context?.resolvedCommentIds);

      // For highlighted runs, extend background to fill the full line height.
      // Inline elements' background only covers the content area (font ascent+descent),
      // which differs by font size. Vertical padding on inline elements extends the
      // background without affecting line box calculations.
      if (run.highlight) {
        const fontSizePx = run.fontSize ? (run.fontSize * 96) / 72 : 14.67;
        const contentHeight = fontSizePx * 1.2; // approximate content area
        const gap = Math.max(0, line.lineHeight - contentHeight);
        if (gap > 0) {
          const pad = gap / 2;
          runEl.style.paddingTop = `${pad}px`;
          runEl.style.paddingBottom = `${pad}px`;
        }
      }

      lineEl.appendChild(runEl);

      // Measure text width for accurate tab position tracking
      currentX += measureTextWidth(run.text, resolveFontStyle(run));
    } else if (isImageRun(run)) {
      // Skip floating images - they're rendered separately at page level.
      // Exception: inside table cells, floating images must render in-flow
      // Floating images are rendered in dedicated floating layers (page-level
      // or cell-level), not inline. Skip them here to avoid double rendering.
      if (isFloatingImageRun(run)) {
        continue;
      }
      const imageKey = getInlineImageRunKey(run);
      if (config?.renderedInlineImageKeys?.has(imageKey)) {
        continue;
      }
      config?.renderedInlineImageKeys?.add(imageKey);
      // Inline or block image - render in the text flow
      const paintedWidth = line.atomAdvances?.[line.fromRun + i] ?? run.width;
      const runEl = paintImageRun(run, doc, paintedWidth);
      lineEl.appendChild(runEl);
      reportInlineImageSpan(
        run,
        line,
        line.fromRun + i,
        imageOnlyLine,
        config?.onInlineImageRendered
      );
      // Block images don't contribute to horizontal position
      if (run.displayMode !== 'block' && run.wrapType !== 'topAndBottom') {
        currentX += paintedWidth;
      }
    } else if (isLineBreakRun(run)) {
      const runEl = paintLineBreakRun(run, doc);
      lineEl.appendChild(runEl);
    } else if (isFieldRun(run) && config?.context) {
      // Render field run with context for PAGE/NUMPAGES substitution
      const runEl = paintFieldRun(run, doc, config.context);
      lineEl.appendChild(runEl);
      // Estimate field text width for tab calculations
      let fieldText = run.fallback ?? '';
      if (run.fieldType === 'PAGE') fieldText = String(config.context.pageNumber);
      else if (run.fieldType === 'NUMPAGES') fieldText = String(config.context.totalPages);
      currentX += measureTextWidth(fieldText, resolveFontStyle(run));
    } else {
      // Fallback for unknown run types
      const runEl = paintRun(run, doc, config?.context);
      lineEl.appendChild(runEl);
    }
  }

  // A line whose only run is a line break (a blank row produced by consecutive
  // `<w:br/>`) has no positioned text span — its PM position lives on the `<br>`,
  // which the click/caret/visual-line resolvers don't read (they look for
  // `span[data-doc-from]`). Without a positioned span, those resolvers fall back
  // to the paragraph's start, so clicks, the caret, and arrow navigation all
  // collapse onto the first line of the paragraph. Emit a zero-width positioned
  // marker carrying the break's position so the existing resolvers can locate it.
  if (!lineEl.querySelector('span[data-doc-from][data-doc-to]')) {
    const lineBreakRun = runsForLine.find(isLineBreakRun) as LineBreakRun | undefined;
    if (lineBreakRun?.docFrom !== undefined) {
      const marker = doc.createElement('span');
      marker.className = PARAGRAPH_CLASS_NAMES.run;
      applyPmPositions(marker, lineBreakRun.docFrom, lineBreakRun.docFrom);
      marker.textContent = '\u200B';
      lineEl.insertBefore(marker, lineEl.firstChild);
    }
  }

  return lineEl;
}
