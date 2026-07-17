/**
 * Floating-aware block measurement pipeline.
 *
 * Pre-scans a block list to extract exclusion zones from anchored images,
 * floating tables, and floating text boxes; estimates page/section/column
 * flow scopes; then walks the nodes calling the caller-supplied
 * `measureBlock` with only the zones active in that scope.
 *
 * Adapters (React, Vue) provide their own `measureBlock` so they can
 * decide e.g. whether to cache paragraph metrics. The orchestration,
 * extraction, and grouping live here so both adapters stay in lockstep.
 *
 * @packageDocumentation
 * @public
 */
import {
  collectSectionConfigs,
  isFloatingTextBoxBlock,
  isWrapNone,
  type ColumnLayout,
  type ContentNode,
  type ImageRun,
  type ImageRunPosition,
  type LayoutMetrics,
  type MeasuredLine,
  type ParagraphBlock,
  type ParagraphMetrics,
  type Run,
  type TableBlock,
  type TextBoxBlock,
} from '../../pagination-model';
import {
  imageWrapTextFromCssFloat,
  isTextWrappingFloatingImageRun,
} from '../../painter-model/floatingImageFlow';
import {
  pageGeometryFromPage,
  resolveAnchoredObjectPosition,
  resolveAnchoredObjectVerticalTop,
  type PageGeometry,
} from '../../painter-model/anchoredObjectPosition';
import { emuToPixels } from '../../utils/units';
import { constrainWrapMargins } from './paragraphLayout';
import { resolveFloatingTableX } from '../../pagination-model/floatingTablePosition';
import { rectsToFloatingZones, type FloatingImageZone } from './floatingZones';
import { measureTable } from '../measureTable';

/**
 * A floating exclusion zone tagged with the block index that anchors it.
 */
interface FloatingZoneWithAnchor extends FloatingImageZone {
  anchorNodeIndex: number;
  /** True when the resolver's vertical position follows the anchor paragraph. */
  isParagraphRelative?: boolean;
}

interface FloatFlowScopes {
  initialGeometry: FloatPageGeometry | undefined;
  geometryAfterBreak: Map<number, FloatPageGeometry | undefined>;
  baseMetrics: LayoutMetrics[];
}

/**
 * Block-measurement callback shape passed to {@link measureBlocksWithFloats}.
 * Adapters (React, Vue) supply this so they can decide platform-specific
 * concerns (e.g. paragraph-measure caching, per-section width) while
 * sharing the floating-zone orchestration. This is adapter-author API,
 * not end-consumer API.
 *
 * @public
 */
export type MeasureBlockFn = (
  block: ContentNode,
  contentWidth: number,
  floatingZones?: FloatingImageZone[],
  cumulativeY?: number
) => LayoutMetrics;

/**
 * Page geometry (CSS px) used to resolve page/margin-relative anchored objects
 * into content-area coordinates — currently the vertical anchor of a top-pinned
 * `topAndBottom` band. Same shape the painter uses (see `pageGeometryFromPage`),
 * so both paths resolve to identical positions.
 *
 * @public
 */
export type FloatPageGeometry = PageGeometry & {
  /**
   * Columns in force for pages created with this geometry. Keeping this beside
   * the page dimensions lets float measurement advance through the same
   * physical-page regions as the composer instead of treating every full
   * column as a new page.
   */
  columns?: ColumnLayout;
};

/**
 * Walk `nodes` and produce one `LayoutMetrics` per block. Before measuring, this
 * extracts floating exclusion zones (images / floating tables / floating
 * textboxes), scopes them to their anchor's page/section flow interval, and
 * threads the active zones plus cumulative Y into each `measureBlock` call.
 *
 * Pass `pageGeometry` whenever the document may contain page/margin-anchored
 * `topAndBottom` text boxes (e.g. a title banner pinned to the page top):
 * without it their reserved band falls back to flow-relative Y and the band
 * won't line up with where the painter places the box. Build it with the
 * shared `pageGeometryFromPage` helper.
 *
 * `finalPageGeometry` is the trailing section's geometry. Together with
 * `pageGeometry`, it lets measurement build the exact same section schedule as
 * page composition. In particular, a continuous section's geometry remains
 * pending until flow advances to a new physical page.
 *
 * @public
 */
