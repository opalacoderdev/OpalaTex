/**
 * The pagination model — the engine's public data contract.
 *
 * Content nodes describe the document, layout metrics measure each node, and
 * fragments describe where each measured node lands on a page.
 *
 * The discriminant on all three, and on runs, is `kind` — never `type`.
 *
 * Lengths are CSS pixels at 96 dpi unless the field name says otherwise
 * (`...Twips`, `...Emu`, and `TabMark.pos`). See `utils/units.ts`.
 *
 * @packageDocumentation
 * @public
 */

import type { CellMarker, RevisionInfo } from '../types/content/trackedChange';
import type { InlineSdtWidget } from './inlineSdtWidgets';
import type { FootnoteFragment } from './footnoteTypes';
import type { TrackedChangeMetadata } from './trackedChangeMetadata';
export type { FootnoteNodeFragment, FootnoteFragment } from './footnoteTypes';
export type { TrackedChangeMetadata } from './trackedChangeMetadata';

// ============================================================================
// Shared scalars
// ============================================================================

/**
 * Identity of a content node, stable for one layout pass. `buildBoxTree` mints
 * strings; synthetic nodes and test fixtures also use numbers. Compare as
 * `String(id)`.
 *
 * @public
 */
export type NodeId = string | number;

/**
 * Page or content-box dimensions, px.
 *
 * @public
 */
export interface Size {
  w: number;
  h: number;
}

/**
 * Page margins, px. `top`/`bottom` position the *body*; the header and footer
 * live inside them at `header`/`footer` distance from the page edge, and only
 * push the body inward when their band outgrows the margin.
 *
 * @public
 */
export interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** `w:header` distance from the page top, px. Word's default is 48 (0.5in). */
  header?: number;
  /** `w:footer` distance from the page bottom, px. */
  footer?: number;
}

/**
 * Multi-column geometry for a section (`w:cols`, §17.6.4).
 *
 * @public
 */
export interface ColumnLayout {
  /** `w:num`. */
  count: number;
  /** `w:space` — gutter between columns, px. */
  gap: number;
  /** `w:equalWidth`. */
  equalWidth?: boolean;
  /** `w:sep` — draw a rule between columns. */
  separator?: boolean;
  /** Explicit per-column widths, px, when `equalWidth` is false. */
  widths?: number[];
}

/**
 * How a section begins (`w:type` / `ST_SectionMark`, §17.6.22).
 *
 * @public
 */
export type SectionStartType = 'continuous' | 'nextPage' | 'evenPage' | 'oddPage' | 'nextColumn';

/**
 * Which sides text may flow down beside a floating object
 * (`wp:wrapSquare/@wrapText`).
 *
 * @public
 */
export type WrapTextDirection = 'bothSides' | 'left' | 'right' | 'largest';

/**
 * A tab stop on a paragraph (`w:tab`, §17.3.1.37).
 *
 * `pos` is in **twips** — the one twip-valued field on a block, kept in the
 * authored unit because the default tab grid is defined against it.
 *
 * @public
 */
export interface TabMark {
  /** `ST_TabJc` (§17.18.84), normalized to start/end rather than left/right. */
  val: 'start' | 'end' | 'center' | 'decimal' | 'bar' | 'clear';
  /** Distance from the content-box left edge, in twips. */
  pos: number;
  /** `w:leader` — the glyph repeated across the tab's advance. */
  leader?: 'none' | 'dot' | 'hyphen' | 'underscore' | 'heavy' | 'middleDot';
}

/**
 * A resolved border edge, ready to paint. Colors are `#rrggbb`; widths px.
 * A `w:val` of `none`/`nil` resolves to `undefined` rather than a zero-width
 * edge, so a truthy test means "there is a border here".
 *
 * @public
 */
export interface BorderKind {
  style?: string;
  width?: number;
  color?: string;
  /** `w:space` — gap between the border and the content it surrounds, px. */
  space?: number;
  shadow?: boolean;
}

