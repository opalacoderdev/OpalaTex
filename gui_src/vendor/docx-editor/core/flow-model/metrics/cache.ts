/**
 * Measurement memos.
 *
 * Three content-addressed maps: glyph widths, font metrics, and whole-paragraph
 * layouts. Each is keyed by a structural digest of *exactly* the inputs that
 * change the result, which is the only correctness requirement here — a key
 * that omits an input serves one paragraph's measurement to another, and the
 * page silently paginates against the wrong heights.
 *
 * There is deliberately **no LRU**. Recency bookkeeping costs a write on every
 * read, and buys nothing: measurement keys are stable across a document's life,
 * so a "cold" entry is almost always one you're about to need again. When a map
 * outgrows its cap we drop it whole and let it refill. That's a rare, bounded
 * cost, and reclamation stays O(1).
 *
 * @packageDocumentation
 * @public
 */

import type { FontMetrics } from './textMetrics';
import type { ParagraphBlock, ParagraphMetrics, Run } from '../../pagination-model/types';

/**
 * Entry caps. Generous — a 200-page document metrics a few thousand distinct
 * paragraphs and a few dozen fonts — but bounded, so a pathological document
 * can't grow a map without limit.
 */
const DEFAULT_TEXT_CACHE_LIMIT = 20_000;
const DEFAULT_FONT_CACHE_LIMIT = 500;
const DEFAULT_PARAGRAPH_CACHE_LIMIT = 5_000;

/**
 * A capped map that reclaims by dropping everything rather than by tracking
 * recency. See the module note.
 */
class MemoMap<V> {
  private entries = new Map<string, V>();

  constructor(private limit: number) {}

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.limit) this.entries.clear();
    this.entries.set(key, value);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Current number of memoised entries. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Re-cap. Shrinking below the current fill drops the contents — the
   * alternative is choosing victims, which is the bookkeeping we're avoiding.
   */
  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    if (this.entries.size > this.limit) this.entries.clear();
  }
}

const textWidths = new MemoMap<number>(DEFAULT_TEXT_CACHE_LIMIT);
const fontMetrics = new MemoMap<FontMetrics>(DEFAULT_FONT_CACHE_LIMIT);
const paragraphMetrics = new MemoMap<ParagraphMetrics>(DEFAULT_PARAGRAPH_CACHE_LIMIT);

// ---------------------------------------------------------------------------
// Text widths — keyed by `<css font shorthand> <text>`
// ---------------------------------------------------------------------------

/** @public */
export function getCachedTextWidth(key: string): number | undefined {
  return textWidths.get(key);
}

/** @public */
export function setCachedTextWidth(key: string, width: number): void {
  textWidths.set(key, width);
}

/** @public */
export function clearTextWidthCache(): void {
  textWidths.clear();
}

/**
 * Set the width cache's capacity in entries.
 *
 * @public
 */
export function setTextCacheSize(limit: number): void {
  textWidths.setLimit(limit);
}

/**
 * How many widths are currently memoised (the fill, not the capacity).
 *
 * @public
 */
export function getTextCacheSize(): number {
  return textWidths.size;
}

// ---------------------------------------------------------------------------
// Font metrics — keyed by the CSS font shorthand
// ---------------------------------------------------------------------------

/** @public */
export function getCachedFontMetrics(key: string): FontMetrics | undefined {
  return fontMetrics.get(key);
}

/** @public */
export function setCachedFontMetrics(key: string, metrics: FontMetrics): void {
  fontMetrics.set(key, metrics);
}

/** @public */
export function resetFontMetrics(): void {
  fontMetrics.clear();
}

/**
 * Set the font-metrics cache's capacity in entries.
 *
 * @public
 */
export function setFontCacheSize(limit: number): void {
  fontMetrics.setLimit(limit);
}

/**
 * How many font metrics are currently memoised.
 *
 * @public
 */
export function getFontCacheSize(): number {
  return fontMetrics.size;
}

// ---------------------------------------------------------------------------
// Paragraph layouts
// ---------------------------------------------------------------------------

/**
 * The structural digest of a paragraph measurement.
 *
 * Everything that changes the resulting line boxes goes in, and nothing else:
 *
 *  - the **available width** it was broken against;
 *  - every **run's text and font-affecting formatting** (a bold run is wider
 *    than the same characters unbolded);
 *  - the **paragraph attrs that move text**: spacing, indents, tabs, alignment,
 *    and the list marker (which eats width on the first line);
 *  - the **document default font**, because an empty paragraph — and any run
 *    that didn't name a face — metrics against it. Two blank paragraphs with
 *    identical (empty) content but different document defaults are *different*
 *    measurements, and a key that ignored the default would serve one of them
 *    the other's height. That case has no other guard, so it is the one this
 *    key exists for;
 *  - the **float zones** narrowing the line band, and the paragraph's Y within
 *    them — the same paragraph wraps differently beside an image than below it.
 *    Pass them as `floatKey`; a caller that measures with floats and omits it is
 *    asking to be served the un-floated layout.
 *
 * Deliberately absent: `id`, `paraId`, doc positions, and tracked-change
 * authorship. None of them move a glyph, and folding them in would miss the
 * cache on every keystroke elsewhere in the document — which would make the memo
 * worse than useless.
 *
 * @public
 */
