/**
 * Paragraph measurement — runs in, line boxes out.
 *
 * A pure function of `(block, availableWidth, floats)`. It knows nothing about
 * pages: it produces the paragraph's lines, and pagination later decides where
 * to cut between them. Keeping the two apart is what makes a paragraph
 * splittable across a page boundary without re-measuring it, and what lets both
 * halves be tested in isolation.
 *
 * The pass is two stages:
 *
 *   1. **Tokenise.** Flatten the runs into break-opportunity units — words,
 *      spaces, tabs, images, explicit breaks. A word is a *cross-run* unit: if
 *      one run ends `"beta."` and the next begins `"1"` with no space between,
 *      that is one word and it wraps as one. Tokenising per run instead would
 *      let the line break inside it, which is how a footnote's superscript
 *      reference ends up stranded alone at the start of a line.
 *   2. **Fill.** Walk the tokens into lines, asking the float model for each
 *      line's available width as we go — so a line beside an image is narrower
 *      than one below it, and a line with no room at all is pushed past the
 *      float rather than being crushed to one glyph.
 *
 * @packageDocumentation
 * @public
 */

import type {
  ImageRun,
  MeasuredLine,
  ParagraphBlock,
  ParagraphMetrics,
  Run,
  TabRun,
  LineSegment,
} from '../../pagination-model/types';
import {
  fontMetricsFor,
  measureTextWidth,
  prefixAdvances,
  resolveFontStyle,
  graphemeBoundaries,
  nextGraphemeBoundary,
  WORD_SINGLE_LINE_RATIO,
  type FontStyle,
} from './textMetrics';
import { getImagePaintGeometry } from '../../utils/imagePaintGeometry';
import {
  findClearLineY,
  getFloatingMargins,
  type FloatingImageZone,
  type FloatingLineMargins,
} from './floatingZones';
import { MIN_WRAP_SEGMENT_WIDTH } from './wrapThresholds';
import { getListMarkerInlineWidth } from './listMarkerWidth';
import { isFloatingImageRun } from '../../painter-model/floatingImageFlow';
import {
  calculatePositionalTabWidth,
  calculateTabWidth,
  type TabRuler,
} from '../../prosemirror/utils/tabMetrics';
import { pointsToPixels } from '../../utils/units';

export type { FloatingImageZone } from './floatingZones';

/**
 * Canvas advance widths and browser layout disagree in the last fraction of a
 * pixel. Without a tolerance, a line whose content metrics 0.2px over the
 * available width wraps a word the browser would have fitted — visible as a
 * lone word dropped to its own line. Wrap only on a real overflow.
 */
const WRAP_TOLERANCE_PX = 0.5;

/**
 * Narrower than this and a line has no useful room for text. The same threshold
 * the float model uses, so "there is no room here" means the same thing to the
 * line filler and to the code that decides where a float's exclusion ends.
 */
const MIN_LINE_TEXT_WIDTH = MIN_WRAP_SEGMENT_WIDTH;

/**
 * Float context for one paragraph.
 *
 * @public
 */
export interface ParagraphLayoutOptions {
  /** Exclusion zones from floating images, tables, and text boxes. */
  floatingZones?: FloatingImageZone[];
  /** Where this paragraph starts in the coordinate space the zones are in. */
  paragraphYOffset?: number;
}

/**
 * Clamp a float's exclusion so it can never eat the whole line.
 *
 * A float flush with the margin — or one wider than the column — computes an
 * exclusion margin at or past the content edge, which would leave the text
 * beside it a width of zero and wrap it one glyph per line. Give the text a
 * usable minimum and let the float overlap it instead; an overlapping float is
 * a cosmetic flaw, a one-glyph column is unreadable.
 *
 * @public
 */
export function constrainWrapMargins(
  leftMargin: number,
  rightMargin: number,
  contentWidth: number
): { leftMargin: number; rightMargin: number } {
  const budget = Math.max(0, contentWidth - MIN_LINE_TEXT_WIDTH);
  if (leftMargin + rightMargin <= budget) {
    return { leftMargin, rightMargin };
  }
  // Give up the larger margin first — it's the one doing the crushing.
  if (leftMargin >= rightMargin) {
    const right = Math.min(rightMargin, budget);
    return { leftMargin: Math.max(0, budget - right), rightMargin: right };
  }
  const left = Math.min(leftMargin, budget);
  return { leftMargin: left, rightMargin: Math.max(0, budget - left) };
}

