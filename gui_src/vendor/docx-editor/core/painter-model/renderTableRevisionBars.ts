import type {
  TableFragment,
  TableBlock,
  TableMetrics,
  TableCell,
  TableCellMetrics,
  BorderKind,
} from '../pagination-model/types';
import type { RevisionInfo } from '../types/content/trackedChange';
import { buildRowYPositions, isVisibleBorder } from './renderTableBorders';
import { getImageRevisionData } from './renderImage';
import type {
  RevisionBarCollector,
  RevisionBarSpan,
  RevisionIndicatorKind,
  RevisionMetadata,
} from './revisionIndicators';
import type { FloatingImagePaintRecord } from './floatingImageLayer';

export interface CellFloatRevisionContext {
  collector: RevisionBarCollector;
  /** Table fragment top in the collector's coordinate space. */
  originTop: number;
  /** Row top in table-fragment coordinates. */
  rowTop: number;
  rowHeight: number;
  /** Visible table window in table-fragment coordinates. */
  clipTop: number;
  clipBottom: number;
  /** Painted content element box within the row, including vertical alignment. */
  contentTop: number;
  contentHeight: number;
}

export interface NestedTableRevisionContext {
  collector: RevisionBarCollector;
  /** Outermost table fragment top in collector coordinates. */
  originTop: number;
  /** Nested table top in outermost table-fragment coordinates. */
  tableTop: number;
  /** Visible intersection inherited from every owning table/cell. */
  clipTop: number;
  clipBottom: number;
}

interface ResolvedCellContentBox {
  top: number;
  height: number;
  justifyContent?: 'flex-start' | 'center' | 'flex-end';
}

function paintedBorderWidth(border: BorderKind | undefined, paints: boolean): number {
  if (!paints || !isVisibleBorder(border)) return 0;
  const width = border.width ?? 1;
  return border.style === 'double' ? Math.max(width, 3) : width;
}

/**
 * Resolve the same border-box → padding-box → flex-aligned content geometry
 * that paintTableCell expresses through CSS. The revision collector consumes
 * this numeric form so its spans follow the painted content element exactly.
 */
export function resolveCellContentBox(
  cell: TableCell,
  cellMetrics: TableCellMetrics,
  rowHeight: number,
  borderFlags: {
    isFirstRow: boolean;
    isLastRow: boolean;
    isFirstCol: boolean;
    isLastCol: boolean;
  }
): ResolvedCellContentBox {
  const padTop = cell.padding?.top ?? 1;
  const padBottom = cell.padding?.bottom ?? 1;
  const borderTop = paintedBorderWidth(cell.borders?.top, borderFlags.isFirstRow);
  const borderBottom = paintedBorderWidth(cell.borders?.bottom, true);
  const contentHeight = Math.max(0, (cellMetrics.height ?? 0) - padTop - padBottom);
  const availableHeight = Math.max(0, rowHeight - borderTop - borderBottom - padTop - padBottom);
  const contentFillsBox = (cellMetrics.height ?? 0) >= rowHeight - 0.5;
  const slack = Math.max(0, availableHeight - contentHeight);

  let alignmentOffset = 0;
  let justifyContent: ResolvedCellContentBox['justifyContent'];
  if (cell.verticalAlign && !contentFillsBox) {
    if (cell.verticalAlign === 'center') {
      alignmentOffset = slack / 2;
      justifyContent = 'center';
    } else if (cell.verticalAlign === 'bottom') {
      alignmentOffset = slack;
      justifyContent = 'flex-end';
    } else {
      justifyContent = 'flex-start';
    }
  }

  return {
    top: borderTop + padTop + alignmentOffset,
    height: Math.min(contentHeight, availableHeight),
    justifyContent,
  };
}

function sameRevisionBurst(
  left: RevisionInfo | undefined,
  right: RevisionInfo | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    (left.author ?? '') === (right.author ?? '') &&
    (left.date ?? null) === (right.date ?? null)
  );
}

function getRowRevision(
  row: TableBlock['rows'][number]
): { kind: RevisionIndicatorKind; metadata: RevisionMetadata } | null {
  if (row.trackedDel) {
    return {
      kind: 'del',
      metadata: {
        revisionId: row.trackedDel.revisionId,
        author: row.trackedDel.author,
        date: row.trackedDel.date,
      },
    };
  }
  if (row.trackedIns) {
    return {
      kind: 'ins',
      metadata: {
        revisionId: row.trackedIns.revisionId,
        author: row.trackedIns.author,
        date: row.trackedIns.date,
      },
    };
  }
  return null;
}

