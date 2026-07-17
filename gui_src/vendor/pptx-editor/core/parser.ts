/**
 * PPTX Parser
 *
 * Reads a .pptx ArrayBuffer (which is a ZIP archive) and extracts a structured
 * Presentation model suitable for rendering in the slide editor canvas.
 *
 * Architecture overview:
 *   ArrayBuffer
 *     → JSZip.loadAsync()       → ZIP entries
 *     → parse presentation.xml  → slide ordering + size
 *     → parse each slide*.xml   → SlideElement[] per slide
 *     → resolve _rels           → image paths → base64 data URIs
 *     → Presentation object
 */

import JSZip from 'jszip';
import type {
  FillStyle,
  GradientStop,
  LineStyle,
  Paragraph,
  ParagraphChild,
  ParagraphProperties,
  Presentation,
  PresentationSize,
  PictureElement,
  ShapeElement,
  Slide,
  SlideBackground,
  SlideElement,
  SlideRelationship,
  TableCell,
  TableElement,
  TableRow,
  TextBody,
  TextRunProperties,
  Transform,
  GroupElement,
} from './types';

// ── XML Helpers ──────────────────────────────────────────────────────────────

const domParser = typeof DOMParser !== 'undefined' ? new DOMParser() : null;

function parseXml(xmlString: string): Document {
  if (!domParser) throw new Error('DOMParser is not available in this environment.');
  return domParser.parseFromString(xmlString, 'application/xml');
}

/**
 * Query helper that ignores namespaces – essential because OOXML uses many
 * namespace prefixes (a:, p:, r:) and browser DOMParser doesn't always
 * preserve them consistently.
 */
function qAll(parent: Element | Document, localName: string): Element[] {
  return Array.from(parent.getElementsByTagName('*')).filter(
    (el) => el.localName === localName,
  );
}

function qFirst(parent: Element | Document, localName: string): Element | null {
  return qAll(parent, localName)[0] ?? null;
}

/** Read an attribute, trying both namespace-prefixed and bare forms. */
function attr(el: Element, name: string): string | null {
  // Try direct first
  if (el.hasAttribute(name)) return el.getAttribute(name);
  // Try with r: prefix (relationships)
  if (el.hasAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name)) {
    return el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name);
  }
  // Search all attributes for localName match
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.localName === name) return a.value;
  }
  return null;
}