/**
 * Cumulative per-character advances for a text run, px.
 *
 * @public
 */
export function getRunCharWidths(run: Run, defaults: Partial<FontStyle> = {}): number[] {
  if (run.kind !== 'text') return [];
  return prefixAdvances(run.text, styleFor(run, defaults));
}

/**
 * Measure several paragraphs at one width.
 *
 * @public
 */
export function paragraphLayouts(
  nodes: ParagraphBlock[],
  availableWidth: number,
  config?: ParagraphLayoutOptions
): ParagraphMetrics[] {
  return nodes.map((block) => paragraphLayout(block, availableWidth, config));
}

/**
 * Break a paragraph into lines that fit `availableWidth`, and report their
 * boxes plus the paragraph's total vertical footprint.
 *
 * `totalHeight` includes the paragraph's own `spacing.before`/`after` — it is
 * the full footprint, which is what a table cell and the float pre-pass need.
 * Pagination deliberately ignores it and re-derives height from `lines`,
 * applying the collapsed inter-paragraph gap itself, so the two never
 * double-count the spacing.
 *
 * @public
 */
export function paragraphLayout(
  block: ParagraphBlock,
  availableWidth: number,
  config: ParagraphLayoutOptions = {}
): ParagraphMetrics {
  const attrs = block.attrs;
  const defaults: Partial<FontStyle> = {
    fontFamily: attrs?.defaultFontFamily,
    fontSize: attrs?.defaultFontSize,
  };

  const spacingBefore = attrs?.spacing?.before ?? 0;
  const spacingAfter = attrs?.spacing?.after ?? 0;

  // A structural trailing empty paragraph — the one Word leaves after a table
  // in a header — is marked to measure at zero so it doesn't inflate the band.
  if (attrs?.suppressEmptyParagraphHeight && !hasVisibleContent(block)) {
    return {
      kind: 'paragraph',
      lines: [blankLine(0)],
      totalHeight: 0,
    };
  }

  const tokens = tokenise(block.runs, defaults);
  const lines = fillLines(block, tokens, availableWidth, defaults, config);

  // The float skip is space the paragraph OCCUPIES — a line pushed 120px down to
  // clear an image sits 120px lower, and everything after it does too. Omitting
  // it here while pagination counts it (`sliceHeight`) would report a footprint
  // short by exactly that much, and the float pre-pass — which advances its
  // coordinate space by `totalHeight` — would probe every following paragraph
  // against the zones at too small a Y, pushing them down again, and again.
  const contentHeight = lines.reduce(
    (sum, line) => sum + line.lineHeight + (line.floatSkipBefore ?? 0),
    0
  );
  return {
    kind: 'paragraph',
    lines,
    totalHeight: contentHeight + spacingBefore + spacingAfter,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — tokenise
// ---------------------------------------------------------------------------

/** A slice of one run that a token is built from. */
interface Piece {
  runIndex: number;
  from: number;
  to: number;
  width: number;
}

type Token =
  | { kind: 'word'; pieces: Piece[]; width: number }
  | { kind: 'space'; pieces: Piece[]; width: number }
  | { kind: 'tab'; runIndex: number; style: FontStyle }
  | { kind: 'break'; runIndex: number }
  | { kind: 'image'; runIndex: number; run: ImageRun; inFlow: boolean };

/**
 * Flatten runs into break-opportunity units.
 *
 * The one subtlety is the cross-run word. We keep a word token open across a
 * run boundary whenever the previous run ended on a non-space and the next
 * begins with one, because OOXML splits a *word* into several runs whenever its
 * formatting changes mid-word — a bold syllable, a superscript footnote
 * reference. Those are one wrapping unit, and treating each run as its own
 * token would let the line break between them.
 */
function tokenise(runs: Run[], defaults: Partial<FontStyle>): Token[] {
  const tokens: Token[] = [];
  /** The word still open across the current run boundary, if any. */
  let openWord: Extract<Token, { kind: 'word' }> | null = null;

  const closeWord = (): void => {
    openWord = null;
  };

  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];

    switch (run.kind) {
      case 'lineBreak':
        closeWord();
        tokens.push({ kind: 'break', runIndex });
        break;

      case 'tab':
        closeWord();
        tokens.push({ kind: 'tab', runIndex, style: styleFor(run, defaults) });
        break;

      case 'image':
        closeWord();
        // A FLOATING image is not in the line. The painter lifts it out to the
        // page's float layer (`renderParagraph/line.ts` skips it), and the
        // float pre-pass has already reserved its space by narrowing the lines
        // around it. Measuring it inline as well would advance the pen by its
        // width and floor the line at its height — so the text would be laid out
        // a couple of hundred pixels right of where it paints, the line would be
        // as tall as the picture, and the space would be reserved twice.
        //
        // It still gets a zero-width token, so its document positions stay inside
        // a line's range and remain addressable by the caret.
        tokens.push({ kind: 'image', runIndex, run, inFlow: !isFloatingImageRun(run) });
        break;

      case 'field': {
        // A field is atomic: its result is one unbreakable unit, and its
        // char offsets are the node's, not its text's.
        closeWord();
        const style = styleFor(run, defaults);
        const width = measureTextWidth(run.fallback, style);
        tokens.push({
          kind: 'word',
          pieces: [{ runIndex, from: 0, to: 1, width }],
          width,
        });
        closeWord();
        break;
      }

      case 'text': {
        const style = styleFor(run, defaults);
        const text = run.text;
        let i = 0;

        while (i < text.length) {
          const isSpace = isBreakingSpace(text[i]);
          let j = i;
          while (j < text.length && isBreakingSpace(text[j]) === isSpace) j++;

          const width = measureTextWidth(text.slice(i, j), style);
          const piece: Piece = { runIndex, from: i, to: j, width };

          if (isSpace) {
            closeWord();
            tokens.push({ kind: 'space', pieces: [piece], width });
          } else if (openWord && i === 0) {
            // This run begins mid-word — glue it onto the word already open.
            openWord.pieces.push(piece);
            openWord.width += width;
          } else {
            const word: Extract<Token, { kind: 'word' }> = {
              kind: 'word',
              pieces: [piece],
              width,
            };
            tokens.push(word);
            openWord = word;
          }

          i = j;
        }

        // The word stays open only if this run ended on a non-space, so the
        // next run can continue it.
        if (text.length === 0 || isBreakingSpace(text[text.length - 1])) closeWord();
        break;
      }
    }
  }

  return tokens;
}