export function getWholeTableRevisionMetadata(
  rows: TableBlock['rows']
): { kind: RevisionIndicatorKind; metadata: RevisionMetadata } | null {
  const firstRow = rows[0];
  const sharedIns = firstRow?.trackedIns;
  const sharedDel = firstRow?.trackedDel;
  const wholeTableTracked =
    rows.length > 0 &&
    rows.every((row) => {
      if (sharedIns) return sameRevisionBurst(row.trackedIns, sharedIns);
      if (sharedDel) return sameRevisionBurst(row.trackedDel, sharedDel);
      return false;
    });

  if (!wholeTableTracked) {
    return null;
  }

  const revision = (sharedIns ?? sharedDel)!;
  return {
    kind: sharedIns ? 'ins' : 'del',
    metadata: {
      revisionId: revision.revisionId,
      author: revision.author,
      date: revision.date,
    },
  };
}

export function applyWholeTableRevisionDom(
  tableEl: HTMLElement,
  wholeTableRevision: { kind: RevisionIndicatorKind; metadata: RevisionMetadata }
): void {
  tableEl.classList.add('ep-revision-table', `ep-revision-${wholeTableRevision.kind}`);
  if (wholeTableRevision.metadata.revisionId != null) {
    tableEl.dataset.revisionId = String(wholeTableRevision.metadata.revisionId);
  }
  if (wholeTableRevision.metadata.author) {
    tableEl.dataset.revisionAuthor = wholeTableRevision.metadata.author;
  }
  if (wholeTableRevision.metadata.date) {
    tableEl.dataset.revisionDate = wholeTableRevision.metadata.date;
  }
}

function getRepeatedHeaderHeight(fragment: TableFragment, measure: TableMetrics): number {
  const headerRowCount = fragment.headerRowCount ?? 0;
  if (!(headerRowCount > 0 && fragment.continuesFromPrev)) {
    return 0;
  }

  let headerHeight = 0;
  for (let hdrIdx = 0; hdrIdx < headerRowCount; hdrIdx++) {
    headerHeight += measure.rows[hdrIdx]?.height ?? 0;
  }
  return headerHeight;
}

export function getTableRevisionBarSpans(
  fragment: TableFragment,
  block: TableBlock,
  measure: TableMetrics,
  originTop: number
): RevisionBarSpan[] {
  const wholeTableRevision = getWholeTableRevisionMetadata(block.rows);
  const headerHeight = getRepeatedHeaderHeight(fragment, measure);
  const rowYPositions = buildRowYPositions(measure.rows);
  const winTop = (rowYPositions[fragment.fromRow] ?? 0) + (fragment.topClip ?? 0);
  const visibleHeight =
    fragment.bottomClip !== undefined
      ? Math.round(fragment.height)
      : headerHeight + Math.max(0, (rowYPositions[fragment.toRow] ?? 0) - winTop);
  const winBottom = winTop + Math.max(0, visibleHeight - headerHeight);

  if (wholeTableRevision) {
    return [
      {
        top: originTop,
        height: visibleHeight,
        kind: wholeTableRevision.kind,
        ...wholeTableRevision.metadata,
      },
    ];
  }

  const spans: RevisionBarSpan[] = [];
  const headerRowCount = fragment.headerRowCount ?? 0;
  if (headerRowCount > 0 && fragment.continuesFromPrev) {
    let repeatedHeaderTop = originTop;
    for (let hdrIdx = 0; hdrIdx < headerRowCount; hdrIdx++) {
      const revision = getRowRevision(block.rows[hdrIdx]!);
      const rowHeight = measure.rows[hdrIdx]?.height ?? 0;
      if (revision && rowHeight > 0) {
        spans.push({
          top: repeatedHeaderTop,
          height: rowHeight,
          kind: revision.kind,
          ...revision.metadata,
        });
      }
      repeatedHeaderTop += rowHeight;
    }
  }

  for (let rowIndex = fragment.fromRow; rowIndex < fragment.toRow; rowIndex++) {
    const revision = getRowRevision(block.rows[rowIndex]!);
    if (!revision) {
      continue;
    }

    const rowTop = rowYPositions[rowIndex] ?? 0;
    const rowBottom = rowYPositions[rowIndex + 1] ?? rowTop;
    const visibleTop = Math.max(rowTop, winTop);
    const visibleBottom = Math.min(rowBottom, winBottom);
    if (visibleBottom <= visibleTop) {
      continue;
    }

    spans.push({
      top: originTop + headerHeight + (visibleTop - winTop),
      height: visibleBottom - visibleTop,
      kind: revision.kind,
      ...revision.metadata,
    });
  }

  return spans;
}

