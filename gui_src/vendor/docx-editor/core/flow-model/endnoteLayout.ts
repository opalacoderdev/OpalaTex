import { formatNumber } from '../docx/numberingParser';
import type { ContentNode, ParagraphBlock } from '../pagination-model/types';
import { footnoteToProseDoc } from '../prosemirror/conversion/toProseDoc';
import type { Endnote, NumberFormat, StyleDefinitions, Theme } from '../types/document';
import { buildBoxTree } from './buildBoxTree';
import { applyFootnotePresentation } from './footnoteLayout';

const NOTE_SEPARATOR_WIDTH_RATIO = 1 / 3;

function createEndnoteSeparatorBlock(contentWidth?: number): ParagraphBlock {
  const separatorWidth =
    contentWidth != null && Number.isFinite(contentWidth)
      ? Math.max(1, contentWidth * NOTE_SEPARATOR_WIDTH_RATIO)
      : undefined;
  const indentRight = separatorWidth != null ? Math.max(0, contentWidth! - separatorWidth) : 0;

  return {
    kind: 'paragraph',
    id: 'endnote-separator',
    attrs: {
      defaultFontSize: 1,
      ...(indentRight > 0 ? { indent: { right: indentRight } } : {}),
      spacing: { before: 0, after: 4 },
      borders: {
        top: { style: 'solid', width: 1, color: '#000000', space: 2 },
      },
    },
    runs: [],
  };
}

/** @public */
export interface EndnoteRefLocation {
  endnoteId: number;
}

/** Collect endnote references in document order. @public */
export function collectEndnoteRefs(nodes: ContentNode[]): EndnoteRefLocation[] {
  const refs: EndnoteRefLocation[] = [];

  const walk = (input: ContentNode[]): void => {
    for (const node of input) {
      if (node.kind === 'paragraph') {
        for (const run of node.runs) {
          if (run.kind === 'text' && run.endnoteRefId != null) {
            refs.push({ endnoteId: run.endnoteRefId });
          }
        }
      } else if (node.kind === 'table') {
        for (const row of node.rows) {
          for (const cell of row.cells) walk(cell.nodes);
        }
      } else if (node.kind === 'textBox') {
        walk(node.content);
      }
    }
  };

  walk(nodes);
  return refs;
}

/** @public */
export interface BuildEndnoteFlowBlocksOptions {
  styles?: StyleDefinitions | null;
  theme?: Theme | null;
  defaultTabMarkTwips?: number | null;
  numFmt?: NumberFormat;
  numStart?: number;
  contentWidth?: number;
}

/** Convert referenced endnotes into trailing body nodes. @public */
export function buildEndnoteFlowBlocks(
  endnotes: Endnote[],
  endnoteRefs: EndnoteRefLocation[],
  options: BuildEndnoteFlowBlocksOptions
): ContentNode[] {
  if (endnotes.length === 0 || endnoteRefs.length === 0) return [];

  const endnoteById = new Map<number, Endnote>();
  for (const endnote of endnotes) {
    if (endnote.noteType === 'normal' || endnote.noteType == null) {
      endnoteById.set(endnote.id, endnote);
    }
  }

  const result: ContentNode[] = [];
  const seen = new Set<number>();
  let displayNumber = options.numStart ?? 1;
  const numFmt = options.numFmt ?? 'lowerRoman';
  let addedSeparator = false;

  for (const ref of endnoteRefs) {
    if (seen.has(ref.endnoteId)) continue;
    seen.add(ref.endnoteId);
    const endnote = endnoteById.get(ref.endnoteId);
    if (!endnote) continue;

    if (!addedSeparator) {
      result.push(createEndnoteSeparatorBlock(options.contentWidth));
      addedSeparator = true;
    }

    const pmDoc = footnoteToProseDoc(endnote.content, {
      styles: options.styles ?? undefined,
      theme: options.theme ?? null,
      defaultTabMarkTwips: options.defaultTabMarkTwips ?? null,
    });
    const rawNodes = buildBoxTree(pmDoc, { theme: options.theme ?? undefined });
    result.push(...applyFootnotePresentation(rawNodes, formatNumber(displayNumber, numFmt)));
    displayNumber++;
  }

  return result;
}