/**
 * Spaces you may break a line at.
 *
 * The set is defined by what it *excludes*. A no-break space (U+00A0), a narrow
 * one (U+202F), and a figure space (U+2007) all look like spaces and measure
 * like spaces, but their whole purpose is to forbid a break — that is why a
 * document uses one instead of a plain space. Wrapping at them would break
 * exactly the text the author went out of their way to keep together: "10 km",
 * "Fig. 4", "M. Curie".
 *
 * Everything else in the Unicode space family is fair game, including the
 * typographic quads (U+2000-U+200A) and the ideographic space (U+3000).
 */
function isBreakingSpace(ch: string): boolean {
  if (ch === ' ' || ch === '\t') return true;
  // The no-break family: looks like a space, wraps like a letter.
  if (ch === '\u00A0' || ch === '\u2007' || ch === '\u202F') return false;
  return (ch >= '\u2000' && ch <= '\u200A') || ch === '\u3000';
}

// ---------------------------------------------------------------------------
// Stage 2 — fill lines
// ---------------------------------------------------------------------------

/** What the floats do to the line at the current pen. */
interface LineBand {
  margins: FloatingLineMargins;
  /** Px the line must drop to clear a band it has no room beside. */
  skip: number;
}

/** The line currently being filled. */
interface OpenLine {
  from: { runIndex: number; char: number } | null;
  to: { runIndex: number; char: number } | null;
  /** Pen X within the current segment, px. */
  penX: number;
  /** Tallest natural line height among the runs placed so far. */
  naturalHeight: number;
  maxAscent: number;
  maxDescent: number;
  /** Tallest image placed on this line — a floor on the line's height. */
  imageHeight: number;
  /** Filled segments, when a float split the line. */
  segments: LineSegment[];
  /** Whether each segment has taken any content yet. */
  segmentStarted: boolean[];
  segmentIndex: number;
  hasContent: boolean;
  /** Px this line was pushed down to clear a float band. */
  floatSkipBefore: number;
  /** Float exclusion on each side of this line — what the painter insets by. */
  floatLeftMargin: number;
  floatRightMargin: number;
  /**
   * True when this line exists because the previous one ran out of room. Only
   * such a line swallows a leading space; a line that begins a paragraph, or
   * follows an explicit break, keeps every space it was authored with.
   */
  startedByWrap: boolean;
  /** Painted advance of runs whose width isn't recoverable from the run alone. */
  atomAdvances: Record<number, number>;
}