export function measureBlocksWithFloats(
  nodes: ContentNode[],
  contentWidth: number | number[],
  measureBlock: MeasureBlockFn,
  pageGeometry?: FloatPageGeometry,
  finalPageGeometry?: FloatPageGeometry
): LayoutMetrics[] {
  const defaultWidth = Array.isArray(contentWidth) ? (contentWidth[0] ?? 0) : contentWidth;
  const blockWidthAt = (nodeIndex: number): number =>
    Array.isArray(contentWidth) ? (contentWidth[nodeIndex] ?? defaultWidth) : contentWidth;
  const scopes = buildFloatFlowScopes(
    nodes,
    blockWidthAt,
    measureBlock,
    pageGeometry,
    finalPageGeometry
  );
  let cumulativeY = 0;
  let activeZones: FloatingImageZone[] = [];
  let currentPageGeometry = scopes.initialGeometry;
  let nextPageGeometry = scopes.initialGeometry;
  let currentColumnIndex = 0;
  let currentColumnCount = columnCountForGeometry(currentPageGeometry);
  let columnRegionTop = 0;
  let regionBottom = 0;
  const metrics: LayoutMetrics[] = [];

  const activateAnchoredZones = (
    block: ContentNode,
    nodeIndex: number,
    blockWidth: number
  ): void => {
    const anchoredZones: FloatingZoneWithAnchor[] = [];
    extractFloatingZonesFromBlock(
      block,
      nodeIndex,
      blockWidth,
      measureBlock,
      currentPageGeometry,
      anchoredZones
    );
    for (const anchored of anchoredZones) {
      const { anchorNodeIndex: _anchorBlockIndex, isParagraphRelative, ...zone } = anchored;
      activeZones.push(
        isParagraphRelative
          ? {
              ...zone,
              topY: zone.topY + cumulativeY,
              bottomY: zone.bottomY + cumulativeY,
            }
          : zone
      );
    }
  };

  const resetFlowScope = (top = 0): void => {
    cumulativeY = top;
    activeZones = [];
  };

  const beginPhysicalScope = (): void => {
    resetFlowScope();
    currentPageGeometry = nextPageGeometry;
    currentColumnIndex = 0;
    currentColumnCount = columnCountForGeometry(currentPageGeometry);
    columnRegionTop = 0;
    regionBottom = 0;
  };

  const advanceFlowScope = (): void => {
    regionBottom = Math.max(regionBottom, cumulativeY);
    if (currentColumnIndex + 1 < currentColumnCount) {
      currentColumnIndex++;
      resetFlowScope(columnRegionTop);
      return;
    }
    beginPhysicalScope();
  };

  const ensureRoomForPositiveFlow = (nodeIndex: number): void => {
    const baseHeight = measureFlowHeight(nodes[nodeIndex], scopes.baseMetrics[nodeIndex]);
    let contentHeight = currentPageGeometry?.contentHeight ?? Number.POSITIVE_INFINITY;
    while (
      baseHeight > 0 &&
      contentHeight > 0 &&
      Number.isFinite(contentHeight) &&
      cumulativeY >= contentHeight
    ) {
      advanceFlowScope();
      contentHeight = currentPageGeometry?.contentHeight ?? Number.POSITIVE_INFINITY;
    }
  };

  const consumeFlowHeight = (height: number): void => {
    let remaining = height;
    while (remaining > 0) {
      const contentHeight = currentPageGeometry?.contentHeight ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(contentHeight)) {
        cumulativeY += remaining;
        return;
      }
      if (contentHeight <= 0) {
        // Match the composer for malformed zero-height content boxes: place the
        // flow anyway rather than advancing through an unbounded run of pages.
        cumulativeY += remaining;
        return;
      }

      const available = Math.max(0, contentHeight - cumulativeY);
      if (remaining <= available) {
        cumulativeY += remaining;
        regionBottom = Math.max(regionBottom, cumulativeY);
        return;
      }

      remaining -= available;
      advanceFlowScope();
    }
  };

  const applySectionTransition = (nodeIndex: number, block: ContentNode): void => {
    if (block.kind !== 'sectionBreak') return;

    nextPageGeometry = scopes.geometryAfterBreak.get(nodeIndex);
    if (block.type === 'continuous') {
      // Composition re-columnises the remainder of this physical page at the
      // current pen. Page dimensions stay unchanged until an actual page start.
      const resumeY = currentColumnCount > 1 ? Math.max(regionBottom, cumulativeY) : cumulativeY;
      currentColumnIndex = 0;
      currentColumnCount = columnCountForGeometry(nextPageGeometry);
      columnRegionTop = resumeY;
      cumulativeY = resumeY;
      regionBottom = resumeY;
      return;
    }

    if (block.type === 'nextColumn') {
      advanceFlowScope();
      return;
    }

    beginPhysicalScope();
  };

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const block = nodes[nodeIndex];
    ensureRoomForPositiveFlow(nodeIndex);

    const blockWidth = blockWidthAt(nodeIndex);
    activateAnchoredZones(block, nodeIndex, blockWidth);
    activeZones = activeZones.filter((zone) => zone.bottomY > cumulativeY);
    let zones = activeZones.length > 0 ? activeZones : undefined;
    let measure =
      zones == null
        ? scopes.baseMetrics[nodeIndex]
        : measureBlock(block, blockWidth, zones, cumulativeY);
    let height = measureFlowHeight(block, measure);
    let contentHeight = currentPageGeometry?.contentHeight ?? Number.POSITIVE_INFINITY;

    // A splittable paragraph can begin beside a float and continue in the next
    // flow region (column or page), where that float no longer exists. Keep the
    // wrapped lines that fit this scope, then append a fresh unwrapped
    // continuation. Feeding the whole wrapped measure to pagination would make
    // its continuation reuse stale line breaks after activeZones is cleared.
    if (
      block.kind === 'paragraph' &&
      measure.kind === 'paragraph' &&
      zones != null &&
      block.attrs?.keepLines !== true &&
      Number.isFinite(contentHeight) &&
      cumulativeY + height > contentHeight
    ) {
      const availableForLines = Math.max(
        0,
        contentHeight - cumulativeY - (block.attrs?.spacing?.before ?? 0)
      );
      const prefixLineCount = countParagraphLinesThatFit(measure.lines, availableForLines);
      if (prefixLineCount > 0 && prefixLineCount < measure.lines.length) {
        measure = mergeParagraphContinuation(
          block,
          measure,
          scopes.baseMetrics[nodeIndex] as ParagraphMetrics,
          prefixLineCount,
          blockWidth,
          measureBlock
        );
        height = measureFlowHeight(block, measure);
      }
    }

    // A zone can increase an atomic/keep-lines block enough to move that whole
    // block into the next flow region. Re-evaluate only those nodes at the new scope
    // origin. Splittable paragraphs keep their current-page lines in the zone
    // and continue without it after pagination cuts the measured line set.
    const remainingInScope = contentHeight - cumulativeY;
    const firstParagraphLineHeight =
      block.kind === 'paragraph' && measure.kind === 'paragraph'
        ? (block.attrs?.spacing?.before ?? 0) +
          (measure.lines[0]?.lineHeight ?? 0) +
          (measure.lines[0]?.floatSkipBefore ?? 0)
        : 0;
    const movesWholeToNextScope =
      block.kind === 'image' ||
      block.kind === 'textBox' ||
      (block.kind === 'paragraph' &&
        (block.attrs?.keepLines === true || firstParagraphLineHeight > remainingInScope));
    if (
      movesWholeToNextScope &&
      height > 0 &&
      cumulativeY > 0 &&
      Number.isFinite(contentHeight) &&
      cumulativeY + height > contentHeight
    ) {
      advanceFlowScope();
      contentHeight = currentPageGeometry?.contentHeight ?? Number.POSITIVE_INFINITY;
      activateAnchoredZones(block, nodeIndex, blockWidth);
      activeZones = activeZones.filter((zone) => zone.bottomY > cumulativeY);
      zones = activeZones.length > 0 ? activeZones : undefined;
      measure =
        zones == null
          ? scopes.baseMetrics[nodeIndex]
          : measureBlock(block, blockWidth, zones, cumulativeY);
      height = measureFlowHeight(block, measure);
    }
    metrics.push(measure);

    // Floating tables don't advance flow Y (their wrap zone already accounts
    // for vertical space). Every other measurable block advances the scope pen.
    consumeFlowHeight(height);

    if (block.kind === 'pageBreak') {
      beginPhysicalScope();
    } else if (block.kind === 'columnBreak') {
      advanceFlowScope();
    } else {
      applySectionTransition(nodeIndex, block);
    }
  }

  return metrics;
}

