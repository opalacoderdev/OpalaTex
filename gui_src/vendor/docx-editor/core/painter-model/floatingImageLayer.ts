import {
  applyImageRevisionAttrs,
  applyImageVisualAttrs,
  hasImageVisualAttrs,
  type ImageRevisionAttrs,
} from './renderImage';
import { sanitizeImageSrc } from '../utils/sanitizeImageSrc';

/**
 * Minimum fields the floating-image painter needs. Page-level and cell-level
 * float records both satisfy this shape.
 */
export interface FloatingImagePaintRecord extends ImageRevisionAttrs {
  src: string;
  width: number;
  height: number;
  alt?: string;
  transform?: string;
  x: number;
  y: number;
  docFrom?: number;
  docTo?: number;
  /** wp:srcRect crop fractions in [0, 1]. */
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
  /** a:alphaModFix -> CSS opacity. */
  opacity?: number;
}

export interface FloatingImagesLayerOptions {
  layerClass: string;
  itemClass: string;
  /**
   * `inset0` sizes the layer with `top/right/bottom/left = 0` (used at page level).
   * `fullSize` uses `width/height = 100%` and adds `overflow: hidden` (used inside table cells).
   */
  sizing: 'inset0' | 'fullSize';
  /** `behind` skips z-index so DOM order keeps the layer below body fragments. */
  layerMode: 'front' | 'behind';
}

/**
 * Render a layer of positioned floating images. Used at both page level and
 * inside table cells; the variant differs only in class names and sizing.
 */
export function paintFloatingImagesLayer(
  floatingImages: FloatingImagePaintRecord[],
  doc: Document,
  config: FloatingImagesLayerOptions
): HTMLElement {
  const layer = doc.createElement('div');
  layer.className = config.layerClass;
  layer.style.position = 'absolute';
  layer.style.top = '0';
  layer.style.left = '0';
  if (config.sizing === 'inset0') {
    layer.style.right = '0';
    layer.style.bottom = '0';
  } else {
    layer.style.width = '100%';
    layer.style.height = '100%';
    layer.style.overflow = 'hidden';
  }
  layer.style.pointerEvents = 'none';
  if (config.layerMode === 'front') {
    layer.style.zIndex = '10';
  }

  for (const floatImg of floatingImages) {
    const container = doc.createElement('div');
    container.className = config.itemClass;
    container.style.position = 'absolute';
    container.style.pointerEvents = 'auto';
    container.style.top = `${floatImg.y}px`;
    container.style.left = `${floatImg.x}px`;
    if (floatImg.docFrom !== undefined) container.dataset.docFrom = String(floatImg.docFrom);
    if (floatImg.docTo !== undefined) container.dataset.docTo = String(floatImg.docTo);
    applyImageRevisionAttrs(container, floatImg);

    const img = doc.createElement('img');
    const imageSrc = sanitizeImageSrc(floatImg.src);
    if (imageSrc) img.src = imageSrc;
    img.style.width = `${floatImg.width}px`;
    img.style.height = `${floatImg.height}px`;
    img.style.display = 'block';
    // A floating image is sized explicitly from its OOXML extent and may be
    // anchored so it bleeds into the page margin (e.g. a logo flush to the
    // right edge). Opt out of the global `img { max-width: 100% }` reset, which
    // would otherwise cap the width to the remaining content area and squash
    // the image against its fixed height.
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    if (floatImg.alt) img.alt = floatImg.alt;
    if (floatImg.transform) {
      img.style.transform = floatImg.transform;
      img.style.transformOrigin = 'center center';
    }
    if (hasImageVisualAttrs(floatImg)) applyImageVisualAttrs(img, floatImg);
    applyImageRevisionAttrs(img, floatImg);

    container.appendChild(img);
    layer.appendChild(container);
  }

  return layer;
}
