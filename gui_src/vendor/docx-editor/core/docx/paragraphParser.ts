/**
 * Paragraph Parser - Parse paragraphs (w:p) with complete formatting
 *
 * A paragraph is the fundamental block-level element containing text runs,
 * hyperlinks, bookmarks, and fields.
 *
 * OOXML Reference:
 * - Paragraph: w:p
 * - Paragraph properties: w:pPr
 * - Content: runs, hyperlinks, bookmarks, fields
 *
 * This file owns `parseParagraph` (the orchestrator) and re-exports the
 * other public symbols. Property parsing lives in ./paragraphParser/
 * properties.ts, inline-content parsing in ./content.ts, and read-only
 * predicates/text extraction in ./utilities.ts.
 */

import type {
  Paragraph,
  ParagraphContent,
  Theme,
  RelationshipMap,
  MediaFile,
  TrackedChangeInfo,
} from '../types/document';
import type { StyleMap } from './styleParser';
import { computeListRendering, type NumberingMap } from './numberingParser';
import { findChild, getAttribute, type XmlElement } from './xmlParser';
import { normalizeLongHexId } from '../utils/hexId';
import { parseSectionProperties } from './sectionParser';

import { parseParagraphProperties } from './paragraphParser/properties';
import { getDirectIndentSemantics } from './paragraphParser/directIndentSemantics';
import {
  paragraphStartsWithRenderedPageBreak,
  parseParagraphContents,
  parseParagraphPropertyChanges,
} from './paragraphParser/content';

// Public re-exports (preserve historical import surface).
export { parseParagraphProperties } from './paragraphParser/properties';
export {
  getParagraphText,
  isEmptyParagraph,
  isListItem,
  getListLevel,
  hasStyle,
  getTemplateVariable,
} from './paragraphParser/queries';

/**
 * Parse the OOXML tracked-change attribute triple `(w:id, w:author, w:date)`
 * from any element that extends `CT_TrackChange` (e.g. `<w:ins>`, `<w:del>`,
 * `<w:moveFrom>`). `w:id` is required (`xsd:int`); a missing or non-numeric
 * id returns `null`. `w:date` is optional per schema — passed through as-is.
 */
function parseTrackedChangeAttrs(el: XmlElement): TrackedChangeInfo | null {
  const idAttr = getAttribute(el, 'w', 'id');
  if (idAttr == null) return null;
  const id = parseInt(idAttr, 10);
  if (Number.isNaN(id)) return null;
  const author = getAttribute(el, 'w', 'author') ?? '';
  const date = getAttribute(el, 'w', 'date') ?? undefined;
  const info: TrackedChangeInfo = { id, author };
  if (date) info.date = date;
  return info;
}

/**
 * Parse a paragraph element (w:p)
 *
 * @param node - The w:p XML element
 * @param styles - Style map for resolving style references
 * @param theme - Theme for resolving theme colors/fonts
 * @param numbering - Numbering definitions for list info
 * @param rels - Relationship map for resolving hyperlink URLs
 * @param media - Media files map for image data
 * @param options - `inHeaderFooter` skips `<w:lastRenderedPageBreak/>`
 *   detection since headers and footers reflow per page.
 * @returns Parsed Paragraph object
 */
