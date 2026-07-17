import type {
  TableFragment,
  TableBlock,
  TableMetrics,
  TableCell,
  TableCellMetrics,
  ParagraphBlock,
  ParagraphMetrics,
  ParagraphFragment,
} from '../pagination-model/types';
import type { RenderContext } from './paintPage';
import { paintFloatingImagesLayer } from './floatingImageLayer';
import { floatingImageIsBehindDoc, floatingImageWrapsText } from './floatingImageFlow';
import { getParagraphRevisionMetadata, paintParagraphFragment } from './renderParagraph';
import { paragraphLayout, type FloatingImageZone } from '../flow-model/metrics';
import { extractCellFloatingImages } from './renderTableCellFloating';
import { buildRowYPositions } from './renderTableBorders';
import { renderSdtBoundaryBoxesForExtents, type SdtBoundaryExtent } from './sdtBoundary';
import { tagSdtCellBlock } from './renderTableSdt';
import {
  applyWholeTableRevisionDom,
  cellInlineImageRevisionBars,
  getWholeTableRevisionMetadata,
  nestedCellTableRevisionContext,
  registerCellFloatingImageRevisions,
  registerCellParagraphRevision,
  registerClippedTableRevisionSpans,
  type CellFloatRevisionContext,
  type NestedTableRevisionContext,
} from './renderTableRevisionBars';
import { TABLE_CLASS_NAMES, paintTableRow, type SpanningCell } from './renderTable';

export function renderCellContent(
  cell: TableCell,
  cellMetrics: TableCellMetrics,
  context: RenderContext,
  doc: Document,
  revisionContext?: CellFloatRevisionContext
): HTMLElement {
  const contentEl = doc.createElement('div');
  contentEl.className = TABLE_CLASS_NAMES.cellContent;
  contentEl.style.position = 'relative';
  const padLeft = cell.padding?.left ?? 7;
  const padRight = cell.padding?.right ?? 7;
  const contentWidth = Math.max(0, cellMetrics.width - padLeft - padRight);
  contentEl.style.width = `${contentWidth}px`;

  const cellFloatingImages = extractCellFloatingImages(cell, cellMetrics, contentWidth);

  if (revisionContext) {
    registerCellFloatingImageRevisions(cellFloatingImages, revisionContext);
  }

  let floatingZones: FloatingImageZone[] | undefined;
  if (cellFloatingImages.length > 0) {
    floatingZones = cellFloatingImages.filter(floatingImageWrapsText).map((img) => {
      const rectRight = img.x + img.width + img.distRight;
      const rectTop = img.y - img.distTop;
      const rectBottom = img.y + img.height + img.distBottom;

      let leftMargin = 0;
      let rightMargin = 0;
      const wt = img.wrapText ?? 'bothSides';
      if (wt === 'right') {
        leftMargin = rectRight;
      } else if (wt === 'left') {
        rightMargin = contentWidth - (img.x - img.distLeft);
      } else if (img.side === 'left') {
        leftMargin = rectRight;
      } else {
        rightMargin = contentWidth - (img.x - img.distLeft);
      }
      return { leftMargin, rightMargin, topY: rectTop, bottomY: rectBottom };
    });

    const behindFloatingImages = cellFloatingImages.filter(floatingImageIsBehindDoc);
    if (behindFloatingImages.length > 0) {
      contentEl.appendChild(
        paintFloatingImagesLayer(behindFloatingImages, doc, {
          layerClass: 'layout-cell-floating-images-layer',
          itemClass: 'layout-cell-floating-image',
          sizing: 'fullSize',
          layerMode: 'behind',
        })
      );
    }
  }

  let cumulativeY = 0;
  let previousParagraphAfter = 0;
  const sdtExtents: SdtBoundaryExtent[] = [];
  for (let i = 0; i < cell.nodes.length; i++) {
    const block = cell.nodes[i];
    const measure = cellMetrics.metrics[i];

    if (block?.kind === 'paragraph' && measure?.kind === 'paragraph') {
      const paragraphBlock = block as ParagraphBlock;
      let paragraphMetrics = measure as ParagraphMetrics;
      const spacing = paragraphBlock.attrs?.spacing;
      const effectiveSpaceBefore = Math.max(previousParagraphAfter, spacing?.before ?? 0);
      cumulativeY += effectiveSpaceBefore;

      if (floatingZones && floatingZones.length > 0) {
        paragraphMetrics = paragraphLayout(paragraphBlock, contentWidth, {
          floatingZones,
          paragraphYOffset: cumulativeY,
        });
      }

      const syntheticFragment: ParagraphFragment = {
        kind: 'paragraph',
        nodeId: paragraphBlock.id,
        x: 0,
        y: 0,
        width: contentWidth,
        height: paragraphMetrics.totalHeight,
        fromLine: 0,
        toLine: paragraphMetrics.lines.length,
        docFrom: paragraphBlock.docFrom,
        docTo: paragraphBlock.docTo,
      };

      const cellContext = { ...context, insideTableCell: true as const };
      const fragEl = paintParagraphFragment(
        syntheticFragment,
        paragraphBlock,
        paragraphMetrics,
        cellContext,
        {
          document: doc,
          inlineImageRevisionBars: revisionContext
            ? cellInlineImageRevisionBars(revisionContext, cumulativeY)
            : undefined,
        }
      );
      const paragraphRevision = getParagraphRevisionMetadata(paragraphBlock);
      if (revisionContext && paragraphRevision) {
        registerCellParagraphRevision(
          revisionContext,
          paragraphRevision,
          revisionContext.rowTop + revisionContext.contentTop + cumulativeY,
          syntheticFragment.height
        );
      }

      fragEl.style.position = 'relative';
      if (effectiveSpaceBefore > 0) {
        fragEl.style.marginTop = `${effectiveSpaceBefore}px`;
      }
      tagSdtCellBlock(
        fragEl,
        sdtExtents,
        paragraphBlock.sdtGroups,
        cumulativeY,
        cumulativeY + paragraphMetrics.totalHeight
      );
      contentEl.appendChild(fragEl);
      cumulativeY += paragraphMetrics.totalHeight;
      previousParagraphAfter = spacing?.after ?? 0;
    } else if (block?.kind === 'table' && measure?.kind === 'table') {
      const tableBlock = block as TableBlock;
      const tableMeasure = measure as TableMetrics;
      const effectiveSpaceBefore = previousParagraphAfter;

      const nestedTableTop =
        (revisionContext?.rowTop ?? 0) +
        (revisionContext?.contentTop ?? 0) +
        cumulativeY +
        effectiveSpaceBefore;
      const nestedTableEl = renderNestedTable(
        tableBlock,
        tableMeasure,
        context,
        doc,
        revisionContext
          ? nestedCellTableRevisionContext(
              revisionContext,
              nestedTableTop,
              tableMeasure.totalHeight
            )
          : undefined
      );
      nestedTableEl.style.position = 'relative';
      if (effectiveSpaceBefore > 0) {
        nestedTableEl.style.marginTop = `${effectiveSpaceBefore}px`;
      }
      tagSdtCellBlock(
        nestedTableEl,
        sdtExtents,
        tableBlock.sdtGroups,
        cumulativeY + effectiveSpaceBefore,
        cumulativeY + effectiveSpaceBefore + tableMeasure.totalHeight
      );
      contentEl.appendChild(nestedTableEl);
      cumulativeY += effectiveSpaceBefore + tableMeasure.totalHeight;
      previousParagraphAfter = 0;
    }
  }

  if (previousParagraphAfter > 0) {
    contentEl.style.paddingBottom = `${previousParagraphAfter}px`;
  }

  const frontFloatingImages = cellFloatingImages.filter((img) => !floatingImageIsBehindDoc(img));
  if (frontFloatingImages.length > 0) {
    contentEl.appendChild(
      paintFloatingImagesLayer(frontFloatingImages, doc, {
        layerClass: 'layout-cell-floating-images-layer',
        itemClass: 'layout-cell-floating-image',
        sizing: 'fullSize',
        layerMode: 'front',
      })
    );
  }

  renderSdtBoundaryBoxesForExtents(contentEl, contentWidth, sdtExtents, doc);

  return contentEl;
}

