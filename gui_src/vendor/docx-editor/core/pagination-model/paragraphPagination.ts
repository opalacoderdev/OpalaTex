/** Paragraph-level pagination rules shared by the layout cursor and consumers. */

import type { ContentNode, ParagraphBlock, ParagraphMetrics } from './types';

/**
 * Minimum number of lines Word may place in the first fragment of a
 * paragraph. Two- and three-line paragraphs stay whole when they fit a fresh
 * region; longer paragraphs require two lines on both sides of a split.
 */
export function getMinimumParagraphFragmentLineCount(
  block: ParagraphBlock,
  lineCount: number
): number {
  if (lineCount <= 1 || block.attrs?.widowControl === false) return Math.min(1, lineCount);
  if (lineCount <= 3) return lineCount;
  return 2;
}

export function paragraphLinesHeight(measure: ParagraphMetrics, count: number): number {
  let height = 0;
  for (let i = 0; i < Math.min(count, measure.lines.length); i++) {
    const line = measure.lines[i];
    height += line.lineHeight + (line.floatSkipBefore ?? 0);
  }
  return height;
}

/**
 * Check if a paragraph has keepLines property (all lines must stay together).
 */
export function hasKeepLines(block: ContentNode): boolean {
  if (block.kind !== 'paragraph') return false;
  const para = block as ParagraphBlock;
  return para.attrs?.keepLines === true;
}

/**
 * Check if a paragraph should start on a new page (pageBreakBefore).
 */
export function hasPageBreakBefore(block: ContentNode): boolean {
  if (block.kind !== 'paragraph') return false;
  const para = block as ParagraphBlock;
  return para.attrs?.pageBreakBefore === true;
}