export function parseParagraph(
  node: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  numbering: NumberingMap | null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
  options?: { inHeaderFooter?: boolean }
): Paragraph {
  const paragraph: Paragraph = {
    type: 'paragraph',
    content: [],
  };

  // Get paragraph ID attributes (Word 2010+ uses these for collaboration).
  // Foreign exporters sometimes emit malformed or out-of-range ids that Word
  // and strict validators reject, so normalize them as they enter the model.
  const paraId = getAttribute(node, 'w14', 'paraId') ?? getAttribute(node, 'w', 'paraId');
  if (paraId) {
    paragraph.paraId = normalizeLongHexId(paraId);
  }

  const textId = getAttribute(node, 'w14', 'textId') ?? getAttribute(node, 'w', 'textId');
  if (textId) {
    paragraph.textId = normalizeLongHexId(textId);
  }

  // `<w:lastRenderedPageBreak/>` only makes sense in body flow; headers and
  // footers reflow per page, so detection is skipped there.
  if (!options?.inHeaderFooter && paragraphStartsWithRenderedPageBreak(node)) {
    paragraph.renderedPageBreakBefore = true;
  }

  // Parse paragraph properties (w:pPr)
  const pPr = findChild(node, 'w', 'pPr');
  if (pPr) {
    paragraph.formatting = parseParagraphProperties(pPr, theme, styles ?? undefined);
    paragraph.propertyChanges = parseParagraphPropertyChanges(
      pPr,
      theme,
      styles,
      paragraph.formatting
    );

    // Paragraph-mark tracked-change markers live inside w:pPr/w:rPr per
    // ECMA-376 §17.13.5 (EG_ParaRPrTrackChanges). They mean "the pilcrow
    // that terminates this paragraph was inserted/deleted as a tracked
    // change," NOT that any run content is tracked.
    const pPrRPr = findChild(pPr, 'w', 'rPr');
    if (pPrRPr) {
      const ins = findChild(pPrRPr, 'w', 'ins');
      if (ins) {
        const info = parseTrackedChangeAttrs(ins);
        if (info) paragraph.pPrIns = info;
      }
      const del = findChild(pPrRPr, 'w', 'del');
      if (del) {
        const info = parseTrackedChangeAttrs(del);
        if (info) paragraph.pPrDel = info;
      }
    }

    // Check for section properties within paragraph (marks end of a section)
    const sectPr = findChild(pPr, 'w', 'sectPr');
    if (sectPr) {
      paragraph.sectionProperties = parseSectionProperties(sectPr, rels);
    }
  }

  // Parse paragraph contents (runs, hyperlinks, bookmarks, fields)
  const rawContent = parseParagraphContents(node, styles, theme, numbering, rels, media);

  // Keep source run boundaries intact. Run positions can anchor comments,
  // tracked changes, and fidelity tooling, so parser-level consolidation would
  // erase information before later round-trip stages have a chance to preserve it.
  paragraph.content = rawContent;
  if (contentStartsWithHardPageBreak(rawContent)) {
    paragraph.sourceLeadingPageBreak = true;
  }

  // Compute list rendering if this is a list item.
  // numPr can come from inline pPr or from the referenced paragraph style.
  let effectiveNumPr = paragraph.formatting?.numPr;
  let numPrFromStyle = false;
  if (!effectiveNumPr && paragraph.formatting?.styleId && styles) {
    const style = styles.get(paragraph.formatting.styleId);
    if (style?.pPr?.numPr) {
      effectiveNumPr = style.pPr.numPr;
      numPrFromStyle = true;
      // Store it on the paragraph formatting so downstream code sees it,
      // and record the provenance so the serializer can drop it again —
      // materializing style numbering as direct <w:numPr> flips Word's
      // level-indent precedence on the saved file.
      if (!paragraph.formatting) paragraph.formatting = {};
      paragraph.formatting.numPr = effectiveNumPr;
      paragraph.formatting.numPrFromStyle = effectiveNumPr;
    }
  }

  if (effectiveNumPr && numbering) {
    const rendering = computeListRendering(effectiveNumPr, numbering);
    if (rendering) {
      paragraph.listRendering = rendering;

      // Apply level's paragraph properties (indentation) as defaults.
      // Per OOXML spec, direct w:ind on the paragraph overrides numbering
      // level indent — only use numbering indent as fallback.
      //
      // When the numbering reference itself comes from the paragraph STYLE
      // (style pPr numPr), Word gives the style chain's own w:ind
      // precedence over the numbering level's — e.g. a "Claim" style with
      // ind left=1134 hanging=1134 referencing a level with 360/360 lays
      // out at 1134. Skip the level indents the style chain covers; the
      // toProseDoc style fallback supplies the style values. Resolution is
      // per group (left vs firstLine/hanging) so a chain that only defines
      // `left` (e.g. ListParagraph) still takes the level's hanging —
      // mirrors listAttrsFromResolvedStyle so the picker and the loader
      // resolve a style identically. Direct paragraph numPr keeps the
      // level-over-style behavior (Word's toolbar-list case).
      const chainInd = numPrFromStyle
        ? styleChainInd(paragraph.formatting?.styleId, styles)
        : { left: false, firstLine: false };
      const level = numbering.getLevel(rendering.numId, rendering.level);
      if (level?.pPr) {
        if (!paragraph.formatting) {
          paragraph.formatting = {};
        }
        const sourceIndent = paragraph.formatting._indentProvenance?.source;
        const directIndent = getDirectIndentSemantics(sourceIndent);
        const numberingIndent: NonNullable<
          NonNullable<
            NonNullable<Paragraph['formatting']>['_indentProvenance']
          >['resolvedNumbering']
        > = {
          sourceIdentity: {
            styleId: paragraph.formatting.styleId,
            numPr: {
              numId: effectiveNumPr.numId,
              ilvl: effectiveNumPr.ilvl,
            },
            numPrFromStyle: paragraph.formatting.numPrFromStyle
              ? {
                  numId: paragraph.formatting.numPrFromStyle.numId,
                  ilvl: paragraph.formatting.numPrFromStyle.ilvl,
                }
              : undefined,
            indentLeft: paragraph.formatting.indentLeft,
            indentRight: paragraph.formatting.indentRight,
            indentFirstLine: paragraph.formatting.indentFirstLine,
            hangingIndent: paragraph.formatting.hangingIndent,
            sourceIndent: sourceIndent
              ? {
                  left: sourceIndent.left,
                  start: sourceIndent.start,
                  right: sourceIndent.right,
                  end: sourceIndent.end,
                  firstLine: sourceIndent.firstLine,
                  hanging: sourceIndent.hanging,
                }
              : undefined,
          },
        };

        if (!directIndent.hasLeft && !chainInd.left && level.pPr.indentLeft !== undefined) {
          numberingIndent.indentLeft = level.pPr.indentLeft;
        }
        if (!directIndent.hasFirstLine && !chainInd.firstLine) {
          if (level.pPr.indentFirstLine !== undefined) {
            numberingIndent.indentFirstLine = level.pPr.indentFirstLine;
          }
          if (level.pPr.hangingIndent !== undefined) {
            numberingIndent.hangingIndent = level.pPr.hangingIndent;
          }
        }
        if (
          numberingIndent.indentLeft !== undefined ||
          numberingIndent.indentRight !== undefined ||
          numberingIndent.indentFirstLine !== undefined
        ) {
          paragraph.formatting._indentProvenance ??= {};
          paragraph.formatting._indentProvenance.resolvedNumbering = numberingIndent;
        }
      }
    }
  }

  return paragraph;
}