function columnCountForGeometry(geometry: FloatPageGeometry | undefined): number {
  return Math.max(1, geometry?.columns?.count ?? 1);
}

function lineFlowHeight(line: MeasuredLine): number {
  return line.lineHeight + (line.floatSkipBefore ?? 0);
}

function countParagraphLinesThatFit(lines: MeasuredLine[], available: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    const height = lineFlowHeight(line);
    if (used + height > available) break;
    used += height;
    count++;
  }
  return count;
}

interface RunPosition {
  run: number;
  char: number;
}

function compareRunPositions(a: RunPosition, b: RunPosition): number {
  return a.run === b.run ? a.char - b.char : a.run - b.run;
}

function mergeParagraphContinuation(
  block: ParagraphBlock,
  wrapped: ParagraphMetrics,
  unwrapped: ParagraphMetrics,
  prefixLineCount: number,
  contentWidth: number,
  measureBlock: MeasureBlockFn
): ParagraphMetrics {
  const prefix = wrapped.lines.slice(0, prefixLineCount);
  const lastPrefixLine = prefix[prefix.length - 1];
  const boundary = { run: lastPrefixLine.toRun, char: lastPrefixLine.toChar };
  const exactUnwrappedStart = unwrapped.lines.findIndex(
    (line) => compareRunPositions({ run: line.fromRun, char: line.fromChar }, boundary) === 0
  );
  const continuation =
    exactUnwrappedStart >= 0
      ? unwrapped.lines.slice(exactUnwrappedStart)
      : measureParagraphRemainder(block, boundary, contentWidth, measureBlock);
  const lines = [...prefix, ...continuation];
  const spacing = block.attrs?.spacing;

  return {
    kind: 'paragraph',
    lines,
    totalHeight:
      lines.reduce((sum, line) => sum + lineFlowHeight(line), 0) +
      (spacing?.before ?? 0) +
      (spacing?.after ?? 0),
  };
}

