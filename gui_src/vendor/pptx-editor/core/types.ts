/**
 * PPTX Editor Core Types
 *
 * All coordinate values are in EMU (English Metric Units).
 * 1 inch = 914400 EMU, 1 pt = 12700 EMU, 1 cm = 360000 EMU.
 */

// ── Color Types ──────────────────────────────────────────────────────────────

/** An RGB hex color string without the '#', e.g. "FF0000". */
export type RgbColor = string;

export interface SolidFill {
  type: 'solid';
  color: RgbColor;
  alpha?: number; // 0–100000 (OOXML percentage)
}

export interface GradientStop {
  position: number; // 0–100000
  color: RgbColor;
  alpha?: number;
}

export interface GradientFill {
  type: 'gradient';
  stops: GradientStop[];
  angle?: number; // rotation in 60000ths of a degree
}

export interface NoFill {
  type: 'none';
}

export type FillStyle = SolidFill | GradientFill | NoFill;

// ── Line / Border ────────────────────────────────────────────────────────────

export interface LineStyle {
  width: number; // EMU
  fill?: FillStyle;
  dashStyle?: string; // 'solid' | 'dash' | 'dot' | 'dashDot' | etc.
}

// ── Transform ────────────────────────────────────────────────────────────────

export interface Transform {
  x: number;      // offset left (EMU)
  y: number;      // offset top (EMU)
  width: number;  // extent cx (EMU)
  height: number; // extent cy (EMU)
  rotation?: number; // rotation in 60000ths of a degree
  flipH?: boolean;
  flipV?: boolean;
}

// ── Text ─────────────────────────────────────────────────────────────────────

export interface TextRunProperties {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;    // in hundredths of a point (e.g. 1800 = 18pt)
  fontFamily?: string;
  color?: RgbColor;
  highlight?: RgbColor;
}

export interface TextRun {
  text: string;
  properties?: TextRunProperties;
}

export interface LineBreak {
  type: 'break';
}

export type ParagraphChild = TextRun | LineBreak;

export interface ParagraphProperties {
  alignment?: 'left' | 'center' | 'right' | 'justify';
  level?: number;       // indentation level (0-based)
  marginLeft?: number;  // paragraph left margin in EMU
  indent?: number;      // first-line indent in EMU
  lineSpacing?: number; // spacing in hundredths of a point or percentage
  spaceBefore?: number; // EMU
  spaceAfter?: number;  // EMU
  bulletChar?: string;  // bullet character if bulleted list
  bulletAutoNum?: string; // auto-numbered list type
}

export interface Paragraph {
  children: ParagraphChild[];
  properties?: ParagraphProperties;
}

export interface TextBody {
  paragraphs: Paragraph[];
  /** Text body properties like vertical alignment, word-wrap, etc. */
  bodyProperties?: {
    anchor?: 'top' | 'middle' | 'bottom';
    wrap?: 'square' | 'none';
    lIns?: number; // left inset (EMU)
    tIns?: number; // top inset
    rIns?: number; // right inset
    bIns?: number; // bottom inset
  };
}

// ── Slide Elements ───────────────────────────────────────────────────────────

export interface ShapeElement {
  type: 'shape';
  id: string;
  name: string;
  transform: Transform;
  geometry: string;     // preset geometry name: 'rect', 'ellipse', 'roundRect', etc.
  fill?: FillStyle;
  line?: LineStyle;
  textBody?: TextBody;
  /** Whether this shape is a placeholder (title, body, etc.) */
  placeholderType?: string;
  placeholderIdx?: number;
}

export interface PictureElement {
  type: 'picture';
  id: string;
  name: string;
  transform: Transform;
  /** Relationship ID pointing to the image file inside the PPTX archive. */
  rId: string;
  /** The resolved path within the ZIP, e.g. "ppt/media/image1.png". */
  mediaPath?: string;
  /** Base64 data URI for rendering. Populated by the parser. */
  dataUri?: string;
  line?: LineStyle;
}

export interface GroupElement {
  type: 'group';
  id: string;
  name: string;
  transform: Transform;
  /** Group-level child transform mapping (childOffset / childExtents). */
  childTransform?: Transform;
  children: SlideElement[];
}

export interface TableCell {
  textBody?: TextBody;
  fill?: FillStyle;
  rowSpan?: number;
  colSpan?: number;
}

export interface TableRow {
  height: number; // EMU
  cells: TableCell[];
}

export interface TableElement {
  type: 'table';
  id: string;
  name: string;
  transform: Transform;
  columns: number[];  // column widths in EMU
  rows: TableRow[];
}

export type SlideElement = ShapeElement | PictureElement | GroupElement | TableElement;

// ── Slide ────────────────────────────────────────────────────────────────────

export interface SlideBackground {
  fill?: FillStyle;
}

export interface Slide {
  /** 1-based slide number. */
  number: number;
  /** Internal XML path, e.g. "ppt/slides/slide1.xml". */
  xmlPath: string;
  /** Relationship file path, e.g. "ppt/slides/_rels/slide1.xml.rels". */
  relsPath: string;
  /** Layout relationship ID. */
  layoutRId?: string;
  elements: SlideElement[];
  background?: SlideBackground;
  /** Speaker notes text (plain text extraction). */
  notes?: string;
  /** Preserved raw XML string for lossless round-tripping of unmodified slides. */
  rawXml?: string;
}

// ── Presentation ─────────────────────────────────────────────────────────────

export interface PresentationSize {
  width: number;  // EMU (default 4:3 = 9144000)
  height: number; // EMU (default 4:3 = 6858000)
}

export interface SlideRelationship {
  rId: string;
  target: string; // e.g. "slides/slide1.xml"
}

export interface Presentation {
  /** Slide dimensions. */
  size: PresentationSize;
  /** Ordered list of parsed slides. */
  slides: Slide[];
  /** Map of image paths to base64 data URIs for rendering. */
  mediaCache: Record<string, string>;
  /**
   * The full JSZip instance, kept alive so that unmodified entries
   * (layouts, masters, themes, media) can be carried through
   * to serialization without data loss.
   */
  zipInstance?: unknown;
}