/**
 * Borders around a paragraph (`w:pBdr`) or a table cell (`w:tcBorders`).
 *
 * @public
 */
export interface ParagraphBorders {
  top?: BorderKind;
  bottom?: BorderKind;
  left?: BorderKind;
  right?: BorderKind;
  /** Drawn between adjacent paragraphs that share an identical border set. */
  between?: BorderKind;
  bar?: BorderKind;
}

/**
 * An enclosing block-level content control (`w:sdt`). A block carries its whole
 * ancestor chain, outermost first, so the painter can redraw nested boundaries.
 *
 * @public
 */
export interface SdtGroup {
  id: string;
  sdtType: string;
  tag?: string;
  alias?: string;
  lock?: string;
  checked?: boolean;
  /** Bound to custom XML (`w:dataBinding`) — the control is not free-text. */
  bound?: boolean;
  /** A `w15:repeatingSectionItem`. */
  repeatingItem?: boolean;
}

/**
 * One axis of a drawing anchor (`wp:positionH` / `wp:positionV`).
 *
 * Both `align` and `alignment` exist because the two parse paths spell it
 * differently; readers take `align ?? alignment`. `posOffset` is EMU, as authored.
 *
 * @public
 */
export interface AnchorAxis {
  relativeTo?: string;
  align?: string;
  alignment?: string;
  posOffset?: number;
}

/**
 * Where an anchored drawing sits.
 *
 * @public
 */
export interface ImageRunPosition {
  horizontal?: AnchorAxis;
  vertical?: AnchorAxis;
}

// ============================================================================
// Runs — a paragraph's inline content
// ============================================================================

/**
 * Character formatting, shared by every textual run kind (text, tab, field —
 * a tab's leader glyphs and a field's result both paint in the run's font).
 *
 * Already resolved: colors are `#rrggbb` (theme lookups done), sizes points.
 *
 * @public
 */
export interface RunFormatting extends TrackedChangeMetadata {
  bold?: boolean;
  italic?: boolean;
  /** `true` for a plain single underline; an object when style or color is set. */
  underline?: boolean | { style?: string; color?: string };
  strike?: boolean;
  /** Resolved `#rrggbb`. */
  color?: string;
  /** Resolved CSS color for `w:highlight`. */
  highlight?: string;
  /** Points — already halved from `w:sz`'s half-points. */
  fontSize?: number;
  fontFamily?: string;
  /** `w:spacing` letter-spacing, px. */
  letterSpacing?: number;
  /** `w:position` baseline shift, px; positive raises. */
  positionPx?: number;
  /** `w:w` horizontal scale, percent. */
  horizontalScale?: number;
  /** `w:kern` threshold, points. */
  kerningMinPt?: number;
  allCaps?: boolean;
  smallCaps?: boolean;
  emboss?: boolean;
  imprint?: boolean;
  textShadow?: boolean;
  textOutline?: boolean;
  hidden?: boolean;
  rtl?: boolean;
  textEffect?: 'blinkBackground' | 'lights' | 'antsBlack' | 'antsRed' | 'shimmer' | 'sparkle';
  emphasisMark?: 'dot' | 'comma' | 'circle' | 'underDot';
  superscript?: boolean;
  subscript?: boolean;
  hyperlink?: { href: string; tooltip?: string; noDefaultStyle?: boolean };
  footnoteRefId?: number;
  endnoteRefId?: number;
  commentIds?: number[];
}

/**
 * A half-open document-position range `[docFrom, docTo)` in the run's *owning*
 * ProseMirror document.
 *
 * The body and each header/footer are separate documents whose integers
 * collide, so a position is only meaningful together with its space — never
 * resolve one against the wrong subtree.
 *
 * @public
 */
export interface DocRange {
  docFrom?: number;
  docTo?: number;
}

/**
 * A span of text.
 *
 * @public
 */
export interface TextRun extends RunFormatting, DocRange {
  kind: 'text';
  text: string;
  /** Set when the run sits inside an inline content control painted as a widget. */
  inlineSdtWidget?: InlineSdtWidget;
}