function runLength(run: Run): number {
  return run.kind === 'text' ? run.text.length : 1;
}

function measureParagraphRemainder(
  block: ParagraphBlock,
  from: RunPosition,
  contentWidth: number,
  measureBlock: MeasureBlockFn
): MeasuredLine[] {
  let runOffset = from.run;
  let charOffset = from.char;
  while (runOffset < block.runs.length && charOffset >= runLength(block.runs[runOffset])) {
    runOffset++;
    charOffset = 0;
  }
  if (runOffset >= block.runs.length) return [];

  const runs = block.runs.slice(runOffset);
  if (charOffset > 0 && runs[0]?.kind === 'text') {
    runs[0] = { ...runs[0], text: runs[0].text.slice(charOffset) };
  }

  const attrs = block.attrs
    ? {
        ...block.attrs,
        spacing: undefined,
        indent: block.attrs.indent
          ? { left: block.attrs.indent.left, right: block.attrs.indent.right }
          : undefined,
        listMarker: undefined,
        listIsBullet: undefined,
        listMarkerHidden: undefined,
        listMarkerFontFamily: undefined,
        listMarkerFontSize: undefined,
        listMarkerSuffix: undefined,
        listMarkerRevision: undefined,
        pageBreakBefore: undefined,
      }
    : undefined;
  const remainder = measureBlock({ ...block, runs, attrs }, contentWidth);
  if (remainder.kind !== 'paragraph') return [];

  return remainder.lines.map((line) => remapContinuationLine(line, runOffset, charOffset));
}

function remapContinuationLine(
  line: MeasuredLine,
  runOffset: number,
  charOffset: number
): MeasuredLine {
  const remapPosition = (run: number, char: number): RunPosition => ({
    run: run + runOffset,
    char: char + (run === 0 ? charOffset : 0),
  });
  const from = remapPosition(line.fromRun, line.fromChar);
  const to = remapPosition(line.toRun, line.toChar);
  const segments = line.segments?.map((segment) => {
    const segmentFrom = remapPosition(segment.fromRun, segment.fromChar);
    const segmentTo = remapPosition(segment.toRun, segment.toChar);
    return {
      ...segment,
      fromRun: segmentFrom.run,
      fromChar: segmentFrom.char,
      toRun: segmentTo.run,
      toChar: segmentTo.char,
    };
  });
  const atomAdvances = line.atomAdvances
    ? Object.fromEntries(
        Object.entries(line.atomAdvances).map(([run, advance]) => [
          Number(run) + runOffset,
          advance,
        ])
      )
    : undefined;

  return {
    ...line,
    fromRun: from.run,
    fromChar: from.char,
    toRun: to.run,
    toChar: to.char,
    ...(segments ? { segments } : {}),
    ...(atomAdvances ? { atomAdvances } : {}),
  };
}

