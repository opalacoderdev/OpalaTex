/**
 * The text-measurement port.
 *
 * Everything the engine knows about glyphs enters through this module, and it
 * has exactly two jobs:
 *
 *  - **Advance widths** come from a canvas 2D context. That is the only way to
 *    get them right, and it is the only thing we ask the canvas for.
 *  - **Vertical metrics** (ascent, descent, line height) come from the font's
 *    own bounding box when the platform reports one, and from a fixed ratio
 *    model when it doesn't.
 *
 * The split matters. `bun:test` has no DOM, so there is no canvas: the width
 * path is stubbed by the test and the vertical path takes the ratio branch,
 * which makes measurement a deterministic pure function of the inputs. That is
 * what lets the whole engine unit suite run headless.
 *
 * @packageDocumentation
 * @public
 */

import {
  twipsToPixels,
  pixelsToTwips,
  pointsToPixels,
  halfPointsToPixels,
  PIXELS_PER_INCH,
} from '../../utils/units';
import {
  getCachedFontMetrics,
  setCachedFontMetrics,
  getCachedTextWidth,
  setCachedTextWidth,
  clearAllCaches,
} from './cache';
import { resolveFontFamily } from '../../utils/fontResolver';

/**
 * The font a run is painted in — the key the measurement port is memoised on.
 *
 * @public
 */
export interface FontStyle {
  fontFamily: string;
  /** Points. */
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  /** CSS px added between painted grapheme clusters. */
  letterSpacing?: number;
  /** OOXML `w:w`, as a percentage (100 = normal width). */
  horizontalScale?: number;
  allCaps?: boolean;
  smallCaps?: boolean;
}

/**
 * A font's vertical metrics, px, for a given size.
 *
 * @public
 */
export interface FontMetrics {
  ascent: number;
  descent: number;
  /** Word's OS/2 single-line height for this font and size. */
  lineHeight: number;
}

/**
 * A measured string.
 *
 * @public
 */
export interface TextMeasurement {
  width: number;
  height: number;
  ascent: number;
  descent: number;
}

/**
 * A measured run: its text metrics plus the per-character advances that
 * hit-testing needs to find the caret column inside it.
 *
 * @public
 */
export interface RunMeasurement extends TextMeasurement {
  /** Cumulative advance after each character; `length === text.length`. */
  charWidths: number[];
}

/**
 * Ratio model used when the platform reports no font bounding box (headless
 * tests, and any browser that declines the metric).
 *
 * These are conservative browser fallback glyph proportions. The line box
 * itself comes from the font's OS/2 single-line ratio.
 */
const FALLBACK_ASCENT_RATIO = 0.8;
const FALLBACK_DESCENT_RATIO = 0.2;

/**
 * Empty paragraphs need a caret-height floor even when the selected font's
 * single-line metric is tighter. Text-bearing lines use the font-specific OS/2
 * ratio from `resolveFontFamily`.
 */
export const WORD_SINGLE_LINE_RATIO = 1.15;

const FALLBACK_FONT_FAMILY = 'Calibri';
const FALLBACK_FONT_SIZE_PT = 11;

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

/** The measuring context, once we've successfully made one. */
let measuringContext: CanvasRenderingContext2D | null = null;

/**
 * The 2D context used for glyph advances, or `null` when there is no DOM.
 *
 * The absence of a canvas is deliberately **not** memoised. A canvas can appear
 * after the first lookup — a test installs a stub, a headless renderer mounts a
 * DOM — and a cached "there is no canvas" would keep every later measurement on
 * the zero-width path for the life of the process. Re-probing costs a `typeof`.
 *
 * When one does appear, every width memoised before it is wrong (they were all
 * taken without glyphs), so the caches are dropped at that moment.
 *
 * @public
 */
export function getCanvasContext(): CanvasRenderingContext2D | null {
  if (measuringContext) return measuringContext;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  const created = (canvas.getContext('2d') as CanvasRenderingContext2D | null) ?? null;
  if (!created) return null;

  measuringContext = created;
  // EVERY memo taken before now was built from zero-width glyphs — including
  // whole paragraph layouts, which would otherwise stay one-line-per-paragraph
  // for the life of the process.
  clearAllCaches();
  return measuringContext;
}