/**
 * A tab character (`w:tab`).
 *
 * @public
 */
export interface TabRun extends RunFormatting, DocRange {
  kind: 'tab';
  /** Absolute-position tab metadata (`w:ptab`) when this tab is positional. */
  positional?: import('../types/document').TabContent['positional'];
}

/**
 * An explicit break inside a paragraph (`w:br`).
 *
 * @public
 */
export interface LineBreakRun extends DocRange {
  kind: 'lineBreak';
  /** `w:type` — a `page` break authored mid-paragraph forces a page break. */
  breakType?: 'page' | 'column' | 'textWrapping';
  /** `w:clear` — which floats the break must clear. */
  clear?: 'none' | 'left' | 'right' | 'all';
}

/**
 * A field whose result is computed at paint time. `fallback` is the cached
 * result Word wrote, used for every field type we don't evaluate ourselves.
 *
 * @public
 */
export interface FieldRun extends RunFormatting, DocRange {
  kind: 'field';
  fieldType: 'PAGE' | 'NUMPAGES' | 'DATE' | 'TIME' | 'OTHER';
  fallback: string;
}

/**
 * A picture in the inline stream. `width`/`height` are the *rendered* px extents
 * (already constrained to the page); the crop fractions are 0..1 of the source,
 * per `a:srcRect`; the `dist*` clearances are px.
 *
 * @public
 */
export interface ImageRun extends DocRange, TrackedChangeMetadata {
  kind: 'image';
  src: string;
  width: number;
  height: number;
  alt?: string;
  transform?: string;
  wrapType?: string;
  displayMode?: 'inline' | 'block' | 'float';
  cssFloat?: 'left' | 'right' | 'none';
  wrapText?: WrapTextDirection;
  distTop?: number;
  distBottom?: number;
  distLeft?: number;
  distRight?: number;
  position?: ImageRunPosition;
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
  opacity?: number;
  hlinkHref?: string;
}

/**
 * Any inline run.
 *
 * @public
 */
export type Run = TextRun | TabRun | LineBreakRun | FieldRun | ImageRun;

// ============================================================================
// Content nodes — the document, geometry-free
// ============================================================================

/**
 * Paragraph properties (`w:pPr`), resolved through the style cascade.
 *
 * @public
 */
export interface ParagraphAttrs {
  alignment?: 'left' | 'center' | 'right' | 'justify';
  spacing?: {
    /** px */
    before?: number;
    /** px */
    after?: number;
    /**
     * `w:line`. Unit depends on `lineUnit`: a multiplier of the single-line
     * height when the rule is `auto` (Word authors 240ths of a line; the bridge
     * has already divided), or px when `exact`/`atLeast`.
     */
    line?: number;
    lineUnit?: 'multiplier' | 'px';
    /** `w:lineRule` (§17.18.48). */
    lineRule?: 'auto' | 'exact' | 'atLeast';
  };
  /** Which spacing sides the document authored, rather than inheriting. */
  spacingOverrides?: { before?: boolean; after?: boolean };
  /** All px. `firstLine` and `hanging` are mutually exclusive. */
  indent?: {
    left?: number;
    right?: number;
    firstLine?: number;
    hanging?: number;
  };
  styleId?: string;
  borders?: ParagraphBorders;
  /** Resolved `#rrggbb` fill. */
  shading?: string;
  tabs?: TabMark[];
  /** Doc-level `w:defaultTabStop`, twips (Word's default is 720). */
  defaultTabMarkTwips?: number;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  widowControl?: boolean;
  contextualSpacing?: boolean;
  bidi?: boolean;
  numPr?: { numId?: number; ilvl?: number };
  /** The *rendered* marker, e.g. `"1."` or `"•"` — already resolved from `w:lvlText`. */
  listMarker?: string;
  listIsBullet?: boolean;
  listMarkerHidden?: boolean;
  listMarkerFontFamily?: string;
  listMarkerFontSize?: number;
  /** `w:suff` (§17.9.25) — what separates the marker from the body text. */
  listMarkerSuffix?: 'tab' | 'space' | 'nothing';
  listMarkerRevision?: 'ins' | 'del';
  /** Font used to measure an *empty* paragraph, from the style's `rPr`. */
  defaultFontSize?: number;
  defaultFontFamily?: string;
  /**
   * Measure this paragraph at zero height. Set by the header/footer normalizer
   * for structural trailing empties that Word doesn't render.
   */
  suppressEmptyParagraphHeight?: boolean;
  /** Paragraph-mark tracked changes (`w:rPr/w:ins`, `w:rPr/w:del`). */
  pPrIns?: RevisionInfo;
  pPrDel?: RevisionInfo;
}