function buildFloatFlowScopes(
  nodes: ContentNode[],
  blockWidthAt: (nodeIndex: number) => number,
  measureBlock: MeasureBlockFn,
  initialGeometry?: FloatPageGeometry,
  finalGeometry?: FloatPageGeometry
): FloatFlowScopes {
  const baseMetrics: LayoutMetrics[] = [];

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const block = nodes[nodeIndex];
    const measure = measureBlock(block, blockWidthAt(nodeIndex));
    baseMetrics.push(measure);
  }

  if (!initialGeometry) {
    return { initialGeometry: undefined, geometryAfterBreak: new Map(), baseMetrics };
  }

  const sectionPlan = collectSectionConfigs(
    nodes,
    sectionConfigFromGeometry(initialGeometry),
    sectionConfigFromGeometry(finalGeometry ?? initialGeometry)
  );
  const sectionGeometries = sectionPlan.configs.map((config) => ({
    ...pageGeometryFromPage({ size: config.pageSize, margins: config.margins }),
    ...(config.columns ? { columns: config.columns } : {}),
  }));
  const geometryAfterBreak = new Map<number, FloatPageGeometry | undefined>();
  for (let sectionIndex = 0; sectionIndex < sectionPlan.breakIndices.length; sectionIndex++) {
    geometryAfterBreak.set(
      sectionPlan.breakIndices[sectionIndex],
      sectionGeometries[sectionIndex + 1] ?? sectionGeometries[sectionIndex]
    );
  }

  return {
    initialGeometry: sectionGeometries[0] ?? initialGeometry,
    geometryAfterBreak,
    baseMetrics,
  };
}

function measureFlowHeight(block: ContentNode, measure: LayoutMetrics): number {
  if (block.kind === 'table' && (block as TableBlock).floating) return 0;
  if (block.kind === 'textBox' && isFloatingTextBoxBlock(block as TextBoxBlock)) return 0;
  if ('totalHeight' in measure) return measure.totalHeight;
  if ('height' in measure) return measure.height;
  return 0;
}

function sectionConfigFromGeometry(geometry: FloatPageGeometry) {
  return {
    pageSize: { w: geometry.pageWidth, h: geometry.pageHeight },
    margins: {
      top: geometry.marginTop,
      right: geometry.marginRight,
      bottom: geometry.marginBottom,
      left: geometry.marginLeft,
    },
    columns: geometry.columns,
  };
}

/**
 * Extract floating exclusion zones from one anchor block using the physical
 * page geometry currently receiving that block.
 */
function extractFloatingZonesFromBlock(
  block: ContentNode,
  nodeIndex: number,
  contentWidth: number,
  measureBlock: MeasureBlockFn,
  pageGeometry: FloatPageGeometry | undefined,
  zones: FloatingZoneWithAnchor[]
): void {
  switch (block.kind) {
    case 'paragraph':
      extractImageZonesFromParagraph(
        block as ParagraphBlock,
        nodeIndex,
        contentWidth,
        zones,
        pageGeometry
      );
      break;
    case 'table':
      extractFloatingTableZone(block as TableBlock, nodeIndex, contentWidth, measureBlock, zones);
      break;
    case 'textBox':
      extractFloatingTextBoxZone(
        block as TextBoxBlock,
        nodeIndex,
        contentWidth,
        zones,
        pageGeometry
      );
      break;
  }
}

/**
 * Resolve left/right exclusion margins for an OOXML-positioned anchored
 * object (image or text box). Shared between image-in-paragraph and
 * top-level textbox extraction since both use the same
 * `ImageRunPosition` shape and `cssFloat` fallback.
 */
