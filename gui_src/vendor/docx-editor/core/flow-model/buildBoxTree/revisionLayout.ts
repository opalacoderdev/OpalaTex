import type { Node as PMNode } from 'prosemirror-model';
import type { ParagraphAttrs, ParagraphBlock } from '../../pagination-model/types';
import type { ParagraphAttrs as PMParagraphAttrs } from '../../prosemirror/schema/nodes';

export function isStructuralPageBreakParagraph(node: PMNode): boolean {
  const pmAttrs = node.attrs as PMParagraphAttrs;
  return pmAttrs.pageBreakBefore === true && node.childCount === 0;
}

export function suppressDeletedListMarkerRun(
  runs: ParagraphBlock['runs'],
  attrs: ParagraphAttrs
): ParagraphBlock['runs'] {
  const marker = attrs.listMarker?.replace(/\u00a0/g, ' ').trim();
  if (!marker) return runs;

  const firstContentIndex = runs.findIndex(
    (run) => run.kind !== 'text' || run.text.replace(/\u00a0/g, ' ').trim().length > 0
  );
  if (firstContentIndex < 0) return runs;

  const candidate = runs[firstContentIndex];
  if (
    candidate.kind !== 'text' ||
    !candidate.isDeletion ||
    candidate.text.replace(/\u00a0/g, ' ').trim() !== marker
  ) {
    return runs;
  }

  let prefixEnd = firstContentIndex + 1;
  while (prefixEnd < runs.length) {
    const suffix = runs[prefixEnd];
    if (
      suffix.kind !== 'text' ||
      !suffix.isDeletion ||
      suffix.text.replace(/\u00a0/g, ' ').trim().length > 0
    ) {
      break;
    }
    prefixEnd++;
  }

  // Word coalesces the complete deleted marker prefix — marker plus its
  // separately-authored spaced separator — with the automatic marker. Keep
  // those runs in PM for review/round-trip, but omit the cluster from body
  // measurement/paint and style the one painted marker as the deletion.
  attrs.listMarkerRevision = 'del';
  return runs.filter((_, index) => index < firstContentIndex || index >= prefixEnd);
}

export function hasAuthoredNonRevisionVisualContent(block: ParagraphBlock): boolean {
  const attrs = block.attrs;
  if (!attrs) return false;
  if (attrs.shading) return true;
  if (attrs.borders && Object.values(attrs.borders).some(Boolean)) return true;
  if (attrs.spacingOverrides?.before || attrs.spacingOverrides?.after) return true;
  return false;
}