function fillLines(
  block: ParagraphBlock,
  tokens: Token[],
  availableWidth: number,
  defaults: Partial<FontStyle>,
  config: ParagraphLayoutOptions
): MeasuredLine[] {
  const attrs = block.attrs;
  const zones = config.floatingZones;
  const paragraphY = config.paragraphYOffset ?? 0;

  const indentLeft = attrs?.indent?.left ?? 0;
  const indentRight = attrs?.indent?.right ?? 0;
  const firstLineIndent = attrs?.indent?.firstLine ?? 0;
  const hanging = attrs?.indent?.hanging ?? 0;
  const markerWidth = getListMarkerInlineWidth(block);

  const defaultStyle = resolveFontStyle(undefined, defaults);
  const defaultMetrics = fontMetricsFor(defaultStyle);
  const emptyMetrics = {
    ...defaultMetrics,
    lineHeight: Math.max(
      defaultMetrics.lineHeight,
      pointsToPixels(defaultStyle.fontSize) * WORD_SINGLE_LINE_RATIO
    ),
  };
  const tabRuler: TabRuler = {
    explicitStops: attrs?.tabs,
    leftIndent: Math.round(indentLeft * 15),
    defaultStopTwips: attrs?.defaultTabMarkTwips,
  };

  const lines: MeasuredLine[] = [];
  /** Y of the top of the line being filled, relative to the paragraph. */
  let penY = 0;
  let lineIndex = 0;

  /**
   * The float situation at the current pen.
   *
   * The line's true height isn't known until it's full — but its available
   * width depends on where it sits, which we need *before* filling it. Probe
   * with the paragraph's base line height: the answer only differs for a line
   * whose height is dominated by an over-tall image, and such a line holds
   * nothing but that image anyway.
   */
  const bandFor = (): LineBand => {
    const provisional = emptyMetrics.lineHeight;
    const absoluteY = paragraphY + penY;
    const clearY = findClearLineY(
      absoluteY,
      provisional,
      zones,
      availableWidth,
      MIN_LINE_TEXT_WIDTH
    );
    return {
      margins: getFloatingMargins(clearY, provisional, zones, 0),
      skip: Math.max(0, clearY - absoluteY),
    };
  };

  /** Where line `index` starts: indents, plus the list marker on the first line. */
  const indentFor = (index: number): number =>
    index === 0 ? indentLeft + firstLineIndent - hanging + markerWidth : indentLeft;

  /**
   * The runnable segments of line `index`: one per gap the floats leave. The
   * common case is a single segment spanning the whole band.
   */
  const segmentsFor = (index: number, margins: FloatingLineMargins): LineSegment[] => {
    const indent = indentFor(index);
    const zoneSegments = margins.segments;

    if (zoneSegments && zoneSegments.length > 0) {
      return zoneSegments
        .map((seg) => {
          const left = Math.max(seg.leftOffset, indent);
          const right = seg.leftOffset + seg.availableWidth;
          return blankSegment(
            left,
            Math.max(0, Math.min(right, availableWidth - indentRight) - left)
          );
        })
        .filter((seg) => seg.availableWidth > 0);
    }

    const left = indent + margins.leftMargin;
    const width = availableWidth - indentRight - margins.rightMargin - left;
    return [blankSegment(left, Math.max(0, width))];
  };

  let band = bandFor();
  let line = openLine(segmentsFor(lineIndex, band.margins), band);

  /**
   * Commit the open line and start the next one. `byWrap` says whether the next
   * line exists because this one ran out of room (as opposed to an explicit
   * break, which starts a line the author asked for).
   */
  const flush = (force: boolean, byWrap = false): void => {
    if (!line.hasContent && !force) return;
    const closed = closeLine(line, attrs, emptyMetrics);
    lines.push(closed);
    // The skip pushed this line down past a float; the next line starts below
    // both the skip and the line itself.
    penY += (closed.floatSkipBefore ?? 0) + closed.lineHeight;
    lineIndex++;
    band = bandFor();
    line = openLine(segmentsFor(lineIndex, band.margins), band, byWrap);
  };

  /** Room left in the segment the pen is in. */
  const roomLeft = (): number => {
    const seg = line.segments[line.segmentIndex];
    return seg ? seg.availableWidth - line.penX : 0;
  };

  /**
   * Make room for `width`. Move to the next segment of this line if there is
   * one, otherwise wrap to a new line. Returns false when the token has to be
   * placed anyway (it doesn't fit anywhere — a single unbreakable token wider
   * than the column).
   */
  const makeRoom = (width: number): boolean => {
    if (width <= roomLeft() + WRAP_TOLERANCE_PX) return true;

    if (line.segmentIndex < line.segments.length - 1) {
      advanceSegment(line);
      if (width <= roomLeft() + WRAP_TOLERANCE_PX) return true;
    }
    if (!line.hasContent) return false; // Nothing to wrap away from.

    flush(false, true);
    return width <= roomLeft() + WRAP_TOLERANCE_PX;
  };

  for (const token of tokens) {
    switch (token.kind) {
      case 'break':
        placeAtomic(line, token.runIndex, 0, 1, 0);
        flush(true);
        break;

      case 'space':
        // A space at the head of a line is swallowed ONLY when it is the residue
        // of the wrap that made the line — Word does not indent a wrapped line
        // by the space it broke at.
        //
        // It is emphatically not swallowed at the start of a paragraph, or after
        // an explicit break: `xml:space="preserve"` text like `"    Indented"`
        // means those spaces, and dropping them would leave their characters
        // outside every line's range — unpainted, and unaddressable by any
        // document position.
        if (!line.hasContent && line.startedByWrap) break;
        placePieces(line, token.pieces, token.width);
        break;

      case 'word': {
        if (makeRoom(token.width)) {
          placePieces(line, token.pieces, token.width);
          growForFont(line, token.pieces, block.runs, defaults, emptyMetrics);
          break;
        }

        // Word breaks a single token at character boundaries when it is wider
        // than the line itself. Keeping ordinary words atomic is still
        // important (especially across formatting-run boundaries), so this
        // fallback runs only after makeRoom has tried every normal wrap
        // opportunity and landed on an empty line.
        let remaining: Extract<Token, { kind: 'word' }> | null = token;
        while (remaining) {
          if (remaining.width <= roomLeft() + WRAP_TOLERANCE_PX) {
            placePieces(line, remaining.pieces, remaining.width);
            growForFont(line, remaining.pieces, block.runs, defaults, emptyMetrics);
            break;
          }

          const split = splitWordToFit(remaining, roomLeft(), block.runs, defaults);
          if (!split) {
            // Fields and other atomic word pieces cannot be sliced safely.
            placePieces(line, remaining.pieces, remaining.width);
            growForFont(line, remaining.pieces, block.runs, defaults, emptyMetrics);
            break;
          }

          placePieces(line, split.head.pieces, split.head.width);
          growForFont(line, split.head.pieces, block.runs, defaults, emptyMetrics);
          remaining = split.tail;
          if (remaining) flush(false, true);
        }
        break;
      }

      case 'tab': {
        const seg = line.segments[line.segmentIndex];
        const penFromContentEdge = (seg?.leftOffset ?? 0) + line.penX;
        const following = followingContentWidth(tokens, token, block.runs, defaults);
        const run = block.runs[token.runIndex] as TabRun;
        const positionalTarget =
          run.positional?.relativeTo === 'indent'
            ? (attrs?.indent?.left ?? 0) + (seg?.availableWidth ?? availableWidth)
            : (seg?.leftOffset ?? 0) + (seg?.availableWidth ?? availableWidth);
        const advance = run.positional
          ? calculatePositionalTabWidth(penFromContentEdge, positionalTarget, run.positional, {
              followingWidth: following.width,
              decimalPrefixWidth: following.decimalPrefixWidth,
            })
          : calculateTabWidth(penFromContentEdge, tabRuler, {
              followingWidth: following.width,
              decimalPrefixWidth: following.decimalPrefixWidth,
            });
        // A tab that overshoots the line just fills what's left of it.
        const width = Math.min(advance.width, Math.max(0, roomLeft()));
        placeAtomic(line, token.runIndex, 0, 1, width);
        // Only the breaker knows where the pen was, so only the breaker can say
        // how far this tab advanced. Record it, or the caret can't be placed
        // after it.
        line.atomAdvances[token.runIndex] = width;
        growForStyle(line, token.style, emptyMetrics);
        break;
      }

      case 'image': {
        if (!token.inFlow) {
          // Out of flow: it occupies no width and contributes no height. It is
          // marked only so the caret can still reach it.
          placeAtomic(line, token.runIndex, 0, 1, 0);
          line.atomAdvances[token.runIndex] = 0;
          break;
        }

        const declaredWidth = token.run.width;
        // The painter fits an inline image to its column (`max-width: 100%`),
        // so an over-wide image paints scaled down. Reserve the height it will
        // actually paint at, not the height it declares — otherwise a tall gap
        // opens under it.
        const segWidth = line.segments[line.segmentIndex]?.availableWidth ?? declaredWidth;
        makeRoom(Math.min(declaredWidth, segWidth));
        const fitWidth = line.segments[line.segmentIndex]?.availableWidth ?? declaredWidth;
        const scale = declaredWidth > fitWidth && fitWidth > 0 ? fitWidth / declaredWidth : 1;

        const paintedWidth = declaredWidth * scale;
        const geometry = getImagePaintGeometry(token.run, { paintedWidth });
        placeAtomic(line, token.runIndex, 0, 1, paintedWidth);
        line.atomAdvances[token.runIndex] = paintedWidth;
        // Attribute the height to the line the image LANDS on, which is only
        // known after makeRoom has decided whether it wrapped (#766).
        // Fold the actual painted bbox plus wp:inline distT/distB into the line
        // height so rotated wrappers and tracked-change bars share one geometry.
        line.imageHeight = Math.max(
          line.imageHeight,
          geometry.boxHeight + geometry.marginTop + geometry.marginBottom
        );
        break;
      }
    }
  }

  // A paragraph always occupies at least one line — an empty one still shows a
  // caret and still takes vertical space.
  flush(lines.length === 0);

  return lines;
}