export function registerCellFloatingImageRevisions(
  cellFloatingImages: FloatingImagePaintRecord[],
  revisionContext: CellFloatRevisionContext
): void {
  const cellContentTop = revisionContext.rowTop + revisionContext.contentTop;
  const cellContentBottom = cellContentTop + revisionContext.contentHeight;
  for (const image of cellFloatingImages) {
    const revision = getImageRevisionData(image);
    if (!revision) continue;
    const imageTop = cellContentTop + image.y;
    const imageBottom = imageTop + image.height;
    const visibleTop = Math.max(imageTop, cellContentTop, revisionContext.clipTop);
    const visibleBottom = Math.min(imageBottom, cellContentBottom, revisionContext.clipBottom);
    if (visibleBottom <= visibleTop) continue;
    revisionContext.collector.register({
      top: revisionContext.originTop + visibleTop,
      height: visibleBottom - visibleTop,
      kind: revision.kind,
      ...revision.metadata,
    });
  }
}

export function registerCellParagraphRevision(
  revisionContext: CellFloatRevisionContext,
  paragraphRevision: { kind: RevisionIndicatorKind; metadata: RevisionMetadata },
  paragraphTop: number,
  paragraphHeight: number
): void {
  const visibleTop = Math.max(paragraphTop, revisionContext.clipTop);
  const visibleBottom = Math.min(
    paragraphTop + paragraphHeight,
    revisionContext.rowTop + revisionContext.contentTop + revisionContext.contentHeight,
    revisionContext.clipBottom
  );
  if (visibleBottom <= visibleTop) return;
  revisionContext.collector.register({
    top: revisionContext.originTop + visibleTop,
    height: visibleBottom - visibleTop,
    kind: paragraphRevision.kind,
    ...paragraphRevision.metadata,
  });
}

export function registerClippedTableRevisionSpans(
  revisionContext: NestedTableRevisionContext,
  fragment: TableFragment,
  block: TableBlock,
  measure: TableMetrics
): void {
  const clipTop = revisionContext.originTop + revisionContext.clipTop;
  const clipBottom = revisionContext.originTop + revisionContext.clipBottom;
  for (const span of getTableRevisionBarSpans(
    fragment,
    block,
    measure,
    revisionContext.originTop + revisionContext.tableTop
  )) {
    const visibleTop = Math.max(span.top, clipTop);
    const visibleBottom = Math.min(span.top + span.height, clipBottom);
    if (visibleBottom <= visibleTop) continue;
    revisionContext.collector.register({
      ...span,
      top: visibleTop,
      height: visibleBottom - visibleTop,
    });
  }
}

export function cellInlineImageRevisionBars(
  revisionContext: CellFloatRevisionContext,
  cumulativeY: number
) {
  return {
    collector: revisionContext.collector,
    originTop:
      revisionContext.originTop + revisionContext.rowTop + revisionContext.contentTop + cumulativeY,
    clipTop:
      revisionContext.originTop +
      Math.max(revisionContext.clipTop, revisionContext.rowTop + revisionContext.contentTop),
    clipBottom:
      revisionContext.originTop +
      Math.min(
        revisionContext.clipBottom,
        revisionContext.rowTop + revisionContext.contentTop + revisionContext.contentHeight
      ),
  };
}

export function nestedCellTableRevisionContext(
  revisionContext: CellFloatRevisionContext,
  nestedTableTop: number,
  tableHeight: number
): NestedTableRevisionContext {
  return {
    collector: revisionContext.collector,
    originTop: revisionContext.originTop,
    tableTop: nestedTableTop,
    clipTop: Math.max(
      revisionContext.clipTop,
      revisionContext.rowTop + revisionContext.contentTop,
      nestedTableTop
    ),
    clipBottom: Math.min(
      revisionContext.clipBottom,
      revisionContext.rowTop + revisionContext.contentTop + revisionContext.contentHeight,
      nestedTableTop + tableHeight
    ),
  };
}