/**
 * Fields every content node carries.
 *
 * @public
 */
export interface ContentNodeBase extends DocRange {
  id: NodeId;
  /** Enclosing block-level content controls, outermost first. */
  sdtGroups?: SdtGroup[];
}

/**
 * A paragraph and its inline runs.
 *
 * @public
 */
export interface ParagraphBlock extends ContentNodeBase {
  kind: 'paragraph';
  runs: Run[];
  attrs?: ParagraphAttrs;
  /** `w14:paraId` — Word's stable paragraph identity; comment anchors use it. */
  paraId?: string;
}

/**
 * One table cell. `nodes` recurses, so nested tables need no special case.
 *
 * @public
 */
export interface TableCell {
  id: NodeId;
  nodes: ContentNode[];
  colSpan?: number;
  rowSpan?: number;
  /** Resolved px width, when the cell authored one. */
  width?: number;
  /** The raw `w:tcW` pair, kept for the grid resolver. */
  widthValue?: number;
  widthType?: string;
  verticalAlign?: 'top' | 'center' | 'bottom';
  /** Resolved `#rrggbb` fill. */
  background?: string;
  borders?: ParagraphBorders;
  /** Resolved `w:tcMar`, px, after the table-level cascade. */
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  noWrap?: boolean;
  trackedMarker?: CellMarker;
}

/**
 * One table row.
 *
 * @public
 */
export interface TableRow {
  id: NodeId;
  cells: TableCell[];
  /** `w:trHeight`, px. */
  height?: number;
  heightRule?: 'auto' | 'atLeast' | 'exact';
  /** `w:tblHeader` (§17.4.49) — repeat this row atop every page fragment. */
  isHeader?: boolean;
  /** `w:cantSplit` (§17.4.6) — never break this row across pages. */
  cantSplit?: boolean;
  trackedIns?: RevisionInfo;
  trackedDel?: RevisionInfo;
}

/**
 * A positioned table's anchor (`w:tblpPr`). Offsets px.
 *
 * @public
 */
export interface TableFloatingAnchor {
  horzAnchor?: 'margin' | 'page' | 'text';
  vertAnchor?: 'margin' | 'page' | 'text';
  tblpX?: number;
  tblpXSpec?: 'left' | 'center' | 'right' | 'inside' | 'outside';
  tblpY?: number;
  tblpYSpec?: 'top' | 'center' | 'bottom' | 'inside' | 'outside' | 'inline';
  topFromText?: number;
  bottomFromText?: number;
  leftFromText?: number;
  rightFromText?: number;
}

/**
 * A table. `width`/`widthType` are the RAW `w:tblW` pair (twips, or 50ths of a
 * percent) — resolve them through `resolveTableWidthPx`, never read as px.
 *
 * @public
 */
export interface TableBlock extends ContentNodeBase {
  kind: 'table';
  rows: TableRow[];
  /** Resolved px column widths; absent when the grid must be inferred. */
  columnWidths?: number[];
  width?: number;
  widthType?: string;
  justification?: 'left' | 'center' | 'right';
  bidi?: boolean;
  /** `w:tblInd`, px. */
  indent?: number;
  /**
   * Set when the table is positioned. `demoteBlockLikeFloatingTables` clears it
   * for full-width floats, which Word paginates like ordinary block tables.
   */
  floating?: TableFloatingAnchor;
  borders?: ParagraphBorders;
  /** Resolved `#rrggbb` table-level fill. */
  background?: string;
}

