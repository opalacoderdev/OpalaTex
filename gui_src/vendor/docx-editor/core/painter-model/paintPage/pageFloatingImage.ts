import type { FloatingImagePaintRecord } from '../floatingImageLayer';

/** Page-positioned image extracted from a paragraph run. */
export interface PageFloatingImage extends FloatingImagePaintRecord {
  side: 'left' | 'right';
  distTop: number;
  distBottom: number;
  distLeft: number;
  distRight: number;
  wrapText?: 'bothSides' | 'left' | 'right' | 'largest';
  wrapType?: string;
}