function renderNestedTable(
  block: TableBlock,
  measure: TableMetrics,
  context: RenderContext,
  doc: Document,
  revisionContext?: NestedTableRevisionContext
): HTMLElement {
  const tableEl = doc.createElement('div');
  tableEl.className = `${TABLE_CLASS_NAMES.table} layout-nested-table`;

  tableEl.style.position = 'relative';
  tableEl.style.width = `${measure.totalWidth}px`;
  tableEl.style.display = 'block';

  if (block.justification === 'center') {
    tableEl.style.marginLeft = 'auto';
    tableEl.style.marginRight = 'auto';
  } else if (block.justification === 'right') {
    tableEl.style.marginLeft = 'auto';
  } else if (block.indent) {
    tableEl.style.marginLeft = `${block.indent}px`;
  }

  tableEl.dataset.blockId = String(block.id);

  if (block.docFrom !== undefined) {
    tableEl.dataset.docFrom = String(block.docFrom);
  }
  if (block.docTo !== undefined) {
    tableEl.dataset.docTo = String(block.docTo);
  }

  const wholeTableRevision = getWholeTableRevisionMetadata(block.rows);
  const wholeTableTracked = wholeTableRevision != null;
  if (wholeTableRevision) {
    applyWholeTableRevisionDom(tableEl, wholeTableRevision);
  }

  const rowYPositions = buildRowYPositions(measure.rows);
  if (revisionContext) {
    const syntheticFragment: TableFragment = {
      kind: 'table',
      nodeId: block.id,
      x: 0,
      y: 0,
      width: measure.totalWidth,
      height: measure.totalHeight,
      fromRow: 0,
      toRow: measure.rows.length,
    };
    registerClippedTableRevisionSpans(revisionContext, syntheticFragment, block, measure);
  }

  const bidi = block.bidi === true;
  const tableWidth = measure.columnWidths.reduce((w, cw) => w + (cw ?? 0), 0);
  const spanningCells = new Map<string, SpanningCell>();

  for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex++) {
    const row = block.rows[rowIndex];
    const rowMeasure = measure.rows[rowIndex];

    if (!row || !rowMeasure) continue;

    const rowEl = paintTableRow(
      row,
      rowMeasure,
      rowIndex,
      rowYPositions[rowIndex] ?? 0,
      measure.columnWidths,
      block.rows.length,
      context,
      doc,
      spanningCells,
      rowYPositions,
      undefined,
      wholeTableTracked,
      bidi,
      tableWidth,
      revisionContext
        ? {
            collector: revisionContext.collector,
            originTop: revisionContext.originTop,
            rowTop: revisionContext.tableTop + (rowYPositions[rowIndex] ?? 0),
            clipTop: revisionContext.clipTop,
            clipBottom: revisionContext.clipBottom,
          }
        : undefined
    );
    tableEl.appendChild(rowEl);
  }

  tableEl.style.height = `${rowYPositions[block.rows.length] ?? 0}px`;

  return tableEl;
}
