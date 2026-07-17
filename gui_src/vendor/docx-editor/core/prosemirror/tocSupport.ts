import type { Node as PMNode } from 'prosemirror-model';
import { findPageIndexContainingPmPos } from '../pagination-model/findPageIndexContainingPmPos';
import type { PageLayout, TableFragment } from '../pagination-model/types';
import type { TocHeading, TocInstruction } from './toc';

type TocEntrySignature = {
  text: string;
  level: number;
  href: string | null;
  pageNumber: number | null;
};

type BookmarkMarker = { type: 'bookmarkStart' | 'bookmarkEnd'; id: number; name?: string };

export type BookmarkRegistry = {
  claimedNames: Set<string>;
  claimedIds: Set<number>;
  claimedIdCounts: Map<number, number>;
  tocNameUsage: Map<string, number>;
};

export type PageLayoutLookup = {
  tableFragmentsByDocFrom: Map<number, Array<{ pageIndex: number; fragment: TableFragment }>>;
};

function clampTocLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.max(1, Math.min(9, Math.trunc(level)));
}

export function collectDocumentBookmarkRegistry(doc: PMNode): BookmarkRegistry {
  const claimedNames = new Set<string>();
  const claimedIds = new Set<number>();
  const claimedIdCounts = new Map<number, number>();
  const tocNameUsage = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name === 'paragraph') {
      const nodeBookmarks =
        (node.attrs.bookmarks as Array<{ id: number; name: string }> | null) ?? [];
      for (const bookmark of nodeBookmarks) {
        claimBookmarkPair(
          bookmark.id,
          bookmark.name,
          claimedNames,
          claimedIds,
          claimedIdCounts,
          tocNameUsage
        );
      }
      const loneEndIds = (node.attrs.loneBookmarkEndIds as number[] | null) ?? [];
      for (const id of loneEndIds) {
        claimRegistryBookmarkId(id, claimedIds, claimedIdCounts);
      }
      claimBlockMarkers(
        node.attrs.leadingBlockMarkers as BookmarkMarker[] | null,
        claimedNames,
        claimedIds,
        claimedIdCounts,
        tocNameUsage
      );
      claimBlockMarkers(
        node.attrs.trailingBlockMarkers as BookmarkMarker[] | null,
        claimedNames,
        claimedIds,
        claimedIdCounts,
        tocNameUsage
      );
      return true;
    }
    if (node.type.name === 'table' || node.type.name === 'blockSdt') {
      claimBlockMarkers(
        node.attrs.leadingBlockMarkers as BookmarkMarker[] | null,
        claimedNames,
        claimedIds,
        claimedIdCounts,
        tocNameUsage
      );
      claimBlockMarkers(
        node.attrs.trailingBlockMarkers as BookmarkMarker[] | null,
        claimedNames,
        claimedIds,
        claimedIdCounts,
        tocNameUsage
      );
      return true;
    }
    return true;
  });
  return { claimedNames, claimedIds, claimedIdCounts, tocNameUsage };
}

function claimBookmarkPair(
  id: number | undefined,
  name: string | undefined,
  claimedNames: Set<string>,
  claimedIds: Set<number>,
  claimedIdCounts: Map<number, number>,
  tocNameUsage: Map<string, number>
): void {
  if (typeof id === 'number') {
    claimRegistryBookmarkId(id, claimedIds, claimedIdCounts);
  }
  if (typeof name === 'string' && name.length > 0) {
    claimedNames.add(name);
    if (name.startsWith('_Toc')) {
      tocNameUsage.set(name, (tocNameUsage.get(name) ?? 0) + 1);
    }
  }
}

function claimRegistryBookmarkId(
  id: number,
  claimedIds: Set<number>,
  claimedIdCounts: Map<number, number>
): void {
  claimedIds.add(id);
  claimedIdCounts.set(id, (claimedIdCounts.get(id) ?? 0) + 1);
}

function claimBlockMarkers(
  markers: BookmarkMarker[] | null | undefined,
  claimedNames: Set<string>,
  claimedIds: Set<number>,
  claimedIdCounts: Map<number, number>,
  tocNameUsage: Map<string, number>
): void {
  for (const marker of markers ?? []) {
    if (marker.type === 'bookmarkStart') {
      claimBookmarkPair(
        marker.id,
        marker.name,
        claimedNames,
        claimedIds,
        claimedIdCounts,
        tocNameUsage
      );
    } else {
      claimRegistryBookmarkId(marker.id, claimedIds, claimedIdCounts);
    }
  }
}

