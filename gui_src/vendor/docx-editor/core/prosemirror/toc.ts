import { Fragment, type Node as PMNode, type Schema } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { PageLayout } from '../pagination-model/types';
import type {
  Paragraph,
  ParagraphFormatting,
  Run,
  SdtProperties,
  TabMark,
} from '../types/document';
import { serializeParagraph } from '../docx/serializer/paragraphSerializer';
import { synthesizeSdtPr } from '../docx/serializer/paragraphSerializer/content';
import { escapeXml } from '../docx/serializer/xmlUtils';
import { preserveTextFingerprint } from './conversion/preserveText';
import {
  buildPageLayoutLookup,
  collectDocumentBookmarkRegistry,
  desiredTocEntrySignatures,
  extractCurrentTocContent,
  resolvePageNumber,
  tocEntrySignaturesMatch,
  type BookmarkRegistry,
  type PageLayoutLookup,
} from './tocSupport';

export interface TocInstruction {
  type: 'TOC';
  hyperlink: boolean;
  outlineStart: number;
  outlineEnd: number;
  raw: string;
  unknownSwitches: string[];
}

export interface TocHeading {
  text: string;
  level: number;
  pmPos: number;
  bookmark: string;
  pageNumber: number | null;
}

export interface TocBlockInfo {
  pos: number;
  node: PMNode;
  instruction: TocInstruction;
  needsUpdate: boolean;
}

export interface UpdateTableOfContentsOptions {
  /** Update the TOC containing this position. Omit to update every detected TOC. */
  position?: number | null;
  /** Current layout for resolving heading page numbers. */
  layout?: PageLayout | null;
  /** Regenerate even when advisory stale detection reports the TOC is current. */
  force?: boolean;
}

type CollectedTocHeading = TocHeading & {
  bookmarkId: number;
};

const DEFAULT_INSTRUCTION = 'TOC \\h \\o "1-5"';
const INSERTED_TOC_RAW_XML = [
  '<w:sdt>',
  '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
  '<w:sdtContent>',
  '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
  '<w:r><w:instrText>TOC \\h \\o "1-5"</w:instrText></w:r>',
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
  '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  '</w:sdtContent>',
  '</w:sdt>',
].join('');
const TOC_TAB: TabMark = { position: 9350, alignment: 'right', leader: 'dot' };
const TOC_LEVEL_INDENT_TWIPS = 240;
const TOC_LINE_SPACING_TWIPS = 276;

export function parseTocInstruction(rawInstruction: string): TocInstruction | null {
  const raw = rawInstruction.trim();
  const tokens = tokenizeFieldInstruction(raw);
  if (tokens.length === 0 || tokens[0].toUpperCase() !== 'TOC') return null;

  let hyperlink = false;
  let outlineStart = 1;
  let outlineEnd = 9;
  const unknownSwitches: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('\\')) continue;
    const normalized = token.toLowerCase();
    if (normalized === '\\h') {
      hyperlink = true;
    } else if (normalized === '\\o') {
      const range = tokens[i + 1];
      const match = range?.match(/^(\d+)-(\d+)$/);
      if (match) {
        const a = clampTocLevel(Number(match[1]));
        const b = clampTocLevel(Number(match[2]));
        outlineStart = Math.min(a, b);
        outlineEnd = Math.max(a, b);
        i++;
      } else {
        unknownSwitches.push(token);
      }
    } else {
      unknownSwitches.push(token);
    }
  }

  return { type: 'TOC', hyperlink, outlineStart, outlineEnd, raw, unknownSwitches };
}

export function findTableOfContentsBlocks(doc: PMNode): TocBlockInfo[] {
  const blocks: TocBlockInfo[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockSdt') return true;
    const instruction = getTocInstruction(node);
    if (!instruction) return true;
    blocks.push({ pos, node, instruction, needsUpdate: tocNeedsUpdate(node) });
    return false;
  });
  return blocks;
}

