/**
 * Footnote area rendering.
 *
 * Footnotes get a separator line plus per-item rendering at the bottom of
 * each page. Two paths: measured content (full body pipeline through
 * paragraph/table/image/textBox fragments) for WYSIWYG fidelity, or a plain
 * text fallback when no measurement is available.
 */

import type {
  FootnoteContent,
  FootnoteNodeFragment,
  FootnoteFragment,
  MeasuredLine,
  ParagraphMetrics,
  ParagraphFragment,
  TableFragment,
  ImageFragment,
  TextBoxFragment,
} from '../../pagination-model/types';
import { paintParagraphFragment } from '../renderParagraph';
import { paintTableFragment } from '../renderTable';
import { paintImageFragment } from '../renderImage';
import { paintTextBoxFragment } from '../renderTextBox';
import {
  FOOTNOTE_SEPARATOR_HEIGHT,
  FOOTNOTE_COLUMN_GAP_PX,
  distributeFootnotesIntoColumns,
} from '../../flow-model/footnoteLayout';
import type { RenderContext } from '../paintPage';

/**
 * A single footnote item ready for rendering at page bottom.
 */
export interface FootnoteRenderItem {
  /** Display number (e.g. "1", "2") */
  displayNumber: string;
  /** Plain text content */
  text: string;
  /** Measured body-pipeline content used for WYSIWYG painting. */
  content?: FootnoteContent;
  /** Page-local measured slice. Absent only for the plain-text fallback. */
  fragment?: FootnoteFragment;
}

type ParagraphPosition = { runIndex: number; charOffset: number };

function compareParagraphPositions(left: ParagraphPosition, right: ParagraphPosition): number {
  return left.runIndex - right.runIndex || left.charOffset - right.charOffset;
}

function clampLineToContentRange(
  line: MeasuredLine,
  from: ParagraphPosition | undefined,
  to: ParagraphPosition | undefined
): MeasuredLine {
  if (!from && !to) return line;

  const clamped = {
    ...line,
    ...(from ? { fromRun: from.runIndex, fromChar: from.charOffset } : {}),
    ...(to ? { toRun: to.runIndex, toChar: to.charOffset } : {}),
  };
  if (!line.segments) return clamped;

  const rangeFrom = from ?? { runIndex: line.fromRun, charOffset: line.fromChar };
  const rangeTo = to ?? { runIndex: line.toRun, charOffset: line.toChar };
  const segments = line.segments
    .filter((segment) => {
      const segmentFrom = { runIndex: segment.fromRun, charOffset: segment.fromChar };
      const segmentTo = { runIndex: segment.toRun, charOffset: segment.toChar };
      return (
        compareParagraphPositions(segmentTo, rangeFrom) > 0 &&
        compareParagraphPositions(segmentFrom, rangeTo) < 0
      );
    })
    .map((segment) => {
      const segmentFrom = { runIndex: segment.fromRun, charOffset: segment.fromChar };
      const segmentTo = { runIndex: segment.toRun, charOffset: segment.toChar };
      const clampedFrom =
        compareParagraphPositions(segmentFrom, rangeFrom) < 0 ? rangeFrom : segmentFrom;
      const clampedTo = compareParagraphPositions(segmentTo, rangeTo) > 0 ? rangeTo : segmentTo;
      return {
        ...segment,
        fromRun: clampedFrom.runIndex,
        fromChar: clampedFrom.charOffset,
        toRun: clampedTo.runIndex,
        toChar: clampedTo.charOffset,
      };
    });
  return { ...clamped, segments };
}

/**
 * A continuation may begin inside a line after changing page width. Keep the
 * new page's geometry, but trim that line to the exact run/character range the
 * pagination plan assigned so already-painted text is not repeated.
 */