function blankSegment(leftOffset: number, availableWidth: number): LineSegment {
  return {
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 0,
    width: 0,
    availableWidth,
    leftOffset,
  };
}

function openLine(segments: LineSegment[], band: LineBand, startedByWrap = false): OpenLine {
  return {
    from: null,
    to: null,
    penX: 0,
    naturalHeight: 0,
    maxAscent: 0,
    maxDescent: 0,
    imageHeight: 0,
    segments: segments.map((s) => ({ ...s })),
    segmentStarted: segments.map(() => false),
    segmentIndex: 0,
    hasContent: false,
    floatSkipBefore: band.skip,
    floatLeftMargin: band.margins.leftMargin,
    floatRightMargin: band.margins.rightMargin,
    startedByWrap,
    atomAdvances: {},
  };
}

function advanceSegment(line: OpenLine): void {
  const seg = line.segments[line.segmentIndex];
  if (seg) seg.width = line.penX;
  line.segmentIndex++;
  line.penX = 0;
}

function placePieces(line: OpenLine, pieces: Piece[], width: number): void {
  for (const piece of pieces) {
    mark(line, piece.runIndex, piece.from, piece.to);
  }
  line.penX += width;
  line.hasContent = true;
}

/**
 * Split an overlong word at the last code-point boundary that fits.
 *
 * Pieces preserve formatting-run boundaries, while the returned ranges let the
 * painter and selection mapper slice the original runs without inventing text.
 * `null` means the word starts with an atomic non-text piece and must overflow.
 */