export function buildPageLayoutLookup(layout: PageLayout | null): PageLayoutLookup | null {
  if (!layout) return null;
  const tableFragmentsByDocFrom = new Map<
    number,
    Array<{ pageIndex: number; fragment: TableFragment }>
  >();
  for (let pageIndex = 0; pageIndex < layout.pages.length; pageIndex++) {
    for (const fragment of layout.pages[pageIndex].fragments) {
      if (fragment.kind !== 'table' || fragment.docFrom == null) continue;
      const existing = tableFragmentsByDocFrom.get(fragment.docFrom) ?? [];
      existing.push({ pageIndex, fragment });
      tableFragmentsByDocFrom.set(fragment.docFrom, existing);
    }
  }
  return { tableFragmentsByDocFrom };
}

export function resolvePageNumber(
  doc: PMNode,
  pmPos: number,
  node: PMNode,
  layout: PageLayout | null,
  pageLookup: PageLayoutLookup | null
): number | null {
  if (!layout) return null;

  const tableContext = findTableContextAt(doc, pmPos);
  if (tableContext && pageLookup) {
    const tablePage = findPageNumberForTableRow(
      layout,
      pageLookup,
      tableContext.tableStart,
      tableContext.rowIndex
    );
    if (tablePage != null) return tablePage;
  }

  const pageIndex = findPageIndexContainingPmPos(layout, pmPos);
  if (pageIndex != null) {
    return layout.pages[pageIndex].number;
  }
  const blockIndex = topLevelBlockIndexAt(doc, pmPos);
  if (blockIndex == null) return null;
  const candidates = layout.pages.filter((page) =>
    page.fragments.some((fragment) => String(fragment.nodeId) === String(blockIndex))
  );
  if (candidates.length === 0) return null;
  if (startsAfterPageBreak(node)) {
    return candidates[candidates.length - 1].number;
  }
  return candidates[0].number;
}

function findTableContextAt(
  doc: PMNode,
  pmPos: number
): { tableStart: number; rowIndex: number } | null {
  const $pos = doc.resolve(pmPos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name !== 'tableRow') continue;
    const table = $pos.node(depth - 1);
    if (table.type.name !== 'table') continue;
    const tableStart = $pos.before(depth - 1);
    const row = $pos.node(depth);
    let rowIndex = 0;
    for (let i = 0; i < table.childCount; i++) {
      if (table.child(i) === row) {
        rowIndex = i;
        break;
      }
    }
    return { tableStart, rowIndex };
  }
  return null;
}

function findPageNumberForTableRow(
  layout: PageLayout,
  pageLookup: PageLayoutLookup,
  tableStart: number,
  rowIndex: number
): number | null {
  const fragments = pageLookup.tableFragmentsByDocFrom.get(tableStart);
  if (!fragments || fragments.length === 0) return null;
  for (const { pageIndex, fragment } of fragments) {
    if (rowIndex >= fragment.fromRow && rowIndex < fragment.toRow) {
      return layout.pages[pageIndex].number;
    }
  }
  return null;
}

function startsAfterPageBreak(node: PMNode): boolean {
  return Boolean(
    node.attrs.pageBreakBefore ||
    node.attrs.sourceLeadingPageBreak ||
    node.attrs.renderedPageBreakBefore
  );
}

function topLevelBlockIndexAt(doc: PMNode, pmPos: number): number | null {
  let index = 0;
  let found: number | null = null;
  doc.forEach((child, offset) => {
    const start = offset;
    const end = offset + child.nodeSize;
    if (pmPos >= start && pmPos <= end) found = index;
    index++;
  });
  return found;
}

export function desiredTocEntrySignatures(
  instruction: TocInstruction,
  headings: TocHeading[]
): TocEntrySignature[] {
  const signatures: TocEntrySignature[] = [];
  for (const heading of headings) {
    const displayLevel = heading.level + 1;
    if (displayLevel < instruction.outlineStart || displayLevel > instruction.outlineEnd) continue;
    signatures.push({
      text: heading.text,
      level: displayLevel,
      href: instruction.hyperlink ? `#${heading.bookmark}` : null,
      pageNumber: heading.pageNumber,
    });
  }
  return signatures;
}

export function extractCurrentTocContent(
  node: PMNode,
  instruction: TocInstruction
): {
  entries: TocEntrySignature[];
  hasUnexpectedVisibleContent: boolean;
  hyperlinkMismatch: boolean;
} {
  const entries: TocEntrySignature[] = [];
  let hasUnexpectedVisibleContent = false;
  let hyperlinkMismatch = false;

  node.forEach((child) => {
    if (child.type.name !== 'paragraph') {
      hasUnexpectedVisibleContent = true;
      return;
    }
    if (isStructuralTocBoundaryParagraph(child)) return;
    if (isRegeneratedEmptyTocParagraph(child)) return;

    const extracted = extractTocEntrySignatureFromParagraph(child, instruction.hyperlink);
    if (extracted.hyperlinkMismatch) {
      hyperlinkMismatch = true;
      return;
    }
    if (extracted.signature) {
      entries.push(extracted.signature);
      return;
    }

    if (paragraphHasVisibleContent(child)) {
      hasUnexpectedVisibleContent = true;
    }
  });

  return { entries, hasUnexpectedVisibleContent, hyperlinkMismatch };
}