function contentStartsWithHardPageBreak(content: readonly ParagraphContent[]): boolean {
  for (const item of content) {
    switch (item.type) {
      case 'run':
        for (const runContent of item.content) {
          if (runContent.type === 'break' && runContent.breakType === 'page') return true;
          // Word commonly emits empty <w:t/> shells; they are invisible, so
          // keep scanning (mirrors isVisibleRunContent in toProseDoc).
          if (runContent.type === 'text' && runContent.text.length === 0) continue;
          if (runContent.type !== 'fieldChar' && runContent.type !== 'instrText') return false;
        }
        break;
      case 'hyperlink':
        return contentStartsWithHardPageBreak(item.children as ParagraphContent[]);
      case 'simpleField':
        return contentStartsWithHardPageBreak(item.content as ParagraphContent[]);
      case 'complexField':
        return contentStartsWithHardPageBreak([
          ...item.fieldCode,
          ...item.fieldResult,
        ] as ParagraphContent[]);
      case 'inlineSdt':
        return contentStartsWithHardPageBreak(item.content as ParagraphContent[]);
      case 'insertion':
      case 'deletion':
      case 'moveFrom':
      case 'moveTo':
        return contentStartsWithHardPageBreak(item.content as ParagraphContent[]);
      case 'bookmarkStart':
      case 'bookmarkEnd':
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'moveFromRangeStart':
      case 'moveFromRangeEnd':
      case 'moveToRangeStart':
      case 'moveToRangeEnd':
        continue;
      default:
        return false;
    }
  }
  return false;
}

/**
 * Which indent groups the basedOn chain defines: `left` (w:ind left) and
 * `firstLine` (w:ind firstLine/hanging). Walks from the given style up the
 * chain; cycles are guarded. Grouping matches listAttrsFromResolvedStyle.
 */
function styleChainInd(
  styleId: string | undefined,
  styles?: StyleMap | null
): { left: boolean; firstLine: boolean } {
  const result = { left: false, firstLine: false };
  if (!styleId || !styles) return result;
  const seen = new Set<string>();
  let current: string | undefined = styleId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = styles.get(current);
    if (!style) break;
    const p = style.pPr;
    if (p) {
      result.left ||= p.indentLeft !== undefined;
      result.firstLine ||= p.indentFirstLine !== undefined || p.hangingIndent !== undefined;
    }
    if (result.left && result.firstLine) break;
    current = style.basedOn;
  }
  return result;
}
