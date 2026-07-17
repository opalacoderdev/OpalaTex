import type { FootnoteContent, Page } from '../pagination-model/types';
import type { FootnoteRenderItem } from '../painter-model';
import { getFootnoteText } from '../docx/footnoteParser';
import type { Document, Footnote } from '../types/document';

type ResolveFootnoteContent = (
  footnoteId: number,
  pageNumber: number,
  page: Page | undefined
) => FootnoteContent | undefined;

/**
 * Turn the page→footnote-id map into the per-page render payload that
 * `paintPages` consumes via `footnotesByPage`. Skips non-`normal` notes
 * (separators, continuation notices), reads the display number out of the
 * content map, and pulls plain text via `getFootnoteText`.
 */
function buildFootnoteRenderItemsInternal(
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, FootnoteContent>,
  doc: Document | null,
  pages?: Page[],
  resolveFootnoteContent?: ResolveFootnoteContent
): Map<number, FootnoteRenderItem[]> {
  const result = new Map<number, FootnoteRenderItem[]>();
  if (!doc?.package?.footnotes) return result;

  const fnLookup = new Map<number, Footnote>();
  for (const fn of doc.package.footnotes) {
    if (fn.noteType && fn.noteType !== 'normal') continue;
    fnLookup.set(fn.id, fn);
  }

  const pageLookup = new Map(pages?.map((page) => [page.number, page]));
  for (const [pageNumber, footnoteIds] of pageFootnoteMap) {
    const items: FootnoteRenderItem[] = [];
    const page = pageLookup.get(pageNumber);
    const fragments = page?.footnoteFragments;
    if (fragments?.length) {
      for (const fragment of fragments) {
        const fn = fnLookup.get(fragment.footnoteId);
        const content =
          resolveFootnoteContent?.(fragment.footnoteId, pageNumber, page) ??
          footnoteContentMap.get(fragment.footnoteId);
        if (!fn || !content) continue;
        items.push({
          displayNumber: String(fragment.displayNumber),
          text: getFootnoteText(fn),
          content,
          fragment,
        });
      }
      if (items.length > 0) result.set(pageNumber, items);
      continue;
    }

    for (const fnId of footnoteIds) {
      const fn = fnLookup.get(fnId);
      if (!fn) continue;
      const content =
        resolveFootnoteContent?.(fnId, pageNumber, page) ?? footnoteContentMap.get(fnId);
      const displayNum = content?.displayNumber ?? 0;
      items.push({
        displayNumber: String(displayNum),
        text: getFootnoteText(fn),
        content,
      });
    }
    if (items.length > 0) result.set(pageNumber, items);
  }

  return result;
}

export function buildFootnoteRenderItems(
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, FootnoteContent>,
  doc: Document | null,
  pages?: Page[]
): Map<number, FootnoteRenderItem[]> {
  return buildFootnoteRenderItemsInternal(pageFootnoteMap, footnoteContentMap, doc, pages);
}

/** Internal page-aware entry point used by the shared layout compute pass. */
export function buildFootnoteRenderItemsForPages(
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, FootnoteContent>,
  doc: Document | null,
  pages: Page[],
  resolveFootnoteContent: ResolveFootnoteContent
): Map<number, FootnoteRenderItem[]> {
  return buildFootnoteRenderItemsInternal(
    pageFootnoteMap,
    footnoteContentMap,
    doc,
    pages,
    resolveFootnoteContent
  );
}
