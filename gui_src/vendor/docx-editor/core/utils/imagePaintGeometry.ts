import type { ImageRun } from '../pagination-model/types';

export interface ImagePaintGeometry {
  scale: number;
  contentWidth: number;
  contentHeight: number;
  boxWidth: number;
  boxHeight: number;
  marginTop: number;
  marginBottom: number;
}

/**
 * Parse the rotation angle (in degrees, normalized to [0, 360)) from a
 * `transform` string like `"rotate(90deg) scaleX(-1)"`. Returns 0 when no
 * `rotate()` term is present.
 */
export function rotationDegrees(transform: string | undefined): number {
  if (!transform) return 0;
  const match = transform.match(/rotate\(([-\d.]+)deg\)/);
  if (!match) return 0;
  return ((Number.parseFloat(match[1]!) % 360) + 360) % 360;
}

/**
 * Axis-aligned bounding box of a rectangle of size `width × height` rotated by
 * `degrees`. Multiples of 90° avoid floating-point drift by swapping axes.
 */
export function rotatedBoundingBox(
  width: number,
  height: number,
  degrees: number
): { width: number; height: number } {
  if (degrees === 0 || degrees === 180) return { width, height };
  if (degrees === 90 || degrees === 270) return { width: height, height: width };
  const radians = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };
}

/**
 * Shared geometry for image rendering, line measurement, and tracked-change
 * span reporting. `paintedWidth` is the laid-out inline advance from
 * measurement; when omitted, the run paints at its declared width.
 */
export function getImagePaintGeometry(
  run: ImageRun,
  options: {
    paintedWidth?: number;
    defaultMargin?: number;
  } = {}
): ImagePaintGeometry {
  const paintedWidth = Math.max(0, options.paintedWidth ?? run.width);
  const scale = run.width > 0 ? Math.min(1, paintedWidth / run.width) : 1;
  const contentWidth = Math.max(0, run.width * scale);
  const contentHeight = Math.max(0, run.height * scale);
  const box = rotatedBoundingBox(contentWidth, contentHeight, rotationDegrees(run.transform));
  const defaultMargin = options.defaultMargin ?? 0;
  return {
    scale,
    contentWidth,
    contentHeight,
    boxWidth: box.width,
    boxHeight: box.height,
    marginTop: run.distTop ?? defaultMargin,
    marginBottom: run.distBottom ?? defaultMargin,
  };
}