export function hasTableOfContentsNeedingUpdate(doc: PMNode): boolean {
  return findTableOfContentsBlocks(doc).some((block) => block.needsUpdate);
}

/**
 * Return TOC blocks whose normalized generated result differs from the live document.
 * @public
 */
export function findStaleTableOfContentsBlocks(
  doc: PMNode,
  layout?: PageLayout | null
): TocBlockInfo[] {
  const resolvedLayout = layout ?? null;
  const blocks = findTableOfContentsBlocks(doc);
  if (blocks.length === 0) return [];

  const pageLookup = buildPageLayoutLookup(resolvedLayout);
  const bookmarkRegistry = collectDocumentBookmarkRegistry(doc);
  const headings = collectTocHeadings(doc, blocks, resolvedLayout, bookmarkRegistry, pageLookup);
  const stale: TocBlockInfo[] = [];

  for (const block of blocks) {
    if (tocFieldNeedsImmediateUpdate(block.node)) {
      stale.push(block);
      continue;
    }

    const scopedHeadings = headings.filter((heading) => {
      const displayLevel = heading.level + 1;
      return (
        displayLevel >= block.instruction.outlineStart &&
        displayLevel <= block.instruction.outlineEnd
      );
    });

    const desired = desiredTocEntrySignatures(block.instruction, scopedHeadings);
    const current = extractCurrentTocContent(block.node, block.instruction);
    if (
      current.hasUnexpectedVisibleContent ||
      current.hyperlinkMismatch ||
      !tocEntrySignaturesMatch(current.entries, desired, resolvedLayout)
    ) {
      stale.push(block);
    }
  }

  return stale;
}

export function isPositionInsideTableOfContents(doc: PMNode, position: number): boolean {
  return findTableOfContentsBlocks(doc).some(
    ({ pos, node }) => position >= pos && position <= pos + node.nodeSize
  );
}

export function insertTableOfContents(
  state: EditorState,
  dispatch?: (tr: Transaction) => void
): boolean {
  if (!dispatch) return true;
  const { schema } = state;
  const toc = schema.node(
    'blockSdt',
    {
      sdtType: 'richText',
      alias: 'Table of Contents',
      rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      rawPreserveXml: INSERTED_TOC_RAW_XML,
      rawPreserveText: '',
    },
    [schema.node('paragraph', {}, [])]
  );
  dispatch(state.tr.insert(state.selection.from, toc).scrollIntoView());
  return true;
}

