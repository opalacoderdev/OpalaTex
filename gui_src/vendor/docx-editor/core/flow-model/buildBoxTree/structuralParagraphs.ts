/**
 * Structural-empty-paragraph handling for the box-tree builder.
 *
 * Word documents routinely carry an empty paragraph directly after a table —
 * it exists so the caret has somewhere to go, not because the author wanted a
 * blank line. These helpers detect that shape so pagination can suppress its
 * height, while paragraphs that merely LOOK empty but carry authored visuals
 * (shading, borders, explicit spacing, tracked paragraph marks) keep theirs.
 */

import type { ContentNode } from '../../pagination-model/types';

export function hasAuthoredVisualContent(block: ContentNode): boolean {
  if (block.kind !== 'paragraph') return false;
  const attrs = block.attrs;
  if (!attrs) return false;
  if (attrs.shading) return true;
  if (attrs.borders && Object.values(attrs.borders).some(Boolean)) return true;
  if (attrs.spacingOverrides?.before || attrs.spacingOverrides?.after) return true;
  if (attrs.pPrIns || attrs.pPrDel) return true;
  return false;
}

export function suppressStructuralEmptyParagraphsAfterTables(blocks: ContentNode[]): ContentNode[] {
  const trailingEmptyAfterTable = new Set<number>();
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const cur = blocks[i];
    if (prev.kind !== 'table') continue;
    if (cur.kind !== 'paragraph') continue;
    if (cur.runs.length > 0) continue;
    if (hasAuthoredVisualContent(cur)) continue;
    trailingEmptyAfterTable.add(i);
  }

  return blocks.map((block, index) => {
    if (!trailingEmptyAfterTable.has(index) || block.kind !== 'paragraph') {
      return block;
    }

    return {
      ...block,
      attrs: { ...(block.attrs ?? {}), suppressEmptyParagraphHeight: true },
    };
  });
}