function paragraphMeasureForFootnoteSlice(
  measure: ParagraphMetrics,
  slice: Extract<FootnoteNodeFragment, { kind: 'paragraph' }>
): ParagraphMetrics {
  if (
    slice.fromRun == null ||
    slice.fromChar == null ||
    slice.toRun == null ||
    slice.toChar == null
  ) {
    return measure;
  }

  const lines = measure.lines.slice();
  lines[slice.fromLine] = clampLineToContentRange(
    lines[slice.fromLine],
    { runIndex: slice.fromRun, charOffset: slice.fromChar },
    slice.fromLine === slice.toLine - 1
      ? { runIndex: slice.toRun, charOffset: slice.toChar }
      : undefined
  );
  if (slice.toLine - 1 !== slice.fromLine) {
    lines[slice.toLine - 1] = clampLineToContentRange(lines[slice.toLine - 1], undefined, {
      runIndex: slice.toRun,
      charOffset: slice.toChar,
    });
  }
  return { ...measure, lines };
}

function renderMeasuredFootnoteContent(
  content: FootnoteContent,
  footnoteFragment: FootnoteFragment | undefined,
  contentWidth: number,
  context: RenderContext,
  doc: Document
): HTMLElement {
  const container = doc.createElement('div');
  container.className = 'layout-footnote-content';
  container.style.position = 'relative';
  container.style.width = `${contentWidth}px`;
  container.style.height = `${footnoteFragment?.height ?? content.height}px`;
  container.dataset.footnoteId = String(content.id);
  if (footnoteFragment?.continuesFromPrev) container.dataset.continuesFromPrev = 'true';
  if (footnoteFragment?.continuesOnNext) container.dataset.continuesOnNext = 'true';
  if (footnoteFragment?.columnIndex != null) {
    container.dataset.footnoteColumn = String(footnoteFragment.columnIndex);
  }

  const slices: FootnoteNodeFragment[] =
    footnoteFragment?.nodes ??
    content.nodes.map((block, nodeIndex) => {
      const measure = content.metrics[nodeIndex];
      if (block.kind === 'paragraph' && measure?.kind === 'paragraph') {
        return {
          kind: 'paragraph' as const,
          nodeIndex,
          y: 0,
          height: measure.totalHeight,
          fromLine: 0,
          toLine: measure.lines.length,
        };
      }
      if (block.kind === 'table' && measure?.kind === 'table') {
        return {
          kind: 'table' as const,
          nodeIndex,
          y: 0,
          height: measure.totalHeight,
          fromRow: 0,
          toRow: measure.rows.length,
        };
      }
      return {
        kind: block.kind === 'textBox' ? ('textBox' as const) : ('image' as const),
        nodeIndex,
        y: 0,
        height: measure && 'height' in measure ? measure.height : 0,
      };
    });

  let fallbackY = 0;
  for (const slice of slices) {
    const block = content.nodes[slice.nodeIndex];
    const measure = content.metrics[slice.nodeIndex];
    if (!block || !measure) continue;
    const sliceY = footnoteFragment ? slice.y : fallbackY;

    if (slice.kind === 'paragraph' && block.kind === 'paragraph' && measure.kind === 'paragraph') {
      const syntheticFragment: ParagraphFragment = {
        kind: 'paragraph',
        nodeId: block.id,
        x: 0,
        y: sliceY,
        width: contentWidth,
        height: slice.height,
        docFrom: block.docFrom,
        docTo: block.docTo,
        fromLine: slice.fromLine,
        toLine: slice.toLine,
      };
      const sliceMeasure = paragraphMeasureForFootnoteSlice(measure, slice);
      const fragEl = paintParagraphFragment(
        syntheticFragment,
        block,
        sliceMeasure,
        { ...context, section: 'body', contentWidth, positioning: 'absolute' },
        { document: doc }
      );
      fragEl.style.top = `${sliceY}px`;
      fragEl.style.left = '0';
      fragEl.style.width = `${contentWidth}px`;
      fragEl.style.height = `${slice.height}px`;
      container.appendChild(fragEl);
      fallbackY += measure.totalHeight;
    } else if (slice.kind === 'table' && block.kind === 'table' && measure.kind === 'table') {
      const syntheticFragment: TableFragment = {
        kind: 'table',
        nodeId: block.id,
        x: 0,
        y: sliceY,
        width: measure.totalWidth,
        height: slice.height,
        docFrom: block.docFrom,
        docTo: block.docTo,
        fromRow: slice.fromRow,
        toRow: slice.toRow,
        topClip: slice.topClip,
        bottomClip: slice.bottomClip,
      };
      const fragEl = paintTableFragment(
        syntheticFragment,
        block,
        measure,
        { ...context, section: 'body', contentWidth, positioning: 'absolute' },
        { document: doc }
      );
      fragEl.style.top = `${sliceY}px`;
      fragEl.style.left = '0';
      container.appendChild(fragEl);
      fallbackY += measure.totalHeight;
    } else if (slice.kind === 'image' && block.kind === 'image' && measure.kind === 'image') {
      const syntheticFragment: ImageFragment = {
        kind: 'image',
        nodeId: block.id,
        x: 0,
        y: sliceY,
        width: measure.width,
        height: slice.height,
        docFrom: block.docFrom,
        docTo: block.docTo,
      };
      const fragEl = paintImageFragment(
        syntheticFragment,
        block,
        measure,
        { ...context, section: 'body', contentWidth, positioning: 'absolute' },
        { document: doc }
      );
      fragEl.style.top = `${sliceY}px`;
      fragEl.style.left = '0';
      container.appendChild(fragEl);
      fallbackY += measure.height;
    } else if (slice.kind === 'textBox' && block.kind === 'textBox' && measure.kind === 'textBox') {
      const syntheticFragment: TextBoxFragment = {
        kind: 'textBox',
        nodeId: block.id,
        x: 0,
        y: sliceY,
        width: measure.width,
        height: slice.height,
        docFrom: block.docFrom,
        docTo: block.docTo,
      };
      const fragEl = paintTextBoxFragment(
        syntheticFragment,
        block,
        measure,
        { ...context, section: 'body', contentWidth, positioning: 'absolute' },
        { document: doc }
      );
      fragEl.style.top = `${sliceY}px`;
      fragEl.style.left = '0';
      container.appendChild(fragEl);
      fallbackY += measure.height;
    }
  }

  return container;
}