/**
 * A block-level picture — a `w:drawing` that is a paragraph's whole content, or
 * an anchored `behind`/`inFront` image.
 *
 * @public
 */
export interface ImageBlock extends ContentNodeBase, TrackedChangeMetadata {
  kind: 'image';
  src: string;
  width: number;
  height: number;
  alt?: string;
  transform?: string;
  anchor?: {
    isAnchored: boolean;
    offsetH?: number;
    offsetV?: number;
    behindDoc?: boolean;
  };
  hlinkHref?: string;
}

/**
 * Default inner padding of a text box, px — the DrawingML `bodyPr` insets
 * (0.05in top/bottom, 0.1in left/right) rounded to whole px.
 *
 * @public
 */
export const DEFAULT_TEXTBOX_MARGINS: {
  top: number;
  right: number;
  bottom: number;
  left: number;
} = {
  top: 4,
  right: 7,
  bottom: 4,
  left: 7,
};

/**
 * Fallback text-box width, px, when the shape declares no extent.
 *
 * @public
 */
export const DEFAULT_TEXTBOX_WIDTH = 200;

/**
 * A text box (`w:txbxContent`). Its `content` is a self-contained block flow,
 * measured at the box's inner width.
 *
 * @public
 */
export interface TextBoxBlock extends ContentNodeBase {
  kind: 'textBox';
  width: number;
  /** Absent when the box auto-fits its content. */
  height?: number;
  content: ParagraphBlock[];
  margins?: { top: number; right: number; bottom: number; left: number };
  fillColor?: string;
  outlineWidth?: number;
  outlineColor?: string;
  outlineStyle?: string;
  displayMode?: 'inline' | 'block' | 'float';
  cssFloat?: 'left' | 'right' | 'none';
  wrapType?: string;
  wrapText?: WrapTextDirection;
  anchorTarget?: 'page' | 'margin' | 'column' | 'paragraph';
  position?: ImageRunPosition;
  distTop?: number;
  distBottom?: number;
  distLeft?: number;
  distRight?: number;
}

/**
 * A hard page break — a promoted `w:br w:type="page"`, or a horizontal rule.
 *
 * @public
 */
export interface PageBreakBlock extends ContentNodeBase {
  kind: 'pageBreak';
}

/**
 * A column break (`w:br w:type="column"`) — ends the column, not the page.
 *
 * @public
 */
export interface ColumnBreakBlock extends ContentNodeBase {
  kind: 'columnBreak';
}

export type { PageHeaderFooterRefs } from './headerFooterRefs';
export { selectHeaderFooterRefForPage } from './headerFooterRefs';
import type { PageHeaderFooterRefs } from './headerFooterRefs';

/**
 * The boundary between two sections (`w:sectPr`). Carries the geometry the
 * *following* content adopts; absent fields inherit from the previous section.
 *
 * @public
 */
export interface SectionMarkerBlock extends ContentNodeBase {
  kind: 'sectionBreak';
  type?: SectionStartType;
  pageSize?: Size;
  margins?: PageMargins;
  columns?: ColumnLayout;
  /** Effective header/footer refs for the section closed by this break. */
  headerFooterRefs?: PageHeaderFooterRefs;
}

/**
 * Every content-node kind the engine flows.
 *
 * Adding a variant means updating all three `ContentNode` switches — the
 * pagination fold and each adapter's `measureBlock` — each of which ends in
 * {@link assertExhaustiveContentNode}, so `bun run typecheck` names the sites you
 * missed instead of failing at runtime.
 *
 * @public
 */
export type ContentNode =
  | ParagraphBlock
  | TableBlock
  | ImageBlock
  | TextBoxBlock
  | PageBreakBlock
  | ColumnBreakBlock
  | SectionMarkerBlock;