/**
 * Drop the measuring context and every measurement taken through it.
 *
 * Tests call this after swapping a canvas stub. The app calls it when a webfont
 * finishes loading: every width taken before the face arrived was measured
 * against a fallback face, and is now wrong.
 *
 * @public
 */
export function resetCanvasContext(): void {
  measuringContext = null;
  clearAllCaches();
}

/**
 * The CSS `font` shorthand for a style — what the canvas wants, and what the
 * width cache is keyed on.
 *
 * @public
 */
export function toCssFont(style: FontStyle): string {
  const parts: string[] = [];
  if (style.italic) parts.push('italic');
  if (style.smallCaps) parts.push('small-caps');
  if (style.bold) parts.push('bold');
  parts.push(`${pointsToPixels(style.fontSize)}px`);
  parts.push(quoteFamily(style.fontFamily));
  return parts.join(' ');
}

/**
 * A DOCX font name is attacker-controlled, and it is interpolated into a CSS
 * font shorthand. Quote it, and escape what a quote can't contain, so a crafted
 * family name can't terminate the declaration and inject another.
 */
function quoteFamily(family: string): string {
  const escaped = family.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Vertical metrics
// ---------------------------------------------------------------------------

/**
 * Ascent, descent, and natural line height for a font, px.
 *
 * @public
 */
export function fontMetricsFor(style: FontStyle): FontMetrics {
  const key = toCssFont(style);
  const cached = getCachedFontMetrics(key);
  if (cached) return cached;

  const fontSizePx = pointsToPixels(style.fontSize);
  const bounds = readFontBoundingBox(key) ?? ratioMetrics(fontSizePx);
  const lineHeight = fontSizePx * resolveFontFamily(style.fontFamily).singleLineRatio;
  const metrics = { ...bounds, lineHeight };

  setCachedFontMetrics(key, metrics);
  return metrics;
}

/**
 * Read the font's own bounding box off the canvas. Returns null whenever the
 * platform doesn't report one — no canvas, or a context (including our test
 * stubs) whose `measureText` result omits the font-box fields.
 */
function readFontBoundingBox(fontString: string): Pick<FontMetrics, 'ascent' | 'descent'> | null {
  const ctx = getCanvasContext();
  if (!ctx) return null;

  ctx.font = fontString;
  const m = ctx.measureText('Hg') as TextMetrics | undefined;
  const ascent = m?.fontBoundingBoxAscent;
  const descent = m?.fontBoundingBoxDescent;
  if (typeof ascent !== 'number' || typeof descent !== 'number') return null;
  if (!(ascent > 0) || !(descent >= 0)) return null;

  return { ascent, descent };
}

function ratioMetrics(fontSizePx: number): Pick<FontMetrics, 'ascent' | 'descent'> {
  return {
    ascent: fontSizePx * FALLBACK_ASCENT_RATIO,
    descent: fontSizePx * FALLBACK_DESCENT_RATIO,
  };
}

// ---------------------------------------------------------------------------
// Advance widths
// ---------------------------------------------------------------------------

/**
 * Painted width of a string in a font, px.
 *
 * @public
 */
export function measureTextWidth(text: string, style: FontStyle): number {
  if (text === '') return 0;

  const fontString = toCssFont(style);
  const paintedText = style.allCaps ? text.toUpperCase() : text;
  const letterSpacing =
    typeof style.letterSpacing === 'number' && Number.isFinite(style.letterSpacing)
      ? style.letterSpacing
      : 0;
  const horizontalScale =
    typeof style.horizontalScale === 'number' &&
    Number.isFinite(style.horizontalScale) &&
    style.horizontalScale > 0
      ? style.horizontalScale / 100
      : 1;
  const widthStyleKey = `${fontString};ls:${letterSpacing};sx:${horizontalScale};caps:${style.allCaps ? 1 : 0}`;

  // Long strings are measured but not memoised. The cache is keyed by the string
  // itself, so a long string is a long key — and the hit rate on them is near
  // zero: a paragraph is measured word by word, while the caret's binary search
  // walks a *different* prefix at every step. Caching those would store O(n)
  // keys of O(n) length for one click on one run, which for a pathological
  // single-`w:t` document is hundreds of megabytes of keys.
  if (text.length > MAX_MEMOISED_RUN_CHARS) {
    return decoratedWidth(paintedText, fontString, letterSpacing, horizontalScale);
  }

  const key = cacheKey(widthStyleKey, text);
  const cached = getCachedTextWidth(key);
  if (cached !== undefined) return cached;

  const width = decoratedWidth(paintedText, fontString, letterSpacing, horizontalScale);
  setCachedTextWidth(key, width);
  return width;
}

/** Longer than any word; short enough that holding the key is cheap. */
const MAX_MEMOISED_RUN_CHARS = 256;

/**
 * The width memo's key: the font, then the text.
 *
 * The separator is a newline because a CSS font shorthand cannot contain one —
 * so no font name, however crafted, can make two different (font, text) pairs
 * collide on the same key and be served each other's width.
 */
function cacheKey(fontString: string, text: string): string {
  return `${fontString}\n${text}`;
}

/**
 * Without a canvas there are no glyphs to measure, so there is nothing
 * defensible to return. Zero is the honest answer: it makes the absence
 * obvious (every line comes out empty) instead of inventing a plausible-looking
 * width that would quietly bake a wrong wrap into the layout. The unit suite
 * always installs a stub; the browser always has a real canvas.
 */
function canvasWidth(text: string, fontString: string): number {
  const ctx = getCanvasContext();
  if (!ctx) return 0;
  ctx.font = fontString;
  return ctx.measureText(text).width;
}

/**
 * Apply the same post-glyph inline geometry as CSS. Letter spacing is applied
 * once per painted grapheme (never inside a combining/emoji sequence), then
 * OOXML horizontal scaling scales the complete tracked run.
 */
function decoratedWidth(
  paintedText: string,
  fontString: string,
  letterSpacing: number,
  horizontalScale: number
): number {
  const glyphWidth = canvasWidth(paintedText, fontString);
  // CSS includes one trailing letter-spacing advance per grapheme in the
  // inline box (including after the last), so one-character spaced runs from
  // tracked changes still contribute their full advance.
  const graphemeCount =
    letterSpacing === 0 ? 0 : Math.max(0, graphemeBoundaries(paintedText).length - 1);
  return Math.max(0, glyphWidth + graphemeCount * letterSpacing) * horizontalScale;
}

/**
 * Measure a string: width plus the vertical metrics of its font.
 *
 * @public
 */
export function measureText(text: string, style: FontStyle): TextMeasurement {
  const { ascent, descent, lineHeight } = fontMetricsFor(style);
  return {
    width: measureTextWidth(text, style),
    height: lineHeight,
    ascent,
    descent,
  };
}

/**
 * Measure a run, including the per-character advances hit-testing needs.
 *
 * @public
 */
export function measureRun(text: string, style: FontStyle): RunMeasurement {
  return {
    ...measureText(text, style),
    charWidths: prefixAdvances(text, style),
  };
}

/**
 * Cumulative advance after each character of `text`, px.
 *
 * Measured cumulatively (prefix by prefix) rather than glyph by glyph, so the
 * numbers include the kerning between neighbours. Summing per-glyph widths
 * would drift from the painted string on any kerned pair.
 *
 * @public
 */
export function prefixAdvances(text: string, style: FontStyle): number[] {
  const advances: number[] = [];
  const boundaries = graphemeBoundaries(text);
  let previousBoundary = 0;
  let previousWidth = 0;

  for (let b = 1; b < boundaries.length; b++) {
    const boundary = boundaries[b];
    // Preserve the historical one-entry-per-UTF-16-code-unit shape. Interior
    // code units repeat the previous legal caret advance; only the grapheme's
    // final code unit receives its painted width.
    for (let i = previousBoundary + 1; i < boundary; i++) {
      advances.push(previousWidth);
    }
    previousWidth = measureTextWidth(text.slice(0, boundary), style);
    advances.push(previousWidth);
    previousBoundary = boundary;
  }
  return advances;
}

/**
 * Index of the character boundary nearest `x` within a run, px from its start.
 *
 * Returns a boundary in `[0, text.length]` — the caret sits *between* characters,
 * so both ends are valid answers.
 *
 * The search metrics **prefixes on demand**, never the whole advance table.
 * That matters because the run this is called on is not line-bounded: a DOCX may
 * hold a single `w:t` of half a million characters with no space in it, which
 * the line breaker cannot split and so places whole. Building the advance table
 * for that would be O(n) canvas metrics over O(n)-length strings — a single
 * click would hang the tab. Measuring `log₂(n)` prefixes instead is ~20 metrics
 * for a 500k-character run.
 *
 * @public
 */
export function charIndexAtX(text: string, style: FontStyle, x: number): number {
  if (text.length === 0 || x <= 0) return 0;
  if (x >= measureTextWidth(text, style)) return text.length;

  const boundaries = graphemeBoundaries(text);
  // Smallest grapheme boundary whose prefix width is >= x.
  let lo = 1;
  let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefixWidth(text, style, boundaries[mid]) < x) lo = mid + 1;
    else hi = mid;
  }

  const leftBoundary = boundaries[lo - 1];
  const rightBoundary = boundaries[lo];
  const leftEdge = prefixWidth(text, style, leftBoundary);
  const rightEdge = prefixWidth(text, style, rightBoundary);
  return x - leftEdge <= rightEdge - x ? leftBoundary : rightBoundary;
}

