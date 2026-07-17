import type { EditorState, Transaction } from 'prosemirror-state';
import type { TextFormatting } from '../../types/document';
import { mergeTextFormatting } from '../../utils/textFormattingMerge';
import { getMarkSetKey, RUN_BOUNDARY_MARK_EXCLUSIONS } from '../conversion/markKeys';
import { textFormattingToMarks } from '../conversion/toProseDoc/marks';

export interface RunPropertyChangeSite {
  paragraphPos: number;
  boundaryIndex: number;
  from: number;
  to: number;
  prior: TextFormatting | undefined;
}

interface RunBoundary {
  text: string;
  marksKey?: string;
  formatting?: TextFormatting;
  propertyChanges?: Array<{
    info: { id: number };
    previousFormatting?: TextFormatting;
  }>;
}

const FORMATTING_MARK_NAMES = [
  'bold',
  'italic',
  'underline',
  'strike',
  'textColor',
  'highlight',
  'fontSize',
  'fontFamily',
  'superscript',
  'subscript',
  'allCaps',
  'smallCaps',
  'characterSpacing',
  'emboss',
  'imprint',
  'textShadow',
  'emphasisMark',
  'textOutline',
  'hidden',
  'rtl',
  'textEffect',
  'runStyle',
] as const;

/** Find source-run boundaries carrying a matching `w:rPrChange`. */
export function findRunPropertyChangeSites(
  state: EditorState,
  revisionId: number
): RunPropertyChangeSite[] {
  const sites: RunPropertyChangeSite[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return;
    const boundaries = node.attrs._originalRunBoundaries as RunBoundary[] | null;
    if (!Array.isArray(boundaries)) return;
    let offset = 0;
    boundaries.forEach((boundary, boundaryIndex) => {
      const length = typeof boundary.text === 'string' ? boundary.text.length : 0;
      for (const change of boundary.propertyChanges ?? []) {
        if (change?.info?.id !== revisionId) continue;
        sites.push({
          paragraphPos: pos,
          boundaryIndex,
          from: pos + 1 + offset,
          to: pos + 1 + offset + length,
          prior: change.previousFormatting,
        });
      }
      offset += length;
    });
  });
  return sites;
}

/**
 * Restore effective formatting before position-shifting resolution steps.
 * Paragraph defaults are merged with the prior direct rPr, while semantic
 * marks such as comments, hyperlinks, and tracked insert/delete survive.
 */
export function restoreRejectedRunPropertyFormatting(
  tr: Transaction,
  state: EditorState,
  sites: RunPropertyChangeSite[]
): void {
  const seenRanges = new Set<string>();
  for (const site of sites) {
    const key = `${site.from}:${site.to}`;
    if (seenRanges.has(key) || site.from >= site.to) continue;
    seenRanges.add(key);

    const paragraph = state.doc.nodeAt(site.paragraphPos);
    if (!paragraph) continue;
    const baseline = paragraph.attrs.defaultTextFormatting as TextFormatting | undefined;
    const formattingMarks = textFormattingToMarks(mergeTextFormatting(baseline, site.prior));

    for (const markName of FORMATTING_MARK_NAMES) {
      const markType = state.schema.marks[markName];
      if (markType) tr.removeMark(site.from, site.to, markType);
    }
    for (const mark of formattingMarks) {
      const markType = state.schema.marks[mark.type.name];
      if (markType) tr.addMark(site.from, site.to, markType.create(mark.attrs));
    }
  }
}

/**
 * Clear matching source-boundary metadata. Reject also records the restored
 * direct formatting and mark key so lossless run reconstruction remains valid.
 */
export function clearResolvedRunPropertyChanges(
  tr: Transaction,
  revisionId: number,
  mode: 'accept' | 'reject',
  sites: RunPropertyChangeSite[]
): void {
  const sitesByParagraph = new Map<number, RunPropertyChangeSite[]>();
  for (const site of sites) {
    const paragraphSites = sitesByParagraph.get(site.paragraphPos) ?? [];
    paragraphSites.push(site);
    sitesByParagraph.set(site.paragraphPos, paragraphSites);
  }

  for (const [paragraphPos, paragraphSites] of [...sitesByParagraph].sort((a, b) => b[0] - a[0])) {
    const mappedParagraphPos = tr.mapping.map(paragraphPos);
    const liveParagraph = tr.doc.nodeAt(mappedParagraphPos);
    if (!liveParagraph || liveParagraph.type.name !== 'paragraph') continue;
    const boundaries = liveParagraph.attrs._originalRunBoundaries as RunBoundary[] | null;
    if (!Array.isArray(boundaries)) continue;

    const nextBoundaries = boundaries.map((boundary) => {
      const remainingChanges = boundary.propertyChanges?.filter(
        (change) => change.info.id !== revisionId
      );
      return {
        ...boundary,
        ...(boundary.propertyChanges
          ? { propertyChanges: remainingChanges?.length ? remainingChanges : undefined }
          : {}),
      };
    });

    for (const site of paragraphSites) {
      const boundary = nextBoundaries[site.boundaryIndex];
      if (!boundary || mode !== 'reject') continue;
      boundary.formatting = site.prior;
      const mappedFrom = tr.mapping.map(site.from);
      const mappedTo = tr.mapping.map(site.to);
      let marksKey: string | undefined;
      if (mappedFrom < mappedTo) {
        tr.doc.nodesBetween(mappedFrom, mappedTo, (node) => {
          if (marksKey == null && node.isText) {
            marksKey = getMarkSetKey(node.marks, RUN_BOUNDARY_MARK_EXCLUSIONS);
          }
        });
      }
      if (marksKey != null) boundary.marksKey = marksKey;
    }

    tr.setNodeMarkup(mappedParagraphPos, undefined, {
      ...liveParagraph.attrs,
      _originalRunBoundaries: nextBoundaries,
    });
  }
}
