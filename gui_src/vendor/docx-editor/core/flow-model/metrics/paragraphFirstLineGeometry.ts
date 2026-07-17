export interface ParagraphFirstLineIndent {
  left?: number;
  right?: number;
  firstLine?: number;
  hanging?: number;
}

export interface ParagraphFirstLineGeometry {
  bodyWidth: number;
  firstLineOffset: number;
  markerStart: number;
  markerInlineWidth: number;
  textStart: number;
  textWidth: number;
  inlineWidth: number;
  painterLineWidth: number;
}

export function resolveParagraphMarkerStart(indent: ParagraphFirstLineIndent | undefined): number {
  const left = indent?.left ?? 0;
  const firstLine = indent?.firstLine ?? 0;
  const hanging = indent?.hanging ?? 0;
  const logicalMarkerStart = hanging > 0 ? left - hanging : left + firstLine;

  // With no left indent, the painter intentionally keeps the marker at x=0
  // and lets its hanging-width slot align text with continuation lines.
  return left === 0 && logicalMarkerStart < 0 ? 0 : logicalMarkerStart;
}

/**
 * Resolve the first-line inline geometry shared by measurement and painting.
 *
 * A rendered marker is part of the first-line inline box. For a hanging list,
 * that box begins at `left - hanging`, the marker occupies its inline slot,
 * and body text begins at the regular left indent. The measurer consumes only
 * `textWidth`; the painter uses `painterLineWidth` for its content-box line and
 * inserts the marker into that `inlineWidth` box.
 *
 * Without a marker, CSS `text-indent` realizes the first-line offset inside
 * the regular body box, so the painter keeps `bodyWidth` while measurement
 * uses the offset-adjusted text width.
 */
export function resolveParagraphFirstLineGeometry(
  containerWidth: number,
  indent: ParagraphFirstLineIndent | undefined,
  markerInlineWidth: number
): ParagraphFirstLineGeometry {
  const left = indent?.left ?? 0;
  const right = indent?.right ?? 0;
  const firstLine = indent?.firstLine ?? 0;
  const hanging = indent?.hanging ?? 0;
  const bodyWidth = Math.max(1, containerWidth - left - right);
  const firstLineOffset = firstLine - hanging;
  const resolvedMarkerWidth = Math.max(0, markerInlineWidth);

  if (resolvedMarkerWidth === 0) {
    return {
      bodyWidth,
      firstLineOffset,
      markerStart: left + firstLineOffset,
      markerInlineWidth: 0,
      textStart: left + firstLineOffset,
      textWidth: Math.max(1, bodyWidth - firstLineOffset),
      inlineWidth: Math.max(1, containerWidth - right - (left + firstLineOffset)),
      painterLineWidth: bodyWidth,
    };
  }

  const markerStart = resolveParagraphMarkerStart(indent);
  const domLineStart = Math.max(0, markerStart);
  const textStart = markerStart + resolvedMarkerWidth;
  const rightEdge = containerWidth - right;

  return {
    bodyWidth,
    firstLineOffset,
    markerStart,
    markerInlineWidth: resolvedMarkerWidth,
    textStart,
    textWidth: Math.max(1, rightEdge - textStart),
    inlineWidth: Math.max(1, rightEdge - domLineStart),
    painterLineWidth: Math.max(1, rightEdge - domLineStart),
  };
}