function intAttr(el: Element, name: string, fallback: number = 0): number {
  const v = attr(el, name);
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ── Color / Fill Parsing ─────────────────────────────────────────────────────

function parseColorElement(el: Element): string | null {
  const srgb = qFirst(el, 'srgbClr');
  if (srgb) return attr(srgb, 'val') ?? null;
  // Scheme colors are theme-dependent; return a fallback
  const schemeClr = qFirst(el, 'schemeClr');
  if (schemeClr) {
    const val = attr(schemeClr, 'val');
    // Map common scheme colors to reasonable defaults
    const schemeDefaults: Record<string, string> = {
      tx1: '000000', tx2: '44546A', bg1: 'FFFFFF', bg2: 'E7E6E6',
      accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5',
      accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47',
      dk1: '000000', dk2: '44546A', lt1: 'FFFFFF', lt2: 'E7E6E6',
      hlink: '0563C1', folHlink: '954F72',
    };
    return val ? (schemeDefaults[val] ?? '000000') : '000000';
  }
  return null;
}

function parseFill(parent: Element): FillStyle | undefined {
  const solidFill = qFirst(parent, 'solidFill');
  if (solidFill) {
    const color = parseColorElement(solidFill);
    if (color) {
      const alphaEl = qFirst(solidFill, 'alpha');
      return {
        type: 'solid',
        color,
        alpha: alphaEl ? intAttr(alphaEl, 'val') : undefined,
      };
    }
  }

  const gradFill = qFirst(parent, 'gradFill');
  if (gradFill) {
    const gsLst = qFirst(gradFill, 'gsLst');
    const stops: GradientStop[] = [];
    if (gsLst) {
      for (const gs of qAll(gsLst, 'gs')) {
        const pos = intAttr(gs, 'pos');
        const color = parseColorElement(gs);
        if (color) stops.push({ position: pos, color });
      }
    }
    const lin = qFirst(gradFill, 'lin');
    return {
      type: 'gradient',
      stops,
      angle: lin ? intAttr(lin, 'ang') : undefined,
    };
  }

  const noFill = qFirst(parent, 'noFill');
  if (noFill) return { type: 'none' };

  return undefined;
}

// ── Line Parsing ─────────────────────────────────────────────────────────────

function parseLine(parent: Element): LineStyle | undefined {
  const ln = qFirst(parent, 'ln');
  if (!ln) return undefined;
  const width = intAttr(ln, 'w', 12700); // default ~1pt
  const fill = parseFill(ln);
  return { width, fill };
}

// ── Transform Parsing ────────────────────────────────────────────────────────

function parseTransform(spPr: Element): Transform {
  const xfrm = qFirst(spPr, 'xfrm');
  if (!xfrm) return { x: 0, y: 0, width: 0, height: 0 };
  const off = qFirst(xfrm, 'off');
  const ext = qFirst(xfrm, 'ext');
  return {
    x: off ? intAttr(off, 'x') : 0,
    y: off ? intAttr(off, 'y') : 0,
    width: ext ? intAttr(ext, 'cx') : 0,
    height: ext ? intAttr(ext, 'cy') : 0,
    rotation: intAttr(xfrm, 'rot') || undefined,
    flipH: attr(xfrm, 'flipH') === '1' || undefined,
    flipV: attr(xfrm, 'flipV') === '1' || undefined,
  };
}

// ── Text Body Parsing ────────────────────────────────────────────────────────

function parseRunProperties(rPr: Element | null): TextRunProperties | undefined {
  if (!rPr) return undefined;
  const props: TextRunProperties = {};
  if (attr(rPr, 'b') === '1') props.bold = true;
  if (attr(rPr, 'i') === '1') props.italic = true;
  if (attr(rPr, 'u') && attr(rPr, 'u') !== 'none') props.underline = true;
  if (attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike') props.strikethrough = true;
  const sz = attr(rPr, 'sz');
  if (sz) props.fontSize = parseInt(sz, 10);

  // Font family
  const latin = qFirst(rPr, 'latin');
  if (latin) props.fontFamily = attr(latin, 'typeface') ?? undefined;

  // Color
  const solidFill = qFirst(rPr, 'solidFill');
  if (solidFill) {
    const color = parseColorElement(solidFill);
    if (color) props.color = color;
  }

  return Object.keys(props).length > 0 ? props : undefined;
}

function parseParagraphProperties(pPr: Element | null): ParagraphProperties | undefined {
  if (!pPr) return undefined;
  const props: ParagraphProperties = {};

  const algn = attr(pPr, 'algn');
  if (algn) {
    const map: Record<string, 'left' | 'center' | 'right' | 'justify'> = {
      l: 'left', ctr: 'center', r: 'right', just: 'justify',
    };
    props.alignment = map[algn] ?? 'left';
  }

  const lvl = attr(pPr, 'lvl');
  if (lvl) props.level = parseInt(lvl, 10);

  const marL = attr(pPr, 'marL');
  if (marL) props.marginLeft = parseInt(marL, 10);

  const indent = attr(pPr, 'indent');
  if (indent) props.indent = parseInt(indent, 10);

  const lnSpc = qFirst(pPr, 'lnSpc');
  const lnSpcPct = lnSpc ? qFirst(lnSpc, 'spcPct') : null;
  if (lnSpcPct) props.lineSpacing = intAttr(lnSpcPct, 'val');

  const spcBef = qFirst(pPr, 'spcBef');
  const spcBefPts = spcBef ? qFirst(spcBef, 'spcPts') : null;
  if (spcBefPts) props.spaceBefore = intAttr(spcBefPts, 'val');

  const spcAft = qFirst(pPr, 'spcAft');
  const spcAftPts = spcAft ? qFirst(spcAft, 'spcPts') : null;
  if (spcAftPts) props.spaceAfter = intAttr(spcAftPts, 'val');

  // Bullet
  const buChar = qFirst(pPr, 'buChar');
  if (buChar) props.bulletChar = attr(buChar, 'char') ?? undefined;

  const buAutoNum = qFirst(pPr, 'buAutoNum');
  if (buAutoNum) props.bulletAutoNum = attr(buAutoNum, 'type') ?? undefined;

  return Object.keys(props).length > 0 ? props : undefined;
}

function parseTextBody(txBody: Element): TextBody {
  const paragraphs: Paragraph[] = [];
  for (const pEl of qAll(txBody, 'p')) {
    // Only consider direct children paragraphs
    if (pEl.parentElement !== txBody) continue;
    const children: ParagraphChild[] = [];

    for (const child of Array.from(pEl.children)) {
      if (child.localName === 'r') {
        // Text run
        const rPr = qFirst(child, 'rPr');
        const tEl = qFirst(child, 't');
        children.push({
          text: tEl?.textContent ?? '',
          properties: parseRunProperties(rPr),
        });
      } else if (child.localName === 'br') {
        children.push({ type: 'break' as const });
      }
    }

    const pPr = qFirst(pEl, 'pPr');
    paragraphs.push({
      children,
      properties: parseParagraphProperties(pPr?.parentElement === pEl ? pPr : null),
    });
  }

  // Body properties
  const bodyPr = qFirst(txBody, 'bodyPr');
  const bodyProperties = bodyPr
    ? {
        anchor: (attr(bodyPr, 'anchor') as 'top' | 'middle' | 'bottom') ?? undefined,
        wrap: (attr(bodyPr, 'wrap') as 'square' | 'none') ?? undefined,
        lIns: intAttr(bodyPr, 'lIns') || undefined,
        tIns: intAttr(bodyPr, 'tIns') || undefined,
        rIns: intAttr(bodyPr, 'rIns') || undefined,
        bIns: intAttr(bodyPr, 'bIns') || undefined,
      }
    : undefined;

  return { paragraphs, bodyProperties };
}

// ── Shape / Picture / Group Parsing ──────────────────────────────────────────

let _elementIdCounter = 0;

function nextId(): string {
  return `el_${++_elementIdCounter}`;
}

/**
 * Default placeholder positions (EMU) used when the slide XML has an empty
 * <p:spPr/>, meaning the actual dimensions come from the slide layout.
 * These are the standard defaults for a 10"×7.5" (4:3) slide.
 */
const PLACEHOLDER_DEFAULTS: Record<string, Transform> = {
  title:  { x: 457200,  y: 274638,  width: 8229600, height: 1143000 },
  ctrTitle: { x: 685800,  y: 2130425, width: 7772400, height: 1470025 },
  subTitle: { x: 1371600, y: 3886200, width: 6400800, height: 1752600 },
  body:   { x: 457200,  y: 1600200, width: 8229600, height: 4525963 },
  dt:     { x: 457200,  y: 6356350, width: 2133600, height: 365125 },
  ftr:    { x: 3124200, y: 6356350, width: 2895600, height: 365125 },
  sldNum: { x: 6553200, y: 6356350, width: 2133600, height: 365125 },
};

/** Fallback transform for shapes without explicit positioning. */
const FALLBACK_TRANSFORM: Transform = { x: 457200, y: 1600200, width: 8229600, height: 4525963 };

interface PlaceholderLayout {
  transform?: Transform;
}

function hasUsableTransform(transform: Transform | undefined): transform is Transform {
  return Boolean(transform && transform.width > 0 && transform.height > 0);
}

function placeholderKey(type: string | undefined, idx: number | undefined): string {
  return `${type || 'body'}:${idx ?? ''}`;
}

function getPlaceholderLayout(
  layouts: Map<string, PlaceholderLayout> | undefined,
  type: string | undefined,
  idx: number | undefined,
): PlaceholderLayout | undefined {
  if (!layouts || (!type && idx === undefined)) return undefined;
  return layouts.get(placeholderKey(type, idx))
    || layouts.get(placeholderKey(type, undefined))
    || (idx !== undefined ? layouts.get(placeholderKey(undefined, idx)) : undefined);
}

function defaultPlaceholderTransform(
  placeholderType: string | undefined,
  presentationSize?: PresentationSize,
): Transform | undefined {
  if (!placeholderType) return undefined;
  if (!presentationSize) return PLACEHOLDER_DEFAULTS[placeholderType];

  const { width, height } = presentationSize;
  const horizontalMargin = Math.round(width * 0.1);
  const broadWidth = width - horizontalMargin * 2;

  if (placeholderType === 'title') {
    return {
      x: horizontalMargin,
      y: Math.round(height * 0.06),
      width: broadWidth,
      height: Math.round(height * 0.17),
    };
  }

  if (placeholderType === 'ctrTitle') {
    return {
      x: horizontalMargin,
      y: Math.round(height * 0.31),
      width: broadWidth,
      height: Math.round(height * 0.18),
    };
  }

  if (placeholderType === 'subTitle') {
    return {
      x: Math.round(width * 0.18),
      y: Math.round(height * 0.48),
      width: Math.round(width * 0.64),
      height: Math.round(height * 0.18),
    };
  }

  if (placeholderType === 'body') {
    return {
      x: horizontalMargin,
      y: Math.round(height * 0.2),
      width: broadWidth,
      height: Math.round(height * 0.68),
    };
  }

  return PLACEHOLDER_DEFAULTS[placeholderType];
}

function resolveTransform(
  spPr: Element | null,
  placeholderType: string | undefined,
  layout: PlaceholderLayout | undefined,
  presentationSize?: PresentationSize,
): Transform {
  const parsed = spPr ? parseTransform(spPr) : { x: 0, y: 0, width: 0, height: 0 };
  // If the shape has explicit dimensions, use them
  if (parsed.width > 0 && parsed.height > 0) return parsed;
  if (hasUsableTransform(layout?.transform)) {
    return { ...layout.transform, rotation: parsed.rotation, flipH: parsed.flipH, flipV: parsed.flipV };
  }
  // Otherwise fall back to placeholder defaults
  const fallback = defaultPlaceholderTransform(placeholderType, presentationSize);
  if (fallback) {
    return { ...fallback, rotation: parsed.rotation, flipH: parsed.flipH, flipV: parsed.flipV };
  }
  // Generic fallback so the shape is at least visible
  return { ...FALLBACK_TRANSFORM, rotation: parsed.rotation, flipH: parsed.flipH, flipV: parsed.flipV };
}

function defaultFontSizeForPlaceholder(placeholderType: string | undefined): number | undefined {
  if (placeholderType === 'title' || placeholderType === 'ctrTitle') return 3200;
  if (placeholderType === 'subTitle') return 2400;
  if (placeholderType === 'body') return 2400;
  if (placeholderType === 'dt' || placeholderType === 'ftr' || placeholderType === 'sldNum') return 1200;
  return undefined;
}

function applyPlaceholderTextDefaults(textBody: TextBody | undefined, placeholderType: string | undefined): TextBody | undefined {
  if (!textBody) return undefined;
  const defaultFontSize = defaultFontSizeForPlaceholder(placeholderType);
  if (!defaultFontSize) return textBody;
  const defaultAlignment = placeholderType === 'title' || placeholderType === 'ctrTitle' || placeholderType === 'subTitle'
    ? 'center'
    : undefined;

  return {
    ...textBody,
    paragraphs: textBody.paragraphs.map((paragraph) => ({
      ...paragraph,
      properties: {
        ...(paragraph.properties || {}),
        ...(paragraph.properties?.alignment || !defaultAlignment ? {} : { alignment: defaultAlignment }),
        ...(placeholderType === 'body'
          && !paragraph.properties?.bulletChar
          && !paragraph.properties?.bulletAutoNum
          && paragraph.children.some((child) => !('type' in child) && child.text.trim())
          ? { bulletChar: '•' }
          : {}),
      },
      children: paragraph.children.map((child) => {
        if ('type' in child && child.type === 'break') return child;
        return {
          ...child,
          properties: {
            ...(child.properties || {}),
            ...(child.properties?.fontSize ? {} : { fontSize: defaultFontSize }),
          },
        };
      }),
    })),
  };
}

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseShape(
  sp: Element,
  layoutPlaceholders?: Map<string, PlaceholderLayout>,
  presentationSize?: PresentationSize,
): ShapeElement {
  const nvSpPr = qFirst(sp, 'nvSpPr');
  const cNvPr = nvSpPr ? qFirst(nvSpPr, 'cNvPr') : null;
  const spPr = qFirst(sp, 'spPr');
  const txBody = qFirst(sp, 'txBody');

  // Placeholder info
  const nvPr = nvSpPr ? qFirst(nvSpPr, 'nvPr') : null;
  const ph = nvPr ? qFirst(nvPr, 'ph') : null;
  const placeholderType = ph ? (attr(ph, 'type') ?? 'body') : undefined;
  const placeholderIdx = ph ? parseOptionalInt(attr(ph, 'idx')) : undefined;
  const layout = getPlaceholderLayout(layoutPlaceholders, placeholderType, placeholderIdx);

  const prstGeom = spPr ? qFirst(spPr, 'prstGeom') : null;

  return {
    type: 'shape',
    id: cNvPr ? (attr(cNvPr, 'id') ?? nextId()) : nextId(),
    name: cNvPr ? (attr(cNvPr, 'name') ?? '') : '',
    transform: resolveTransform(spPr, placeholderType, layout, presentationSize),
    geometry: prstGeom ? (attr(prstGeom, 'prst') ?? 'rect') : 'rect',
    fill: spPr ? parseFill(spPr) : undefined,
    line: spPr ? parseLine(spPr) : undefined,
    textBody: applyPlaceholderTextDefaults(txBody ? parseTextBody(txBody) : undefined, placeholderType),
    placeholderType,
    placeholderIdx,
  };
}

function parsePicture(pic: Element, relsMap: Map<string, string>): PictureElement {
  const nvPicPr = qFirst(pic, 'nvPicPr');
  const cNvPr = nvPicPr ? qFirst(nvPicPr, 'cNvPr') : null;
  const spPr = qFirst(pic, 'spPr');

  // The blip element holds the relationship ID for the image
  const blipFill = qFirst(pic, 'blipFill');
  const blip = blipFill ? qFirst(blipFill, 'blip') : null;
  const rId = blip ? (attr(blip, 'embed') ?? '') : '';

  // Resolve the rId to a media path
  const targetPath = relsMap.get(rId);
  const mediaPath = targetPath ? normalizeMediaPath(targetPath) : undefined;

  return {
    type: 'picture',
    id: cNvPr ? (attr(cNvPr, 'id') ?? nextId()) : nextId(),
    name: cNvPr ? (attr(cNvPr, 'name') ?? '') : '',
    transform: spPr ? parseTransform(spPr) : { x: 0, y: 0, width: 0, height: 0 },
    rId,
    mediaPath,
    line: spPr ? parseLine(spPr) : undefined,
  };
}

function parseGroup(
  grpSp: Element,
  relsMap: Map<string, string>,
  layoutPlaceholders?: Map<string, PlaceholderLayout>,
  presentationSize?: PresentationSize,
): GroupElement {
  const nvGrpSpPr = qFirst(grpSp, 'nvGrpSpPr');
  const cNvPr = nvGrpSpPr ? qFirst(nvGrpSpPr, 'cNvPr') : null;
  const grpSpPr = qFirst(grpSp, 'grpSpPr');

  // Child transform
  const xfrm = grpSpPr ? qFirst(grpSpPr, 'xfrm') : null;
  let childTransform: Transform | undefined;
  if (xfrm) {
    const chOff = qFirst(xfrm, 'chOff');
    const chExt = qFirst(xfrm, 'chExt');
    if (chOff && chExt) {
      childTransform = {
        x: intAttr(chOff, 'x'),
        y: intAttr(chOff, 'y'),
        width: intAttr(chExt, 'cx'),
        height: intAttr(chExt, 'cy'),
      };
    }
  }

  const children = parseSlideElements(grpSp, relsMap, layoutPlaceholders, presentationSize);

  return {
    type: 'group',
    id: cNvPr ? (attr(cNvPr, 'id') ?? nextId()) : nextId(),
    name: cNvPr ? (attr(cNvPr, 'name') ?? '') : '',
    transform: grpSpPr ? parseTransform(grpSpPr) : { x: 0, y: 0, width: 0, height: 0 },
    childTransform,
    children,
  };
}

function parseTable(graphicFrame: Element): TableElement | null {
  const tbl = qFirst(graphicFrame, 'tbl');
  if (!tbl) return null;

  const nvGraphicFramePr = qFirst(graphicFrame, 'nvGraphicFramePr');
  const cNvPr = nvGraphicFramePr ? qFirst(nvGraphicFramePr, 'cNvPr') : null;
  const xfrm = qFirst(graphicFrame, 'xfrm');
  const transform: Transform = xfrm
    ? parseTransform(graphicFrame)
    : { x: 0, y: 0, width: 0, height: 0 };

  // Parse column widths
  const tblGrid = qFirst(tbl, 'tblGrid');
  const columns: number[] = [];
  if (tblGrid) {
    for (const gridCol of qAll(tblGrid, 'gridCol')) {
      columns.push(intAttr(gridCol, 'w'));
    }
  }

  // Parse rows
  const rows: TableRow[] = [];
  for (const tr of qAll(tbl, 'tr')) {
    if (tr.parentElement !== tbl) continue;
    const height = intAttr(tr, 'h');
    const cells: TableCell[] = [];
    for (const tc of qAll(tr, 'tc')) {
      if (tc.parentElement !== tr) continue;
      const txBody = qFirst(tc, 'txBody');
      const tcPr = qFirst(tc, 'tcPr');
      cells.push({
        textBody: txBody ? parseTextBody(txBody) : undefined,
        fill: tcPr ? parseFill(tcPr) : undefined,
        rowSpan: intAttr(tc, 'rowSpan') || undefined,
        colSpan: intAttr(tc, 'gridSpan') || undefined,
      });
    }
    rows.push({ height, cells });
  }

  return {
    type: 'table',
    id: cNvPr ? (attr(cNvPr, 'id') ?? nextId()) : nextId(),
    name: cNvPr ? (attr(cNvPr, 'name') ?? '') : '',
    transform,
    columns,
    rows,
  };
}

// ── Slide Element Collection ─────────────────────────────────────────────────

function parseSlideElements(
  parent: Element,
  relsMap: Map<string, string>,
  layoutPlaceholders?: Map<string, PlaceholderLayout>,
  presentationSize?: PresentationSize,
): SlideElement[] {
  const elements: SlideElement[] = [];

  for (const child of Array.from(parent.children)) {
    const ln = child.localName;
    if (ln === 'sp') {
      elements.push(parseShape(child, layoutPlaceholders, presentationSize));
    } else if (ln === 'pic') {
      elements.push(parsePicture(child, relsMap));
    } else if (ln === 'grpSp') {
      elements.push(parseGroup(child, relsMap, layoutPlaceholders, presentationSize));
    } else if (ln === 'graphicFrame') {
      const table = parseTable(child);
      if (table) elements.push(table);
    }
  }
  return elements;
}

function transformsOverlapHorizontally(a: Transform, b: Transform): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

function avoidTitleBodyOverlap(elements: SlideElement[], presentationSize: PresentationSize): SlideElement[] {
  const titleElements = elements.filter((element) => (
    element.type === 'shape'
    && (element.placeholderType === 'title' || element.placeholderType === 'ctrTitle')
    && element.transform.width > 0
    && element.transform.height > 0
  ));

  if (titleElements.length === 0) return elements;

  const titleBottom = Math.max(...titleElements.map((element) => element.transform.y + element.transform.height));
  const minBodyY = Math.max(
    Math.round(presentationSize.height * 0.28),
    titleBottom + Math.round(presentationSize.height * 0.035),
  );

  return elements.map((element) => {
    if (
      element.type !== 'shape'
      || element.placeholderType !== 'body'
      || element.transform.y >= minBodyY
      || !titleElements.some((title) => transformsOverlapHorizontally(title.transform, element.transform))
    ) {
      return element;
    }

    const maxHeight = Math.max(
      Math.round(presentationSize.height * 0.2),
      presentationSize.height - minBodyY - Math.round(presentationSize.height * 0.08),
    );

    return {
      ...element,
      transform: {
        ...element.transform,
        y: minBodyY,
        height: Math.min(element.transform.height, maxHeight),
      },
    };
  });
}

// ── Relationship Parsing ─────────────────────────────────────────────────────

function parseRelationships(xmlString: string): Map<string, string> {
  const doc = parseXml(xmlString);
  const map = new Map<string, string>();
  for (const rel of qAll(doc, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

function normalizeZipPath(basePath: string, target: string): string {
  if (target.startsWith('/')) return target.substring(1);
  if (target.startsWith('ppt/')) return target;

  const baseParts = basePath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join('/');
}

function collectLayoutPlaceholders(layoutDoc: Document): Map<string, PlaceholderLayout> {
  const placeholders = new Map<string, PlaceholderLayout>();
  const spTree = qFirst(layoutDoc, 'spTree');
  if (!spTree) return placeholders;

  for (const sp of Array.from(spTree.children)) {
    if (sp.localName !== 'sp') continue;
    const nvSpPr = qFirst(sp, 'nvSpPr');
    const nvPr = nvSpPr ? qFirst(nvSpPr, 'nvPr') : null;
    const ph = nvPr ? qFirst(nvPr, 'ph') : null;
    if (!ph) continue;

    const type = attr(ph, 'type') ?? 'body';
    const idx = parseOptionalInt(attr(ph, 'idx'));
    const spPr = qFirst(sp, 'spPr');
    const transform = spPr ? parseTransform(spPr) : undefined;
    const layout: PlaceholderLayout = {};
    if (hasUsableTransform(transform)) {
      layout.transform = transform;
    }

    placeholders.set(placeholderKey(type, idx), layout);
    placeholders.set(placeholderKey(type, undefined), layout);
    if (idx !== undefined) {
      placeholders.set(placeholderKey(undefined, idx), layout);
    }
  }

  return placeholders;
}

function normalizeMediaPath(relTarget: string): string {
  // Relationship targets are relative to the slide, e.g. "../media/image1.png"
  // Normalize to an absolute-within-zip path
  if (relTarget.startsWith('../')) {
    return 'ppt/' + relTarget.substring(3);
  }
  if (!relTarget.startsWith('ppt/')) {
    return 'ppt/' + relTarget;
  }
  return relTarget;
}

// ── Presentation.xml Parsing ─────────────────────────────────────────────────

function parsePresentationXml(xmlString: string): {
  size: PresentationSize;
  slideRels: SlideRelationship[];
} {
  const doc = parseXml(xmlString);

  // Slide size
  const sldSz = qFirst(doc, 'sldSz');
  const size: PresentationSize = {
    width: sldSz ? intAttr(sldSz, 'cx', 9144000) : 9144000,
    height: sldSz ? intAttr(sldSz, 'cy', 6858000) : 6858000,
  };

  // Slide list (in order)
  const slideRels: SlideRelationship[] = [];
  const sldIdLst = qFirst(doc, 'sldIdLst');
  if (sldIdLst) {
    for (const sldId of qAll(sldIdLst, 'sldId')) {
      // The r:id attribute references the relationship ID (e.g. "rId2").
      // Try multiple ways to read it since namespace handling varies across
      // browsers and DOMParser implementations.
      let relId: string | null =
        sldId.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'id',
        );
      // Fallback: search all attributes for one with localName 'id' and
      // value starting with 'rId' (the numeric 'id' attr is just a number).
      if (!relId) {
        for (let i = 0; i < sldId.attributes.length; i++) {
          const a = sldId.attributes[i];
          if (a.localName === 'id' && typeof a.value === 'string' && a.value.startsWith('rId')) {
            relId = a.value;
            break;
          }
        }
      }

      if (relId) {
        slideRels.push({ rId: relId, target: '' });
      }
    }
  }

  return { size, slideRels };
}

// ── Slide Background ─────────────────────────────────────────────────────────

function parseSlideBackground(slideDoc: Document): SlideBackground | undefined {
  const bg = qFirst(slideDoc, 'bg');
  if (!bg) return undefined;
  const bgPr = qFirst(bg, 'bgPr');
  if (bgPr) {
    const fill = parseFill(bgPr);
    if (fill) return { fill };
  }
  return undefined;
}

// ── Media Resolution ─────────────────────────────────────────────────────────

function guessMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    emf: 'image/emf',
    wmf: 'image/wmf',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

async function resolveMediaCache(
  zip: JSZip,
  slides: Slide[],
): Promise<Record<string, string>> {
  const cache: Record<string, string> = {};
  const pathsNeeded = new Set<string>();

  for (const slide of slides) {
    collectMediaPaths(slide.elements, pathsNeeded);
  }

  await Promise.all(
    Array.from(pathsNeeded).map(async (mediaPath) => {
      const file = zip.file(mediaPath);
      if (!file) return;
      const blob = await file.async('blob');
      const mime = guessMimeType(mediaPath);
      cache[mediaPath] = await blobToDataUri(blob, mime);
    }),
  );

  return cache;
}

function collectMediaPaths(elements: SlideElement[], paths: Set<string>): void {
  for (const el of elements) {
    if (el.type === 'picture' && el.mediaPath) {
      paths.add(el.mediaPath);
    } else if (el.type === 'group') {
      collectMediaPaths(el.children, paths);
    }
  }
}

function blobToDataUri(blob: Blob, mime: string): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve('');
    // Re-create blob with correct mime so that the data URI is correct
    const corrected = new Blob([blob], { type: mime });
    reader.readAsDataURL(corrected);
  });
}

// ── Main Parse Function ──────────────────────────────────────────────────────

/**
 * Parse a .pptx file from an ArrayBuffer into a structured Presentation object.
 */
export async function parsePptx(buffer: ArrayBuffer): Promise<Presentation> {
  _elementIdCounter = 0;

  const zip = await JSZip.loadAsync(buffer);

  // 1. Read presentation.xml
  const presentationXmlFile = zip.file('ppt/presentation.xml');
  if (!presentationXmlFile) {
    throw new Error('Invalid PPTX: missing ppt/presentation.xml');
  }
  const presentationXml = await presentationXmlFile.async('string');
  const { size, slideRels } = parsePresentationXml(presentationXml);

  // 2. Read presentation.xml.rels to map rIds to slide paths
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
  let presRelsMap = new Map<string, string>();
  if (presRelsFile) {
    presRelsMap = parseRelationships(await presRelsFile.async('string'));
  }

  // 3. Determine slide ordering
  // slideRels from sldIdLst use r:id which maps through presentation.xml.rels
  // We need to match these to the actual slide file paths
  const orderedSlidePaths: string[] = [];

  // Collect all relationship entries that point to slides
  const slideRelEntries: Array<{ rId: string; target: string }> = [];
  for (const [rId, target] of presRelsMap) {
    if (target.startsWith('slides/') || target.includes('/slides/')) {
      slideRelEntries.push({ rId, target });
    }
  }

  // If we got rIds from sldIdLst, use those to order
  if (slideRels.length > 0) {
    for (const sr of slideRels) {
      const match = slideRelEntries.find((e) => e.rId === sr.rId);
      if (match) {
        orderedSlidePaths.push(
          match.target.startsWith('ppt/')
            ? match.target
            : 'ppt/' + match.target,
        );
      }
    }
  }

  // Fallback: if ordering from sldIdLst didn't work, scan zip entries
  if (orderedSlidePaths.length === 0) {
    const slideFiles = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)/)?.[1] ?? '0', 10);
        const numB = parseInt(b.match(/slide(\d+)/)?.[1] ?? '0', 10);
        return numA - numB;
      });
    orderedSlidePaths.push(...slideFiles);
  }

  // 4. Parse each slide
  const slides: Slide[] = [];
  for (let i = 0; i < orderedSlidePaths.length; i++) {
    const xmlPath = orderedSlidePaths[i];
    const slideFile = zip.file(xmlPath);
    if (!slideFile) continue;

    const slideXml = await slideFile.async('string');
    const slideDoc = parseXml(slideXml);

    // Read slide relationships
    const relsPath = xmlPath.replace(
      /^(ppt\/slides\/)(slide\d+\.xml)$/,
      '$1_rels/$2.rels',
    );
    const relsFile = zip.file(relsPath);
    let relsMap = new Map<string, string>();
    if (relsFile) {
      relsMap = parseRelationships(await relsFile.async('string'));
    }

    let layoutPlaceholders: Map<string, PlaceholderLayout> | undefined;
    const layoutTarget = Array.from(relsMap.values()).find((target) => target.includes('slideLayout'));
    if (layoutTarget) {
      const layoutPath = normalizeZipPath(xmlPath, layoutTarget);
      const layoutFile = zip.file(layoutPath);
      if (layoutFile) {
        layoutPlaceholders = collectLayoutPlaceholders(parseXml(await layoutFile.async('string')));
      }
    }

    // Find the shape tree (spTree)
    const spTree = qFirst(slideDoc, 'spTree');
    const elements: SlideElement[] = spTree
      ? parseSlideElements(spTree, relsMap, layoutPlaceholders, size)
      : [];
    const normalizedElements = avoidTitleBodyOverlap(elements, size);

    const background = parseSlideBackground(slideDoc);

    slides.push({
      number: i + 1,
      xmlPath,
      relsPath,
      elements: normalizedElements,
      background,
      rawXml: slideXml,
    });
  }

  // 5. Resolve media (images)
  const mediaCache = await resolveMediaCache(zip, slides);

  // Assign data URIs to picture elements
  for (const slide of slides) {
    assignDataUris(slide.elements, mediaCache);
  }

  return {
    size,
    slides,
    mediaCache,
    zipInstance: zip,
  };
}

function assignDataUris(
  elements: SlideElement[],
  mediaCache: Record<string, string>,
): void {
  for (const el of elements) {
    if (el.type === 'picture' && el.mediaPath && mediaCache[el.mediaPath]) {
      el.dataUri = mediaCache[el.mediaPath];
    } else if (el.type === 'group') {
      assignDataUris(el.children, mediaCache);
    }
  }
}