function computeAnchoredMargins(
  position: ImageRunPosition | undefined,
  cssFloat: 'left' | 'right' | 'none' | undefined,
  width: number,
  distLeft: number,
  distRight: number,
  contentWidth: number
): { leftMargin: number; rightMargin: number } {
  let leftMargin = 0;
  let rightMargin = 0;

  const h = position?.horizontal;
  if (h?.align === 'left') {
    leftMargin = width + distRight;
  } else if (h?.align === 'right') {
    rightMargin = width + distLeft;
  } else if (h?.posOffset !== undefined) {
    const x = emuToPixels(h.posOffset);
    if (x < contentWidth / 2) {
      leftMargin = x + width + distRight;
    } else {
      rightMargin = contentWidth - x + distLeft;
    }
  } else if (cssFloat === 'left') {
    leftMargin = width + distRight;
  } else if (cssFloat === 'right') {
    rightMargin = width + distLeft;
  }

  return constrainWrapMargins(leftMargin, rightMargin, contentWidth);
}

/**
 * True when the shared anchor resolver uses the paragraph fragment Y as its
 * vertical origin. All other modes already resolve into page content-area
 * coordinates and must not receive the flow pen a second time.
 */
function isPositionParagraphRelative(position: ImageRunPosition | undefined): boolean {
  const rel = position?.vertical?.relativeTo;
  return rel == null || rel === 'paragraph' || rel === 'line';
}

function extractImageZonesFromParagraph(
  paragraphBlock: ParagraphBlock,
  nodeIndex: number,
  contentWidth: number,
  out: FloatingZoneWithAnchor[],
  pageGeometry?: FloatPageGeometry
): void {
  for (const run of paragraphBlock.runs) {
    if (run.kind !== 'image') continue;
    const imgRun = run as ImageRun;

    const distTop = imgRun.distTop ?? 0;
    const distBottom = imgRun.distBottom ?? 0;
    const distLeft = imgRun.distLeft ?? 12;
    const distRight = imgRun.distRight ?? 12;

    if (imgRun.wrapType === 'topAndBottom') {
      const rawTopY = resolveAnchoredObjectVerticalTop(imgRun, 0, pageGeometry);
      const bottomY = rawTopY + imgRun.height + distBottom;
      if (bottomY <= 0) continue;
      out.push({
        leftMargin: 0,
        rightMargin: 0,
        topY: rawTopY - distTop,
        bottomY,
        anchorNodeIndex: nodeIndex,
        isParagraphRelative: isPositionParagraphRelative(imgRun.position),
        fullWidthBlock: true,
      });
      continue;
    }

    if (!isTextWrappingFloatingImageRun(imgRun)) continue;

    // Resolve the image through the same content-relative coordinate path as
    // the painter, then convert that painted rectangle through the same zone
    // helper. In particular, page-relative zero offsets begin in the page
    // margin (negative content coordinates), not at the content origin.
    const resolved = resolveAnchoredObjectPosition(imgRun, 0, contentWidth, pageGeometry);
    const [zone] = rectsToFloatingZones(
      [
        {
          ...resolved,
          width: imgRun.width,
          height: imgRun.height,
          distTop,
          distBottom,
          distLeft,
          distRight,
          wrapText: imageWrapTextFromCssFloat(imgRun.cssFloat),
          wrapType: imgRun.wrapType,
        },
      ],
      contentWidth
    );
    out.push({
      ...zone,
      anchorNodeIndex: nodeIndex,
      // The shared resolver used fragmentY=0 above. Paragraph/line-relative
      // images retain their existing flow-relative behavior when activation
      // adds the anchor paragraph's cumulative Y.
      isParagraphRelative: isPositionParagraphRelative(imgRun.position),
    });
  }
}