/**
 * Compile-time exhaustiveness guard for a `ContentNode` switch, and a runtime
 * throw if an unhandled node somehow reaches it.
 *
 * Use it as the `default:` arm. A plain `default: throw` would keep compiling
 * after a new variant is added; this won't, because `node` only narrows to
 * `never` once every variant is handled.
 *
 * @param node - the value that should have been narrowed away
 * @param site - where the switch lives, for the error message
 * @public
 */
export function assertExhaustiveContentNode(node: never, site: string): never {
  const kind = (node as { kind?: unknown } | null)?.kind;
  throw new Error(`${site}: unhandled ContentNode kind ${String(kind)}`);
}

// ============================================================================
// Layout metrics — how tall, at a given width
// ============================================================================

/**
 * A slice of a line, when a float splits the line into two runnable segments
 * (text either side of a centred object).
 *
 * @public
 */
export interface LineSegment {
  fromRun: number;
  fromChar: number;
  toRun: number;
  toChar: number;
  width: number;
  availableWidth: number;
  leftOffset: number;
}

/**
 * One laid-out line of a paragraph.
 *
 * `[fromRun, fromChar]` → `[toRun, toChar]` addresses the line's content as a
 * half-open slice of the paragraph's `runs`, so a line may start and end
 * mid-run. That addressing is what lets pagination split a paragraph across a
 * page boundary without re-measuring it.
 *
 * @public
 */
export interface MeasuredLine {
  fromRun: number;
  fromChar: number;
  toRun: number;
  toChar: number;
  /** Painted width of the line's content, px. */
  width: number;
  ascent: number;
  descent: number;
  /** Height the line occupies, px — what pagination adds to the vertical pen. */
  lineHeight: number;
  /** Left inset: first-line indent, or a float pushing the line right. */
  leftOffset?: number;
  /** Right inset from a float. */
  rightOffset?: number;
  /** Px the line was pushed down to clear a full-width float band. */
  floatSkipBefore?: number;
  /** Present when a float split this line into runnable segments. */
  segments?: LineSegment[];
  /**
   * Painted advance, px, of runs on this line whose width cannot be recovered
   * from the run alone — keyed by run index.
   *
   * Two kinds need it. A **tab**'s advance depends on where the pen was when it
   * was reached, which only the line breaker knows. An **image** wider than its
   * column is painted scaled down, so its declared width is not its painted one.
   *
   * Without this, everything that walks a line to convert between an X and a
   * document position — the caret, the click hit-test, the selection rects — has
   * to guess, and guesses zero. Every position after a tab then resolves several
   * hundred pixels off, which is every table-of-contents entry, every hanging-
   * indent list body, and every right-tabbed header in the document.
   */
  atomAdvances?: Record<number, number>;
}

/**
 * A measured paragraph.
 *
 * `totalHeight` includes the paragraph's own spacing before/after — it is the
 * paragraph's full vertical footprint, which is what a table cell and the
 * float-zone pass want. Pagination ignores it and works from `lines`, adding
 * the collapsed inter-paragraph gap itself, so the two never double-count.
 *
 * @public
 */
export interface ParagraphMetrics {
  kind: 'paragraph';
  lines: MeasuredLine[];
  totalHeight: number;
}

/**
 * A measured table cell. `metrics` describes the cell's own content,
 * index-aligned with `TableCell.nodes`.
 *
 * @public
 */
export interface TableCellMetrics {
  metrics: LayoutMetrics[];
  width: number;
  /** Filled in by the row-height distribution pass. */
  height?: number;
  rowSpan?: number;
  colSpan?: number;
}

/**
 * A measured table row.
 *
 * @public
 */
export interface TableRowMetrics {
  height: number;
  cells: TableCellMetrics[];
}

/**
 * A measured table.
 *
 * @public
 */
export interface TableMetrics {
  kind: 'table';
  rows: TableRowMetrics[];
  columnWidths: number[];
  totalWidth: number;
  totalHeight: number;
}

/**
 * A measured block image.
 *
 * @public
 */
