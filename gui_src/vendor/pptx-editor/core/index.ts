/**
 * @pptx-editor/core - Public API
 */
export type {
  FillStyle,
  GradientFill,
  GradientStop,
  GroupElement,
  LineStyle,
  NoFill,
  Paragraph,
  ParagraphChild,
  ParagraphProperties,
  PictureElement,
  Presentation,
  PresentationSize,
  RgbColor,
  ShapeElement,
  Slide,
  SlideBackground,
  SlideElement,
  SlideRelationship,
  SolidFill,
  TableCell,
  TableElement,
  TableRow,
  TextBody,
  TextRun,
  TextRunProperties,
  Transform,
} from './types';

export { parsePptx } from './parser';
export { serializePptx, createBlankSlide } from './serializer';
