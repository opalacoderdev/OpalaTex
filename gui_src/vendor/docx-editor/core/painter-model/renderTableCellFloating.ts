/**
 * Floating-image extraction for table cells.
 *
 * Pulls anchored/floating images out of a cell's paragraphs and computes their
 * positions relative to the cell content area. Split out of renderTable.ts so
 * that file stays focused on row/cell/fragment painting.
 */

import type {
  ImageRun,
  ParagraphBlock,
  ParagraphMetrics,
  TableCell,
  TableCellMetrics,
  TableMetrics,
} from '../pagination-model/types';
import { emuToPixels } from '../utils/units';
import { imageWrapTextFromCssFloat, isFloatingImageRun } from './floatingImageFlow';

/** Info about a floating image extracted from a cell paragraph */
export interface CellFloatingImage {
  src: string;
  width: number;
  height: number;
  alt?: string;
  transform?: string;
  isInsertion?: boolean;
  isDeletion?: boolean;
  changeAuthor?: string;
  changeDate?: string;
  changeRevisionId?: number;
  x: number;
  y: number;
  side: 'left' | 'right';
  distTop: number;
  distBottom: number;
  distLeft: number;
  distRight: number;
  /** OOXML wrapText: which side(s) TEXT flows on */
  wrapText?: 'bothSides' | 'left' | 'right' | 'largest';
  /** Wrap type (square, tight, through, behind, inFront) */
  wrapType?: string;
  docFrom?: number;
  docTo?: number;
}

/**
 * Extract floating images from cell paragraphs and compute their positions
 * relative to the cell content area.
 *
 * NOTE: The horizontal/vertical position logic here mirrors
 * extractFloatingImagesFromParagraph() in paintPage.ts. Kept separate
 * because the coordinate systems differ (cell-relative vs page-relative).
 */
export function extractCellFloatingImages(
  cell: TableCell,
  cellMetrics: TableCellMetrics,
  contentWidth: number
): CellFloatingImage[] {
  const result: CellFloatingImage[] = [];
  let paragraphY = 0;

  for (let nodeIndex = 0; nodeIndex < cell.nodes.length; nodeIndex++) {
    const block = cell.nodes[nodeIndex];
    if (block?.kind !== 'paragraph') {
      // Use actual measured height for Y tracking
      const nodeMetrics = cellMetrics.metrics[nodeIndex];
      if (nodeMetrics && nodeMetrics.kind === 'table') {
        paragraphY += (nodeMetrics as TableMetrics).totalHeight ?? 0;
      }
      continue;
    }
    const pBlock = block as ParagraphBlock;

    for (const run of pBlock.runs) {
      if (run.kind !== 'image') continue;
      const imgRun = run as ImageRun;
      if (!isFloatingImageRun(imgRun)) continue;

      const position = imgRun.position;
      const distTop = imgRun.distTop ?? 0;
      const distBottom = imgRun.distBottom ?? 0;
      const distLeft = imgRun.distLeft ?? 12;
      const distRight = imgRun.distRight ?? 12;

      // Horizontal position within cell
      let side: 'left' | 'right' = 'left';
      let x = 0;

      if (position?.horizontal) {
        const h = position.horizontal;
        if (h.align === 'right') {
          side = 'right';
          x = contentWidth - imgRun.width;
        } else if (h.align === 'left') {
          x = 0;
        } else if (h.align === 'center') {
          x = (contentWidth - imgRun.width) / 2;
        } else if (h.posOffset !== undefined) {
          x = emuToPixels(h.posOffset);
          side = x > contentWidth / 2 ? 'right' : 'left';
        }
      } else if (imgRun.cssFloat === 'right') {
        side = 'right';
        x = contentWidth - imgRun.width;
      }

      // Vertical position within cell
      let y = paragraphY;
      if (position?.vertical) {
        const v = position.vertical;
        if (v.posOffset !== undefined) {
          y = paragraphY + emuToPixels(v.posOffset);
        } else if (v.align === 'top') {
          y = 0;
        }
      }

      // Clamp within cell bounds
      x = Math.max(0, Math.min(x, contentWidth - imgRun.width));

      result.push({
        src: imgRun.src,
        width: imgRun.width,
        height: imgRun.height,
        alt: imgRun.alt,
        transform: imgRun.transform,
        isInsertion: imgRun.isInsertion,
        isDeletion: imgRun.isDeletion,
        changeAuthor: imgRun.changeAuthor,
        changeDate: imgRun.changeDate,
        changeRevisionId: imgRun.changeRevisionId,
        x,
        y,
        side,
        distTop,
        distBottom,
        distLeft,
        distRight,
        wrapText: imageWrapTextFromCssFloat(imgRun.cssFloat),
        wrapType: imgRun.wrapType,
        docFrom: imgRun.docFrom,
        docTo: imgRun.docTo,
      });
    }

    // Use actual measured height for Y tracking
    const nodeMetrics = cellMetrics.metrics[nodeIndex];
    if (nodeMetrics && nodeMetrics.kind === 'paragraph') {
      paragraphY += (nodeMetrics as ParagraphMetrics).totalHeight;
    }
  }

  return result;
}