function renderPlainFootnoteItem(fn: FootnoteRenderItem, doc: Document): HTMLElement {
  const fnEl = doc.createElement('div');
  fnEl.style.fontSize = '10px';
  fnEl.style.lineHeight = '1.3';
  fnEl.style.marginBottom = '4px';
  fnEl.style.color = '#000';

  const sup = doc.createElement('sup');
  sup.textContent = fn.displayNumber;
  sup.style.fontSize = '7px';
  sup.style.marginRight = '2px';
  fnEl.appendChild(sup);

  const textNode = doc.createTextNode(' ' + fn.text);
  fnEl.appendChild(textNode);

  return fnEl;
}

export function calculateFootnoteAreaRenderHeight(
  footnotes: FootnoteRenderItem[],
  columns: number = 1
): number {
  const sliced = footnotes.some((fn) => fn.fragment);
  if (sliced) {
    const heights = Array.from({ length: Math.max(1, Math.floor(columns)) }, () => 0);
    for (const fn of footnotes) {
      const columnIndex = Math.min(heights.length - 1, Math.max(0, fn.fragment?.columnIndex ?? 0));
      heights[columnIndex] += fn.fragment?.height ?? fn.content?.height ?? 0;
    }
    return FOOTNOTE_SEPARATOR_HEIGHT + Math.max(...heights);
  }

  const items = footnotes.filter((fn) => fn.content).map((fn) => ({ height: fn.content!.height }));
  if (items.length === 0) return FOOTNOTE_SEPARATOR_HEIGHT;

  // Multi-column footnotes sit side by side: the area is as tall as the tallest
  // balanced column, not the sum of every footnote.
  const partitions = distributeFootnotesIntoColumns(items, columns);
  const tallestColumn = partitions.reduce(
    (max, col) =>
      Math.max(
        max,
        col.reduce((sum, item) => sum + item.height, 0)
      ),
    0
  );
  return FOOTNOTE_SEPARATOR_HEIGHT + tallestColumn;
}