export function paragraphCacheKey(
  block: ParagraphBlock,
  availableWidth: number,
  floatKey?: string
): string {
  const a = block.attrs;
  const parts: string[] = [
    `w:${round(availableWidth)}`,
    // The default font is load-bearing for empty paragraphs — see above.
    `df:${a?.defaultFontFamily ?? ''}/${a?.defaultFontSize ?? ''}`,
    `al:${a?.alignment ?? ''}`,
    `sp:${a?.spacing?.before ?? ''}/${a?.spacing?.after ?? ''}/${a?.spacing?.line ?? ''}/${a?.spacing?.lineUnit ?? ''}/${a?.spacing?.lineRule ?? ''}`,
    `in:${a?.indent?.left ?? ''}/${a?.indent?.right ?? ''}/${a?.indent?.firstLine ?? ''}/${a?.indent?.hanging ?? ''}`,
    `tb:${(a?.tabs ?? []).map((t) => `${t.val}@${t.pos}`).join(',')}/${a?.defaultTabMarkTwips ?? ''}`,
    `lm:${a?.listMarker ?? ''}/${a?.listMarkerHidden ? 1 : 0}/${a?.listMarkerSuffix ?? ''}/${a?.listMarkerFontFamily ?? ''}/${a?.listMarkerFontSize ?? ''}`,
    `se:${a?.suppressEmptyParagraphHeight ? 1 : 0}`,
    `rs:${block.runs.map(runKey).join('|')}`,
  ];
  if (floatKey) parts.push(`fz:${floatKey}`);
  return parts.join(';');
}

/**
 * A digest of the float context a paragraph was measured in.
 *
 * The same paragraph beside an image and below it are different layouts, so they
 * are different cache entries. Callers that measure with floats MUST thread this
 * through, or the memo will hand one of them the other's line boxes.
 *
 * @public
 */
export function floatZoneKey(
  zones: ReadonlyArray<{ leftMargin: number; rightMargin: number; topY: number; bottomY: number }>,
  paragraphYOffset: number
): string {
  if (zones.length === 0) return '';
  const parts = zones.map((z) => `${z.leftMargin},${z.rightMargin},${z.topY},${z.bottomY}`);
  return `${Math.round(paragraphYOffset)}|${parts.join('|')}`;
}

function runKey(run: Run): string {
  switch (run.kind) {
    case 'text':
      return `t:${run.text}:${fontKey(run)}`;
    case 'tab':
      return `b:${fontKey(run)}`;
    case 'field':
      // The field's painted result is its fallback until we evaluate it; PAGE
      // and NUMPAGES resolve per page, but their width is measured off the
      // fallback, so the type is enough to distinguish them.
      return `f:${run.fieldType}:${run.fallback}:${fontKey(run)}`;
    case 'lineBreak':
      return 'n';
    case 'image':
      return [
        'i',
        run.src,
        `${round(run.width)}x${round(run.height)}`,
        run.displayMode ?? '',
        run.wrapType ?? '',
        run.transform ?? '',
        round(run.distTop ?? 0),
        round(run.distBottom ?? 0),
      ].join(':');
  }
}

/** Only the formatting that changes a glyph's advance. */
function fontKey(run: {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  letterSpacing?: number;
  horizontalScale?: number;
  allCaps?: boolean;
  smallCaps?: boolean;
}): string {
  return [
    run.fontFamily ?? '',
    run.fontSize ?? '',
    run.bold ? 'b' : '',
    run.italic ? 'i' : '',
    run.letterSpacing ?? '',
    run.horizontalScale ?? '',
    run.allCaps ? 'A' : '',
    run.smallCaps ? 's' : '',
  ].join(',');
}

/** Fractional widths would make the key miss on sub-pixel noise. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The memoised layout of `block` at `availableWidth`, if we have one.
 *
 * Takes the block rather than a key so the digest is computed in exactly one
 * place — a caller that built its own key could omit an input, and the bug that
 * causes (one paragraph served another's line boxes) is invisible until a page
 * paginates wrong.
 *
 * @public
 */
export function getCachedParagraphMetrics(
  block: ParagraphBlock,
  availableWidth: number,
  floatKey?: string
): ParagraphMetrics | undefined {
  return paragraphMetrics.get(paragraphCacheKey(block, availableWidth, floatKey));
}

/** @public */
export function setCachedParagraphMetrics(
  block: ParagraphBlock,
  availableWidth: number,
  measure: ParagraphMetrics,
  floatKey?: string
): void {
  paragraphMetrics.set(paragraphCacheKey(block, availableWidth, floatKey), measure);
}

/** @public */
export function clearParagraphMetricsCache(): void {
  paragraphMetrics.clear();
}

/**
 * Set the paragraph cache's capacity in entries.
 *
 * @public
 */
export function setParagraphCacheSize(limit: number): void {
  paragraphMetrics.setLimit(limit);
}

/**
 * How many paragraph layouts are currently memoised.
 *
 * @public
 */
export function getParagraphCacheSize(): number {
  return paragraphMetrics.size;
}

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

/**
 * Drop every memo. Call this when the thing the memos were taken *against*
 * changes — a webfont finishing load, or a zoom that re-rasterises everything.
 *
 * @public
 */
export function clearAllCaches(): void {
  textWidths.clear();
  fontMetrics.clear();
  paragraphMetrics.clear();
}

/**
 * Total memoised entries across all three caches.
 *
 * @public
 */
export function getTotalCacheSize(): number {
  return textWidths.size + fontMetrics.size + paragraphMetrics.size;
}