function splitWordToFit(
  word: Extract<Token, { kind: 'word' }>,
  maxWidth: number,
  runs: Run[],
  defaults: Partial<FontStyle>
): {
  head: Extract<Token, { kind: 'word' }>;
  tail: Extract<Token, { kind: 'word' }> | null;
} | null {
  if (!(maxWidth > 0)) return null;

  const headPieces: Piece[] = [];
  const tailPieces: Piece[] = [];
  let headWidth = 0;
  let splitIndex = word.pieces.length;

  for (let i = 0; i < word.pieces.length; i++) {
    const piece = word.pieces[i];
    if (headWidth + piece.width <= maxWidth + WRAP_TOLERANCE_PX) {
      headPieces.push(piece);
      headWidth += piece.width;
      continue;
    }

    const run = runs[piece.runIndex];
    if (!run || run.kind !== 'text') {
      if (headPieces.length === 0) return null;
      splitIndex = i;
      break;
    }

    const available = Math.max(0, maxWidth - headWidth);
    let end = fittingTextEnd(run.text, piece.from, piece.to, available, styleFor(run, defaults));
    if (end <= piece.from && headPieces.length > 0) {
      splitIndex = i;
      break;
    }
    if (end <= piece.from) {
      end = Math.min(piece.to, nextGraphemeBoundary(run.text, piece.from));
    }

    const fittedWidth = measureTextWidth(run.text.slice(piece.from, end), styleFor(run, defaults));
    headPieces.push({ ...piece, to: end, width: fittedWidth });
    headWidth += fittedWidth;
    if (end < piece.to) {
      const restWidth = measureTextWidth(run.text.slice(end, piece.to), styleFor(run, defaults));
      tailPieces.push({ ...piece, from: end, width: restWidth });
    }
    splitIndex = i + 1;
    break;
  }

  for (let i = splitIndex; i < word.pieces.length; i++) {
    tailPieces.push(word.pieces[i]);
  }

  if (headPieces.length === 0) return null;
  const tailWidth = tailPieces.reduce((sum, piece) => sum + piece.width, 0);
  return {
    head: { kind: 'word', pieces: headPieces, width: headWidth },
    tail: tailPieces.length > 0 ? { kind: 'word', pieces: tailPieces, width: tailWidth } : null,
  };
}