export function updateTableOfContents(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  options: UpdateTableOfContentsOptions = {}
): boolean {
  const tocBlocks = findTableOfContentsBlocks(state.doc).filter((block) => {
    if (options.position == null) return true;
    return options.position >= block.pos && options.position <= block.pos + block.node.nodeSize;
  });
  if (tocBlocks.length === 0) return false;

  const blocksToUpdate = options.force
    ? tocBlocks
    : findStaleTableOfContentsBlocks(state.doc, options.layout ?? null).filter((block) =>
        tocBlocks.some((candidate) => candidate.pos === block.pos)
      );
  if (blocksToUpdate.length === 0) return false;
  if (!dispatch) return true;

  const tr = state.tr;
  const pageLookup = buildPageLayoutLookup(options.layout ?? null);
  const bookmarkRegistry = collectDocumentBookmarkRegistry(state.doc);
  const headings = collectTocHeadings(
    state.doc,
    blocksToUpdate,
    options.layout ?? null,
    bookmarkRegistry,
    pageLookup
  );
  const updatePositions = new Set(blocksToUpdate.map((block) => block.pos));
  const bookmarkHeadingPositions = new Set<number>();
  for (const block of blocksToUpdate) {
    if (!block.instruction.hyperlink) continue;
    for (const heading of headings) {
      const displayLevel = heading.level + 1;
      if (
        displayLevel >= block.instruction.outlineStart &&
        displayLevel <= block.instruction.outlineEnd
      ) {
        bookmarkHeadingPositions.add(heading.pmPos);
      }
    }
  }

  for (const heading of headings) {
    if (!bookmarkHeadingPositions.has(heading.pmPos)) continue;
    const mappedPos = tr.mapping.map(heading.pmPos);
    const paragraph = tr.doc.nodeAt(mappedPos);
    if (!paragraph || paragraph.type.name !== 'paragraph') continue;
    const existing = (
      (paragraph.attrs.bookmarks as Array<{ id: number; name: string }> | null) ?? []
    ).filter((bookmark) => !bookmark.name.startsWith('_Toc'));
    const bookmarks = [
      ...existing,
      {
        id: heading.bookmarkId,
        name: heading.bookmark,
      },
    ];
    if (!bookmarksEqual(paragraph.attrs.bookmarks, bookmarks)) {
      tr.setNodeMarkup(mappedPos, undefined, {
        ...paragraph.attrs,
        bookmarks,
      });
    }
  }

  for (const block of [...tocBlocks].sort((a, b) => b.pos - a.pos)) {
    if (!updatePositions.has(block.pos)) continue;
    const mappedPos = tr.mapping.map(block.pos);
    const current = tr.doc.nodeAt(mappedPos);
    if (!current || current.type.name !== 'blockSdt') continue;
    const scopedHeadings = headings.filter((heading) => {
      const level = heading.level + 1;
      return level >= block.instruction.outlineStart && level <= block.instruction.outlineEnd;
    });
    const generated = generateTocResult(current.type.schema, block.instruction, scopedHeadings);
    const resultNodes = generated.pmNodes;

    const rawPreserveXml = buildTocRawXml(current, block.instruction, generated.documentParagraphs);
    const rawPreserveText =
      generated.pmNodes.length === 0
        ? ''
        : generated.pmNodes.map((node) => preserveTextFingerprint(node)).join('');
    tr.setNodeMarkup(mappedPos, undefined, {
      ...current.attrs,
      rawPreserveXml,
      rawPreserveText,
    });
    tr.replaceWith(mappedPos + 1, mappedPos + current.nodeSize - 1, Fragment.from(resultNodes));
  }

  if (!tr.docChanged) return options.force ? true : false;
  dispatch(tr.scrollIntoView());
  return true;
}

function tokenizeFieldInstruction(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (/\s/.test(ch) && !inQuotes) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function clampTocLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.max(1, Math.min(9, Math.trunc(level)));
}

function getTocInstruction(node: PMNode): TocInstruction | null {
  const rawXml = typeof node.attrs.rawPreserveXml === 'string' ? node.attrs.rawPreserveXml : '';
  const rawInstruction =
    extractTocInstructionFromXml(rawXml) ?? extractTocInstructionFromNode(node);
  if (rawInstruction) return parseTocInstruction(rawInstruction);
  const alias = String(node.attrs.alias ?? node.attrs.tag ?? '').toLowerCase();
  return alias.includes('table of contents') || alias === 'toc'
    ? parseTocInstruction(DEFAULT_INSTRUCTION)
    : null;
}