function extractFloatingTableZone(
  tableBlock: TableBlock,
  nodeIndex: number,
  contentWidth: number,
  measureBlock: MeasureBlockFn,
  out: FloatingZoneWithAnchor[]
): void {
  const floating = tableBlock.floating;
  if (!floating) return;

  const tableMeasure = measureTable(tableBlock, contentWidth, measureBlock);
  const tableWidth = tableMeasure.totalWidth;
  const tableHeight = tableMeasure.totalHeight;

  const distLeft = floating.leftFromText ?? 12;
  const distRight = floating.rightFromText ?? 12;
  const distTop = floating.topFromText ?? 0;
  const distBottom = floating.bottomFromText ?? 0;

  // Tables use OOXML `w:tblpXSpec` / `tblpX` instead of the image-style
  // `align` / `posOffset`, so the common helper above doesn't apply.
  const x = resolveFloatingTableX(floating, tableBlock.justification, tableWidth, contentWidth);

  let leftMargin = 0;
  let rightMargin = 0;
  if (x < contentWidth / 2) {
    leftMargin = x + tableWidth + distRight;
  } else {
    rightMargin = contentWidth - x + distLeft;
  }

  ({ leftMargin, rightMargin } = constrainWrapMargins(leftMargin, rightMargin, contentWidth));

  const topY = floating.tblpY ?? 0;
  const bottomY = topY + tableHeight;

  out.push({
    leftMargin,
    rightMargin,
    topY: topY - distTop,
    bottomY: bottomY + distBottom,
    anchorNodeIndex: nodeIndex,
    // `vertAnchor="text"`: tblpY counts from the table's flow position, so the
    // zone activates at the anchor block's cumulative Y — same mechanism as
    // paragraph-relative floating images. `margin`/`page` stay content-box
    // absolute (page approximated by the margin box, as at paint time).
    isParagraphRelative: floating.vertAnchor === 'text',
  });
}

function extractFloatingTextBoxZone(
  tbBlock: TextBoxBlock,
  nodeIndex: number,
  contentWidth: number,
  out: FloatingZoneWithAnchor[],
  pageGeometry?: FloatPageGeometry
): void {
  if (!isFloatingTextBoxBlock(tbBlock)) return;
  if (isWrapNone(tbBlock.wrapType)) return;

  const tbWidth = tbBlock.width ?? 0;
  const tbHeight = tbBlock.height ?? 0;
  if (tbWidth <= 0 || tbHeight <= 0) return;

  const distTop = tbBlock.distTop ?? 0;
  const distBottom = tbBlock.distBottom ?? 0;
  const distLeft = tbBlock.distLeft ?? 12;
  const distRight = tbBlock.distRight ?? 12;

  // topAndBottom: reserve a full-width vertical band so body text flows above
  // and below the box. Page/margin-relative boxes (e.g. a banner pinned to the
  // page top) need their offset translated into content-area coordinates.
  if (tbBlock.wrapType === 'topAndBottom') {
    // Resolve the band's vertical top via the SAME resolver the painter uses,
    // so the reserved band lines up with where the box is painted regardless of
    // anchor kind (page / margin / topMargin / bottomMargin, align or posOffset).
    // fragmentY=0: a topAndBottom band is page/margin-pinned; the paragraph-Y
    // fallback only applies to genuinely paragraph-relative boxes, which this
    // pre-pagination pass anchors at their own block (cumulativeY 0 there).
    const rawTopY = resolveAnchoredObjectVerticalTop(
      { width: tbWidth, height: tbHeight, position: tbBlock.position },
      0,
      pageGeometry
    );
    // Signed top may be negative when the box reaches up into the top margin.
    // The band reserves only the part intruding into content (topY clamped at
    // 0), but its bottom is measured from the true top so the reserved height
    // matches how far the box extends below the content edge.
    const bottomY = rawTopY + tbHeight + distBottom;
    if (bottomY <= 0) return;
    out.push({
      leftMargin: 0,
      rightMargin: 0,
      topY: Math.max(0, rawTopY - distTop),
      bottomY,
      anchorNodeIndex: nodeIndex,
      isParagraphRelative: isPositionParagraphRelative(tbBlock.position),
      fullWidthBlock: true,
    });
    return;
  }

  let topY = 0;
  if (tbBlock.position?.vertical?.posOffset !== undefined) {
    topY = emuToPixels(tbBlock.position.vertical.posOffset);
  }
  const bottomY = topY + tbHeight;

  const { leftMargin, rightMargin } = computeAnchoredMargins(
    tbBlock.position,
    tbBlock.cssFloat,
    tbWidth,
    distLeft,
    distRight,
    contentWidth
  );

  if (leftMargin <= 0 && rightMargin <= 0) return;

  out.push({
    leftMargin,
    rightMargin,
    topY: topY - distTop,
    bottomY: bottomY + distBottom,
    anchorNodeIndex: nodeIndex,
    isParagraphRelative: isPositionParagraphRelative(tbBlock.position),
  });
}
