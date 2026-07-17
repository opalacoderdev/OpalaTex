/**
 * Text Measurement Module
 *
 * Provides text measurement utilities for the layout engine.
 * Uses Canvas API for accurate, cached measurements.
 * @packageDocumentation
 * @public
 */

// Core measurement functions
export {
  getCanvasContext,
  resetCanvasContext,
  toCssFont,
  fontMetricsFor,
  measureTextWidth,
  measureText,
  measureRun,
  charIndexAtX,
  getXForCharacter,
  // Unit conversions
  twipsToPx,
  pxToTwips,
  ptToPx,
  pxToPt,
  halfPtToPx,
  pxToHalfPt,
  // Types
  type FontStyle,
  type FontMetrics,
  type TextMeasurement,
  type RunMeasurement,
} from './textMetrics';

// Paragraph measurement
export {
  paragraphLayout,
  paragraphLayouts,
  getRunCharWidths,
  constrainWrapMargins,
  type FloatingImageZone,
  type ParagraphLayoutOptions,
} from './paragraphLayout';
export {
  rectsToFloatingZones,
  getFloatingMargins,
  type FloatingExclusionRect,
  type FloatingLineSegmentZone,
} from './floatingZones';

export {
  measureBlocksWithFloats,
  type MeasureBlockFn,
  type FloatPageGeometry,
} from './measureBlocksPipeline';

// Caching utilities
export {
  // Text width cache
  getCachedTextWidth,
  setCachedTextWidth,
  clearTextWidthCache,
  setTextCacheSize,
  getTextCacheSize,
  // Font metrics cache
  getCachedFontMetrics,
  setCachedFontMetrics,
  resetFontMetrics,
  setFontCacheSize,
  getFontCacheSize,
  // Paragraph measure cache
  paragraphCacheKey,
  floatZoneKey,
  getCachedParagraphMetrics,
  setCachedParagraphMetrics,
  clearParagraphMetricsCache,
  setParagraphCacheSize,
  getParagraphCacheSize,
  // Global cache management
  clearAllCaches,
  getTotalCacheSize,
} from './cache';

export {
  resolveParagraphFirstLineGeometry,
  resolveParagraphMarkerStart,
} from './paragraphFirstLineGeometry';