function isRegeneratedEmptyTocParagraph(paragraph: PMNode): boolean {
  const styleId = typeof paragraph.attrs.styleId === 'string' ? paragraph.attrs.styleId : '';
  return styleId === 'TOC1' && !paragraphHasVisibleContent(paragraph);
}

function isStructuralTocBoundaryParagraph(paragraph: PMNode): boolean {
  return paragraph.content.size === 0;
}

function paragraphHasVisibleContent(paragraph: PMNode): boolean {
  let visible = false;
  paragraph.descendants((node) => {
    if (node.isText) {
      if ((node.text ?? '').trim().length > 0) visible = true;
      return false;
    }
    if (node.isAtom || node.isLeaf) {
      visible = true;
      return false;
    }
    return !visible;
  });
  return visible;
}

function extractTocEntrySignatureFromParagraph(
  paragraph: PMNode,
  hyperlink: boolean
): { signature: TocEntrySignature | null; hyperlinkMismatch: boolean } {
  const styleId = typeof paragraph.attrs.styleId === 'string' ? paragraph.attrs.styleId : '';
  const levelMatch = styleId.match(/^TOC(\d)$/);
  if (!levelMatch) return { signature: null, hyperlinkMismatch: false };

  let text = '';
  let pageText = '';
  let seenTab = false;
  const hrefs = new Set<string>();

  paragraph.forEach((child) => {
    const linkMark = child.marks.find((mark) => mark.type.name === 'hyperlink');
    if (linkMark && typeof linkMark.attrs.href === 'string') {
      hrefs.add(linkMark.attrs.href);
    }
    if (child.type.name === 'text') {
      if (!seenTab) {
        text += child.text ?? '';
      } else {
        pageText += child.text ?? '';
      }
      return;
    }
    if (child.type.name === 'tab') {
      seenTab = true;
      const tabLink = child.marks.find((mark) => mark.type.name === 'hyperlink');
      if (tabLink && typeof tabLink.attrs.href === 'string') {
        hrefs.add(tabLink.attrs.href);
      }
    }
  });

  text = text.trim();
  if (!text) return { signature: null, hyperlinkMismatch: false };

  const hyperlinkState = validateTocEntryHyperlinks(paragraph, hyperlink);
  if (!hyperlinkState.valid) {
    return { signature: null, hyperlinkMismatch: true };
  }

  const trimmedPageText = pageText.trim();
  const pageNumber =
    trimmedPageText.length > 0 && Number.isFinite(Number(trimmedPageText))
      ? Number(trimmedPageText)
      : trimmedPageText.length > 0
        ? null
        : null;

  return {
    signature: {
      text,
      level: clampTocLevel(Number(levelMatch[1])),
      href: hyperlink ? ([...hrefs][0] ?? null) : null,
      pageNumber,
    },
    hyperlinkMismatch: false,
  };
}

function validateTocEntryHyperlinks(
  paragraph: PMNode,
  hyperlink: boolean
): { valid: boolean; href: string | null } {
  const hrefs = new Set<string>();
  let hasAnyHyperlink = false;
  paragraph.descendants((node) => {
    if (node.type.name === 'text' || node.type.name === 'tab') {
      const linkMark = node.marks.find((mark) => mark.type.name === 'hyperlink');
      if (linkMark && typeof linkMark.attrs.href === 'string') {
        hasAnyHyperlink = true;
        hrefs.add(linkMark.attrs.href);
      }
    }
    return true;
  });

  if (!hyperlink) {
    return { valid: !hasAnyHyperlink, href: null };
  }
  if (!hasAnyHyperlink || hrefs.size !== 1) {
    return { valid: false, href: null };
  }
  const expectedHref = [...hrefs][0];
  let valid = true;
  paragraph.descendants((node) => {
    if (node.type.name !== 'text' && node.type.name !== 'tab') return true;
    const linkMark = node.marks.find((mark) => mark.type.name === 'hyperlink');
    if (!linkMark || linkMark.attrs.href !== expectedHref) {
      valid = false;
      return false;
    }
    return true;
  });
  return { valid, href: expectedHref };
}

export function tocEntrySignaturesMatch(
  current: TocEntrySignature[],
  desired: TocEntrySignature[],
  layout: PageLayout | null
): boolean {
  if (current.length !== desired.length) return false;
  for (let i = 0; i < current.length; i++) {
    const left = current[i];
    const right = desired[i];
    if (left.text !== right.text) return false;
    if (left.level !== right.level) return false;
    if (left.href !== right.href) return false;
    if (layout != null && left.pageNumber !== right.pageNumber) return false;
  }
  return true;
}