/** Last UTF-16 boundary whose measured prefix fits in `maxWidth`. */
function fittingTextEnd(
  text: string,
  from: number,
  to: number,
  maxWidth: number,
  style: FontStyle
): number {
  const boundaries = graphemeBoundaries(text).filter(
    (boundary) => boundary > from && boundary <= to
  );
  let low = 0;
  let high = boundaries.length - 1;
  let fitted = from;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const boundary = boundaries[mid];
    const width = measureTextWidth(text.slice(from, boundary), style);
    if (width <= maxWidth + WRAP_TOLERANCE_PX) {
      fitted = boundary;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return fitted;
}

function placeAtomic(
  line: OpenLine,
  runIndex: number,
  from: number,
  to: number,
  width: number
): void {
  mark(line, runIndex, from, to);
  line.penX += width;
  line.hasContent = true;
}

/** Extend the line's `[fromRun, fromChar] → [toRun, toChar]` span. */
function mark(line: OpenLine, runIndex: number, from: number, to: number): void {
  if (!line.from) line.from = { runIndex, char: from };
  line.to = { runIndex, char: to };

  const i = line.segmentIndex;
  const seg = line.segments[i];
  if (!seg) return;

  if (!line.segmentStarted[i]) {
    seg.fromRun = runIndex;
    seg.fromChar = from;
    line.segmentStarted[i] = true;
  }
  seg.toRun = runIndex;
  seg.toChar = to;
}

/** Grow the line box to fit the fonts of the runs the pieces came from. */
function growForFont(
  line: OpenLine,
  pieces: Piece[],
  runs: Run[],
  defaults: Partial<FontStyle>,
  fallback: { ascent: number; descent: number; lineHeight: number }
): void {
  for (const piece of pieces) {
    const run = runs[piece.runIndex];
    if (!run || (run.kind !== 'text' && run.kind !== 'field')) continue;
    growForStyle(line, styleFor(run, defaults), fallback);
  }
}

function growForStyle(
  line: OpenLine,
  style: FontStyle,
  fallback: { ascent: number; descent: number; lineHeight: number }
): void {
  const m = fontMetricsFor(style) ?? fallback;
  line.naturalHeight = Math.max(line.naturalHeight, m.lineHeight);
  line.maxAscent = Math.max(line.maxAscent, m.ascent);
  line.maxDescent = Math.max(line.maxDescent, m.descent);
}

/**
 * Turn the open line into a `MeasuredLine`.
 *
 * The height is the font's natural line height put through `w:lineRule`, then
 * floored by the tallest image on the line. The rule multiplies *text* height
 * only — an image is already its own size, and scaling it by the line spacing
 * would open a gap under every picture in a double-spaced paragraph.
 */
function closeLine(
  line: OpenLine,
  attrs: ParagraphBlock['attrs'],
  fallback: { ascent: number; descent: number; lineHeight: number }
): MeasuredLine {
  const natural = line.naturalHeight > 0 ? line.naturalHeight : fallback.lineHeight;
  const spaced = applyLineRule(natural, attrs);
  const lineHeight = Math.max(spaced, line.imageHeight);

  const descent = line.maxDescent > 0 ? line.maxDescent : fallback.descent;
  const ascent = Math.max(0, lineHeight - descent);

  const seg = line.segments[line.segmentIndex];
  if (seg) seg.width = line.penX;

  const from = line.from ?? { runIndex: 0, char: 0 };
  const to = line.to ?? { runIndex: 0, char: 0 };

  const measured: MeasuredLine = {
    fromRun: from.runIndex,
    fromChar: from.char,
    toRun: to.runIndex,
    toChar: to.char,
    width: line.segments.reduce((sum, s) => sum + s.width, 0),
    ascent,
    descent,
    lineHeight,
  };

  const floatLeft = line.floatLeftMargin;
  const floatRight = line.floatRightMargin;
  if (floatLeft > 0) measured.leftOffset = floatLeft;
  if (floatRight > 0) measured.rightOffset = floatRight;
  if (line.floatSkipBefore > 0) measured.floatSkipBefore = line.floatSkipBefore;
  if (Object.keys(line.atomAdvances).length > 0) measured.atomAdvances = line.atomAdvances;

  // Only report segments when a float actually split the line into two runnable
  // pieces. A single segment IS the line, and the painter has a faster path for
  // that — reporting one would send every ordinary line down the slow path.
  const filled = line.segments.filter((s) => s.width > 0);
  if (filled.length > 1) measured.segments = filled;

  return measured;
}

/**
 * `w:spacing/@w:line` + `@w:lineRule` (§17.3.1.33, §17.18.48).
 *
 * `auto` scales the natural height (the bridge has already divided Word's
 * 240ths into a multiplier). `exact` replaces it outright — exact means exact,
 * even when that clips the glyphs, which is what Word does. `atLeast` floors it.
 */
function applyLineRule(natural: number, attrs: ParagraphBlock['attrs']): number {
  const spacing = attrs?.spacing;
  if (!spacing || spacing.line == null) return natural;

  switch (spacing.lineRule) {
    case 'exact':
      return spacing.line;
    case 'atLeast':
      return Math.max(natural, spacing.line);
    case 'auto':
    default:
      return spacing.lineUnit === 'px' ? spacing.line : natural * spacing.line;
  }
}

/** A zero-height line: an empty paragraph the caller asked us to suppress. */
function blankLine(height: number): MeasuredLine {
  return {
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 0,
    width: 0,
    ascent: 0,
    descent: 0,
    lineHeight: height,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function styleFor(run: Run, defaults: Partial<FontStyle>): FontStyle {
  if (run.kind === 'image' || run.kind === 'lineBreak') {
    return resolveFontStyle(undefined, defaults);
  }
  return resolveFontStyle(run, defaults);
}

/**
 * True when the paragraph would paint something. Whitespace counts — an authored
 * space still occupies a line — but a paragraph with no runs at all does not.
 */
function hasVisibleContent(block: ParagraphBlock): boolean {
  return block.runs.some((run) => (run.kind === 'text' ? run.text.length > 0 : true));
}

/**
 * Width of the content between a tab and the next tab (or the end of the line),
 * which is what an `end`/`center`/`decimal` stop anchors against.
 */
function followingContentWidth(
  tokens: Token[],
  tab: Token,
  runs: Run[],
  defaults: Partial<FontStyle>
): { width: number; decimalPrefixWidth: number } {
  let width = 0;
  let decimalPrefixWidth = 0;
  let text = '';
  let seenDecimal = false;

  for (let i = tokens.indexOf(tab) + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'tab' || token.kind === 'break') break;

    if (token.kind === 'image') {
      width += token.run.width;
      continue;
    }
    width += token.width;

    // The decimal prefix is everything up to the first '.' in the trailing text.
    if (!seenDecimal) {
      for (const piece of token.pieces) {
        const run = runs[piece.runIndex];
        const chunk = run?.kind === 'text' ? run.text.slice(piece.from, piece.to) : '';
        const dot = chunk.indexOf('.');
        if (dot >= 0) {
          text += chunk.slice(0, dot);
          seenDecimal = true;
          decimalPrefixWidth = measureTextWidth(
            text,
            styleFor(run ?? { kind: 'text', text: '' }, defaults)
          );
          break;
        }
        text += chunk;
      }
    }
  }

  return { width, decimalPrefixWidth };
}