export interface ImageMetrics {
  kind: 'image';
  width: number;
  height: number;
}

/**
 * A measured text box. `innerMetrics` is index-aligned with
 * `TextBoxBlock.content`.
 *
 * @public
 */
export interface TextBoxMetrics {
  kind: 'textBox';
  width: number;
  height: number;
  innerMetrics: ParagraphMetrics[];
}

/**
 * A break node's metrics — zero-height, but present so `metrics` stays
 * index-aligned with `nodes`.
 *
 * @public
 */
export interface BreakMetrics {
  kind: 'pageBreak' | 'columnBreak' | 'sectionBreak';
}

/**
 * The layout metrics of any content node. Index-aligned with the `ContentNode[]`
 * it came from.
 *
 * @public
 */
export type LayoutMetrics =
  | ParagraphMetrics
  | TableMetrics
  | ImageMetrics
  | TextBoxMetrics
  | BreakMetrics;

// ============================================================================
// Fragments — where a content node lands on a page
// ============================================================================

/**
 * Geometry every fragment carries, in content-box coordinates: the origin is
 * the page's top-left margin corner, so a fragment's `x`/`y` are what the
 * painter writes straight into `left`/`top`.
 *
 * @public
 */
export interface FragmentBase extends DocRange {
  nodeId: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which column of a multi-column section this landed in. */
  columnIndex?: number;
}

/**
 * A paragraph, or the slice of one that fit on this page.
 *
 * `[fromLine, toLine)` indexes into the paragraph's `ParagraphMetrics.lines`.
 * `docFrom`/`docTo` narrow to *this slice's* range, so selection mapping and
 * footnote attribution work per page.
 *
 * @public
 */
export interface ParagraphFragment extends FragmentBase {
  kind: 'paragraph';
  fromLine: number;
  toLine: number;
  /** Earlier lines of this paragraph are on a previous page. */
  continuesFromPrev?: boolean;
  /** Later lines of this paragraph are on the next page. */
  continuesOnNext?: boolean;
}

/**
 * A table, or the row range of one that fit on this page.
 *
 * `[fromRow, toRow)` indexes into `TableBlock.rows`. Unlike a paragraph
 * fragment, `docFrom`/`docTo` stay the *whole table's* range — selection maps
 * through the painted cells, not through the fragment.
 *
 * When a single row is taller than a page it splits mid-content:
 * `topClip`/`bottomClip` are the px cut off the first/last row of this slice,
 * always snapped to a whole-line boundary.
 *
 * @public
 */
export interface TableFragment extends FragmentBase {
  kind: 'table';
  fromRow: number;
  toRow: number;
  /** Px clipped off the top of row `fromRow` — it began on the previous page. */
  topClip?: number;
  /** Px clipped off the bottom of row `toRow - 1` — it continues on the next page. */
  bottomClip?: number;
  continuesFromPrev?: boolean;
  continuesOnNext?: boolean;
  /** How many `w:tblHeader` rows are repeated atop this fragment. */
  headerRowCount?: number;
}

/**
 * A block image on a page.
 *
 * @public
 */
export interface ImageFragment extends FragmentBase {
  kind: 'image';
  /** Painted out of flow (`behind` / `inFront`). */
  isAnchored?: boolean;
  zIndex?: number;
}

/**
 * A text box on a page.
 *
 * @public
 */
export interface TextBoxFragment extends FragmentBase {
  kind: 'textBox';
  /** Anchored — positioned by its own anchor, and never advances the body pen. */
  isFloating?: boolean;
  zIndex?: number;
}

/**
 * Anything the painter places on a page.
 *
 * @public
 */
export type Fragment = ParagraphFragment | TableFragment | ImageFragment | TextBoxFragment;

// ============================================================================
// Pages and the layout result
// ============================================================================

/**
 * One composed page.
 *
 * @public
 */