export function renderFootnoteArea(
  footnotes: FootnoteRenderItem[],
  contentWidth: number,
  context: RenderContext,
  doc: Document,
  columns: number = 1
): HTMLElement {
  const container = doc.createElement('div');
  container.className = 'layout-footnote-area';
  container.style.width = `${contentWidth}px`;
  const hasContinuation = footnotes.some((fn) => fn.fragment?.continuesFromPrev);
  const continuesOnNext = footnotes.some((fn) => fn.fragment?.continuesOnNext);
  if (hasContinuation) container.dataset.continuesFromPrev = 'true';
  if (continuesOnNext) container.dataset.continuesOnNext = 'true';

  // Separator line (33% width, Google Docs style). Spans the full area width,
  // above the columns.
  const separator = doc.createElement('div');
  const separatorRuleHeight = 0.5;
  const separatorMargin = (FOOTNOTE_SEPARATOR_HEIGHT - separatorRuleHeight) / 2;
  separator.className = hasContinuation
    ? 'layout-footnote-separator layout-footnote-continuation-separator'
    : 'layout-footnote-separator';
  separator.dataset.separatorKind = hasContinuation ? 'continuation' : 'normal';
  separator.style.width = '33%';
  separator.style.height = `${separatorRuleHeight}px`;
  separator.style.backgroundColor = '#000';
  separator.style.marginBottom = `${separatorMargin}px`;
  separator.style.marginTop = `${separatorMargin}px`;
  container.appendChild(separator);

  const renderItem = (fn: FootnoteRenderItem, width: number): HTMLElement =>
    fn.content
      ? renderMeasuredFootnoteContent(fn.content, fn.fragment, width, context, doc)
      : renderPlainFootnoteItem(fn, doc);

  const columnCount = Math.max(1, Math.floor(columns));
  if (columnCount <= 1) {
    // Single-column footnotes: stack items full width (unchanged behaviour).
    for (const fn of footnotes) {
      container.appendChild(renderItem(fn, contentWidth));
    }
    return container;
  }

  // Multi-column footnotes (w15:footnoteColumns). Balance the items across the
  // columns — order-preserving, the same partition the reserved-height pass
  // used — and lay the columns out side by side. Each footnote was measured at
  // this column width upstream, so it wraps exactly as it paints.
  // Clamp to >= 1px (matches the core measurement path) so a pathologically
  // narrow page with many columns can't yield a zero/negative CSS width.
  const columnWidth = Math.max(
    1,
    (contentWidth - (columnCount - 1) * FOOTNOTE_COLUMN_GAP_PX) / columnCount
  );
  const hasSlices = footnotes.some((fn) => fn.fragment);
  const partitions = hasSlices
    ? Array.from({ length: columnCount }, (_, columnIndex) =>
        footnotes
          .filter((fn) => (fn.fragment?.columnIndex ?? 0) === columnIndex)
          .map((fn) => ({ fn, height: fn.fragment?.height ?? fn.content?.height ?? 0 }))
      )
    : distributeFootnotesIntoColumns(
        footnotes.map((fn) => ({ fn, height: fn.content?.height ?? 0 })),
        columnCount
      );

  const columnsRow = doc.createElement('div');
  columnsRow.className = 'layout-footnote-columns';
  columnsRow.style.display = 'flex';
  columnsRow.style.alignItems = 'flex-start';
  columnsRow.style.gap = `${FOOTNOTE_COLUMN_GAP_PX}px`;

  for (const partition of partitions) {
    const columnEl = doc.createElement('div');
    columnEl.className = 'layout-footnote-column';
    columnEl.style.flex = `0 0 ${columnWidth}px`;
    columnEl.style.width = `${columnWidth}px`;
    for (const { fn } of partition) {
      columnEl.appendChild(renderItem(fn, columnWidth));
    }
    columnsRow.appendChild(columnEl);
  }
  container.appendChild(columnsRow);

  return container;
}