/**
 * Width of the first `count` characters, snapped to a whole code point.
 *
 * Slicing at a raw index can land between the two halves of a surrogate pair
 * (an emoji, a rare CJK glyph), which metrics as a lone replacement character
 * and puts the caret in the middle of something indivisible. Snapping keeps
 * every boundary a real one.
 */
function prefixWidth(text: string, style: FontStyle, count: number): number {
  return measureTextWidth(text.slice(0, snapToGrapheme(text, count)), style);
}

/**
 * Move `index` to the preceding legal grapheme boundary.
 *
 * @public
 */
export function snapToGrapheme(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;

  const boundaries = graphemeBoundaries(text);
  let lo = 0;
  let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (boundaries[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return boundaries[lo];
}

/** First legal grapheme boundary strictly after `index`. */
export function nextGraphemeBoundary(text: string, index: number): number {
  if (index < 0) return 0;
  if (index >= text.length) return text.length;
  const boundaries = graphemeBoundaries(text);
  for (const boundary of boundaries) {
    if (boundary > index) return boundary;
  }
  return text.length;
}

interface SegmentPart {
  index: number;
}

interface SegmenterLike {
  segment(input: string): Iterable<SegmentPart>;
}

type SegmenterConstructor = new (
  locales?: string | string[],
  config?: { granularity: 'grapheme' }
) => SegmenterLike;

/**
 * UTF-16 indices at every caret-safe grapheme boundary, including 0 and length.
 * `Intl.Segmenter` supplies Unicode's full algorithm where available; the
 * fallback covers combining marks, emoji modifiers, flags, and ZWJ sequences.
 */
export function graphemeBoundaries(text: string): number[] {
  if (text.length === 0) return [0];

  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (Segmenter) {
    const boundaries: number[] = [];
    for (const part of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      boundaries.push(part.index);
    }
    if (boundaries[0] !== 0) boundaries.unshift(0);
    if (boundaries[boundaries.length - 1] !== text.length) boundaries.push(text.length);
    return boundaries;
  }

  return fallbackGraphemeBoundaries(text);
}

function fallbackGraphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  let index = 0;
  while (index < text.length) {
    const first = codePointAt(text, index);
    index += first.length;

    if (first.value === 0x0d && codePointAt(text, index).value === 0x0a) {
      index += 1;
    } else if (isRegionalIndicator(first.value)) {
      const second = codePointAt(text, index);
      if (isRegionalIndicator(second.value)) index += second.length;
    }

    index = consumeExtenders(text, index);
    while (codePointAt(text, index).value === 0x200d) {
      index += 1;
      if (index >= text.length) break;
      index += codePointAt(text, index).length;
      index = consumeExtenders(text, index);
    }
    boundaries.push(index);
  }
  return boundaries;
}

function codePointAt(text: string, index: number): { value: number; length: number } {
  if (index >= text.length) return { value: -1, length: 0 };
  const value = text.codePointAt(index) ?? -1;
  return { value, length: value > 0xffff ? 2 : 1 };
}

function consumeExtenders(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const point = codePointAt(text, index);
    if (!isGraphemeExtender(point.value)) break;
    index += point.length;
  }
  return index;
}