export interface Page {
  /** 1-based. */
  number: number;
  size: Size;
  margins: PageMargins;
  fragments: Fragment[];
  /** The section's column geometry, when it has more than one column. */
  columns?: ColumnLayout;
  /** Zero-based section index this page belongs to. */
  sectionIndex?: number;
  /** One-based page number within the section. */
  sectionPageNumber?: number;
  /** Effective header/footer refs for this page's section. */
  headerFooterRefs?: PageHeaderFooterRefs;
  /** Px reserved at the bottom of the content box for the footnote area. */
  footnoteReservedHeight?: number;
  /** Footnotes whose references landed on this page, in document order. */
  footnoteIds?: number[];
  /** Page-local slices of footnote bodies, including carried continuations. */
  footnoteFragments?: FootnoteFragment[];
  /** `w15:footnoteColumns`, when the footnote area is laid out N-up. */
  footnoteColumns?: number;
}

/**
 * The composed document.
 *
 * @public
 */
export interface PageLayout {
  pages: Page[];
  /** The first section's page size — what the viewport sizes itself to. */
  pageSize: Size;
  /** Vertical gap painted between pages, px. */
  pageGap?: number;
  /** Painted height of every page plus the gaps between them, px. */
  totalHeight?: number;
}

/**
 * The geometry one section imposes. `layOutPages` resolves these into an
 * immutable schedule up front; the flow stage only ever reads it.
 *
 * @public
 */
export interface SectionLayoutConfig {
  pageSize: Size;
  margins: PageMargins;
  columns?: ColumnLayout;
  startType?: SectionStartType;
  /** Effective header/footer refs for pages in this section. */
  headerFooterRefs?: PageHeaderFooterRefs;
}

/**
 * Per-variant header/footer band heights, px. `w:titlePg` and even/odd headers
 * give a page up to three variants.
 *
 * @public
 */
export interface HeaderFooterHeights {
  default?: number;
  first?: number;
  even?: number;
}

/**
 * Everything `layOutPages` needs that the nodes don't carry themselves.
 *
 * There are two geometries because a document's section properties live in two
 * places: the per-section breaks (which ride on `SectionMarkerBlock`s) and the
 * body's *final* `w:sectPr`, which governs the trailing content and has no
 * marker block to hang on — hence `finalPageSize`/`finalMargins`/`columns`.
 *
 * @public
 */
export interface LayoutConfig {
  /** Geometry of the first section. */
  pageSize: Size;
  margins: PageMargins;
  /** Geometry of the body's final `w:sectPr`; defaults to the first section's. */
  finalPageSize?: Size;
  finalMargins?: PageMargins;
  /** Column layout of the body's final `w:sectPr`. */
  columns?: ColumnLayout;
  /** How the final section starts. */
  bodyBreakType?: SectionStartType;
  /** Effective header/footer refs for the body's final section. */
  finalHeaderFooterRefs?: PageHeaderFooterRefs;
  /** Vertical gap between pages, px. */
  pageGap?: number;
  /**
   * Px to reserve at the bottom of the content box for footnotes, keyed by page
   * number. Fed back in by the footnote stabilization loop, which re-composes
   * until the reservation and the page assignment agree.
   */
  footnoteReservedHeights?: Map<number, number>;
  /**
   * Keep composing blank body pages through this page number. Footnote
   * continuations use this when a note outlives the body's final page.
   */
  minimumPageCount?: number;
  /** Painted header heights — they grow the top margin when they overflow it. */
  headerContentHeights?: HeaderFooterHeights;
  /** Painted footer heights — they grow the bottom margin when they overflow it. */
  footerContentHeights?: HeaderFooterHeights;
}

// ============================================================================
// Footnotes
// ============================================================================

/**
 * A footnote resolved through the body pipeline: its own nodes and metrics,
 * ready to paint into the page's reserved area.
 *
 * @public
 */
export interface FootnoteContent {
  id: number;
  /** 1-based, assigned by first-reference order — what the marker prints. */
  displayNumber: number;
  nodes: ContentNode[];
  metrics: LayoutMetrics[];
  /** Painted height of the note, px. */
  height: number;
}