function extractTocInstructionFromXml(xml: string): string | null {
  if (!xml) return null;
  const ownedXml = extractOwnedSdtContentXml(xml);
  const begin = ownedXml.search(/<w:fldChar\b[^>]*w:fldCharType=(["'])begin\1/);
  if (begin < 0) return null;
  const afterBegin = ownedXml.slice(begin);
  const separate = afterBegin.search(/<w:fldChar\b[^>]*w:fldCharType=(["'])separate\1/);
  const end = afterBegin.search(/<w:fldChar\b[^>]*w:fldCharType=(["'])end\1/);
  const instructionXml =
    separate >= 0
      ? afterBegin.slice(0, separate)
      : end >= 0
        ? afterBegin.slice(0, end)
        : afterBegin;
  const parts = [...instructionXml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)]
    .map((match) => decodeBasicXml(match[1]))
    .join('');
  return /\bTOC\b/i.test(parts) ? parts.trim() : null;
}

function extractOwnedSdtContentXml(xml: string): string {
  const contentMatch = xml.match(/<w:sdtContent\b[^>]*>([\s\S]*)<\/w:sdtContent>/);
  if (!contentMatch) return xml;
  return contentMatch[1].replace(/<w:sdt\b[^>]*>[\s\S]*?<\/w:sdt>/g, '');
}

function extractTocInstructionFromNode(node: PMNode): string | null {
  let instruction: string | null = null;
  node.forEach((child) => {
    if (instruction) return;
    if (child.type.name === 'blockSdt') return;
    if (child.type.name === 'field' && String(child.attrs.fieldType).toUpperCase() === 'TOC') {
      instruction = String(child.attrs.instruction ?? DEFAULT_INSTRUCTION);
      return;
    }
    if (child.type.name === 'paragraph') {
      child.descendants((grandchild) => {
        if (
          grandchild.type.name === 'field' &&
          String(grandchild.attrs.fieldType).toUpperCase() === 'TOC'
        ) {
          instruction = String(grandchild.attrs.instruction ?? DEFAULT_INSTRUCTION);
          return false;
        }
        return true;
      });
    }
  });
  return instruction;
}

function tocNeedsUpdate(node: PMNode): boolean {
  const rawXml = typeof node.attrs.rawPreserveXml === 'string' ? node.attrs.rawPreserveXml : '';
  if (/w:dirty=(["'])(?:true|1)\1/.test(rawXml)) return true;
  let dirtyField = false;
  node.descendants((child) => {
    if (child.type.name === 'field' && child.attrs.dirty) {
      dirtyField = true;
      return false;
    }
    return true;
  });
  if (dirtyField) return true;
  if (hasRegeneratedEmptyTocResult(node)) return false;
  if (rawXml && hasEmptyTocResultXml(rawXml)) return true;
  return node.textContent.trim().length === 0;
}

function hasRegeneratedEmptyTocResult(node: PMNode): boolean {
  if (node.childCount !== 1) return false;
  const result = node.child(0);
  return (
    result.type.name === 'paragraph' && result.attrs.styleId === 'TOC1' && result.content.size === 0
  );
}

function hasEmptyTocResultXml(xml: string): boolean {
  const separate = xml.search(/<w:fldChar\b[^>]*w:fldCharType=(["'])separate\1/);
  const end = xml.search(/<w:fldChar\b[^>]*w:fldCharType=(["'])end\1/);
  if (separate < 0 || end < 0 || end <= separate) return false;
  const resultXml = xml.slice(separate, end);
  const resultText = [...resultXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeBasicXml(match[1]))
    .join('');
  return resultText.trim().length === 0;
}

function tocFieldNeedsImmediateUpdate(node: PMNode): boolean {
  const rawXml = typeof node.attrs.rawPreserveXml === 'string' ? node.attrs.rawPreserveXml : '';
  if (/w:dirty=(["'])(?:true|1)\1/.test(rawXml)) return true;
  let dirtyField = false;
  node.descendants((child) => {
    if (child.type.name === 'field' && child.attrs.dirty) {
      dirtyField = true;
      return false;
    }
    return true;
  });
  if (dirtyField) return true;
  if (!rawXml && node.textContent.trim().length === 0) return true;
  return false;
}

function collectTocHeadings(
  doc: PMNode,
  tocBlocks: TocBlockInfo[],
  layout: PageLayout | null,
  bookmarkRegistry: BookmarkRegistry,
  pageLookup: PageLayoutLookup | null
): CollectedTocHeading[] {
  const headings: CollectedTocHeading[] = [];
  const claimedBookmarks = new Set<string>();
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    if (tocBlocks.some((toc) => pos > toc.pos && pos < toc.pos + toc.node.nodeSize)) return false;
    const level = getHeadingLevel(node);
    if (level == null) return false;
    const text = node.textContent.trim();
    if (!text) return false;
    const bookmark = allocateHeadingBookmark(node, text, pos, claimedBookmarks, bookmarkRegistry);
    headings.push({
      text,
      level,
      pmPos: pos,
      bookmark: bookmark.name,
      bookmarkId: bookmark.id,
      pageNumber: resolvePageNumber(doc, pos, node, layout, pageLookup),
    });
    return false;
  });
  return headings;
}

function getHeadingLevel(node: PMNode): number | null {
  const outline = node.attrs.outlineLevel;
  if (typeof outline === 'number' && outline >= 0 && outline <= 8) return outline;
  const styleId = typeof node.attrs.styleId === 'string' ? node.attrs.styleId : '';
  const match = styleId.match(/^[Hh]eading(\d)$/);
  if (!match) return null;
  return clampTocLevel(Number(match[1])) - 1;
}

function generateTocResult(schema: Schema, instruction: TocInstruction, headings: TocHeading[]) {
  const pmNodes: PMNode[] = [];
  const documentParagraphs: Paragraph[] = [];
  for (const heading of headings) {
    const displayLevel = heading.level + 1;
    if (displayLevel < instruction.outlineStart || displayLevel > instruction.outlineEnd) continue;
    const styleId = `TOC${displayLevel}`;
    const pageText = heading.pageNumber == null ? '' : String(heading.pageNumber);
    const formatting = createTocParagraphFormatting(styleId, displayLevel);
    const marks = instruction.hyperlink
      ? [schema.marks.hyperlink.create({ href: `#${heading.bookmark}` })]
      : [];
    pmNodes.push(
      schema.node('paragraph', formatting, [
        schema.text(heading.text, marks),
        schema.node(
          'tab',
          { positional: { alignment: 'right', relativeTo: 'margin', leader: 'dot' } },
          undefined,
          marks
        ),
        ...(pageText ? [schema.text(pageText, marks)] : []),
      ])
    );
    documentParagraphs.push(
      createTocParagraph(formatting, heading, pageText, instruction.hyperlink)
    );
  }
  if (pmNodes.length === 0) {
    const formatting = createTocParagraphFormatting('TOC1', 1);
    pmNodes.push(schema.node('paragraph', formatting, []));
    documentParagraphs.push({ type: 'paragraph', formatting, content: [] });
  }
  return { pmNodes, documentParagraphs };
}

function createTocParagraph(
  formatting: ParagraphFormatting,
  heading: TocHeading,
  pageText: string,
  hyperlink: boolean
): Paragraph {
  const runs: Run[] = [
    { type: 'run', content: [{ type: 'text', text: heading.text }] },
    {
      type: 'run',
      content: [
        { type: 'tab', positional: { alignment: 'right', relativeTo: 'margin', leader: 'dot' } },
      ],
    },
    { type: 'run', content: pageText ? [{ type: 'text', text: pageText }] : [] },
  ];
  return {
    type: 'paragraph',
    formatting,
    content: hyperlink ? [{ type: 'hyperlink', anchor: heading.bookmark, children: runs }] : runs,
  };
}

function createTocParagraphFormatting(styleId: string, displayLevel: number): ParagraphFormatting {
  const indentLeft = Math.max(0, displayLevel - 1) * TOC_LEVEL_INDENT_TWIPS;
  return {
    styleId,
    tabs: [TOC_TAB],
    lineSpacing: TOC_LINE_SPACING_TWIPS,
    lineSpacingRule: 'auto',
    ...(indentLeft > 0 ? { indentLeft } : {}),
  };
}

function buildTocRawXml(
  node: PMNode,
  instruction: TocInstruction,
  paragraphs: Paragraph[]
): string {
  const attrs = node.attrs as Record<string, unknown>;
  const sdtPrXml =
    typeof attrs.rawPropertiesXml === 'string'
      ? attrs.rawPropertiesXml
      : synthesizeSdtPr({
          sdtType: String(attrs.sdtType ?? 'richText') as SdtProperties['sdtType'],
          id: typeof attrs.id === 'number' ? attrs.id : undefined,
          alias: typeof attrs.alias === 'string' ? attrs.alias : undefined,
          tag: typeof attrs.tag === 'string' ? attrs.tag : undefined,
          lock: attrs.lock as SdtProperties['lock'],
        });
  const sdtEndPrXml =
    typeof attrs.rawEndPropertiesXml === 'string' ? attrs.rawEndPropertiesXml : '';
  const resultXml = paragraphs.map((paragraph) => serializeParagraph(paragraph)).join('');
  const instr = instruction.raw || DEFAULT_INSTRUCTION;
  const fieldStart =
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve">${escapeXml(instr)}</w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>`;
  const fieldEnd = '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  return `<w:sdt>${sdtPrXml}${sdtEndPrXml}<w:sdtContent>${fieldStart}${resultXml}${fieldEnd}</w:sdtContent></w:sdt>`;
}

function bookmarkNameFor(text: string, pos: number): string {
  return `_Toc${Math.abs(hashString(`${pos}:${text}`))}`;
}

function allocateHeadingBookmark(
  node: PMNode,
  text: string,
  pos: number,
  claimed: Set<string>,
  registry: BookmarkRegistry
): { name: string; id: number } {
  const bookmarks = (node.attrs.bookmarks as Array<{ id: number; name: string }> | null) ?? [];
  releaseHeadingTocBookmarkIds(bookmarks, registry);
  const existing = bookmarks.find(
    (bookmark) =>
      typeof bookmark.name === 'string' &&
      bookmark.name.startsWith('_Toc') &&
      !claimed.has(bookmark.name) &&
      (registry.tocNameUsage.get(bookmark.name) ?? 0) <= 1
  );
  if (existing) {
    claimed.add(existing.name);
    registry.claimedNames.add(existing.name);
    return {
      name: existing.name,
      id: allocateBookmarkId(existing.name, registry.claimedIds, existing.id),
    };
  }

  const base = bookmarkNameFor(text, pos);
  let candidate = base;
  let suffix = 2;
  while (claimed.has(candidate) || registry.claimedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix++;
  }
  claimed.add(candidate);
  registry.claimedNames.add(candidate);
  return {
    name: candidate,
    id: allocateBookmarkId(candidate, registry.claimedIds),
  };
}

function releaseHeadingTocBookmarkIds(
  bookmarks: Array<{ id: number; name: string }>,
  registry: BookmarkRegistry
): void {
  for (const bookmark of bookmarks) {
    if (!bookmark.name.startsWith('_Toc') || typeof bookmark.id !== 'number') continue;
    const remainingOwners = (registry.claimedIdCounts.get(bookmark.id) ?? 0) - 1;
    if (remainingOwners <= 0) {
      registry.claimedIdCounts.delete(bookmark.id);
      registry.claimedIds.delete(bookmark.id);
    } else {
      registry.claimedIdCounts.set(bookmark.id, remainingOwners);
    }
  }
}

function allocateBookmarkId(
  bookmark: string,
  claimedIds: Set<number>,
  preferredId?: number
): number {
  let id =
    typeof preferredId === 'number' ? preferredId : Math.abs(hashString(bookmark)) % 2147483647;
  if (id === 0) id = 1;
  while (claimedIds.has(id)) {
    id = (id + 1) % 2147483647;
    if (id === 0) id = 1;
  }
  claimedIds.add(id);
  return id;
}

function bookmarksEqual(current: unknown, desired: Array<{ id: number; name: string }>): boolean {
  if (!Array.isArray(current) || current.length !== desired.length) return false;
  return desired.every((bookmark, index) => {
    const existing = current[index] as { id?: unknown; name?: unknown };
    return existing.id === bookmark.id && existing.name === bookmark.name;
  });
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return hash;
}

function decodeBasicXml(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