function isGraphemeExtender(value: number): boolean {
  if (value < 0) return false;
  const char = String.fromCodePoint(value);
  return (
    /\p{Mark}/u.test(char) ||
    (value >= 0xfe00 && value <= 0xfe0f) ||
    (value >= 0xe0100 && value <= 0xe01ef) ||
    (value >= 0x1f3fb && value <= 0x1f3ff)
  );
}

function isRegionalIndicator(value: number): boolean {
  return value >= 0x1f1e6 && value <= 0x1f1ff;
}

/**
 * X offset of a character boundary within a run, px from its start. The inverse
 * of {@link charIndexAtX}.
 *
 * @public
 */
export function getXForCharacter(text: string, style: FontStyle, index: number): number {
  const clamped = Math.max(0, Math.min(index, text.length));
  if (clamped === 0) return 0;
  return measureTextWidth(text.slice(0, snapToGrapheme(text, clamped)), style);
}

/**
 * The font a run is painted in, with the document's defaults filled in for
 * whatever the run left unset.
 *
 * @public
 */
export function resolveFontStyle(
  run:
    | {
        fontSize?: number;
        fontFamily?: string;
        bold?: boolean;
        italic?: boolean;
        letterSpacing?: number;
        horizontalScale?: number;
        allCaps?: boolean;
        smallCaps?: boolean;
      }
    | undefined,
  defaults?: { fontSize?: number; fontFamily?: string }
): FontStyle {
  return {
    fontFamily: run?.fontFamily ?? defaults?.fontFamily ?? FALLBACK_FONT_FAMILY,
    fontSize: run?.fontSize ?? defaults?.fontSize ?? FALLBACK_FONT_SIZE_PT,
    bold: run?.bold,
    italic: run?.italic,
    letterSpacing: run?.letterSpacing,
    horizontalScale: run?.horizontalScale,
    allCaps: run?.allCaps,
    smallCaps: run?.smallCaps,
  };
}

// ---------------------------------------------------------------------------
// Unit conversions
//
// Re-exported here under the engine's short names so a measurement site reads
// as one vocabulary. The arithmetic lives in `utils/units.ts` and is not
// duplicated: 1440 twips = 1 inch and 914400 EMU = 1 inch are fixed by the
// format; 96 px/inch is the CSS rendering assumption.
// ---------------------------------------------------------------------------

/** Twips → px. @public */
export function twipsToPx(twips: number): number {
  return twipsToPixels(twips);
}

/** Px → twips. @public */
export function pxToTwips(px: number): number {
  return pixelsToTwips(px);
}

/** Points → px (1 pt = 4/3 px at 96 dpi). @public */
export function ptToPx(points: number): number {
  return pointsToPixels(points);
}

/** Px → points. @public */
export function pxToPt(px: number): number {
  return (px * 72) / PIXELS_PER_INCH;
}

/** Half-points (`w:sz`) → px. @public */
export function halfPtToPx(halfPoints: number): number {
  return halfPointsToPixels(halfPoints);
}

/** Px → half-points. @public */
export function pxToHalfPt(px: number): number {
  return pxToPt(px) * 2;
}
