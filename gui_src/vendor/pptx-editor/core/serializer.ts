/**
 * PPTX Serializer
 *
 * Takes a modified Presentation model and writes the changes back to the
 * original ZIP archive, producing a new ArrayBuffer.
 *
 * Strategy: "Surgical Update"
 *   - Only slide XML files that were actually modified are re-generated.
 *   - All other ZIP entries (layouts, masters, themes, media, rels) are
 *     carried through untouched from the original archive, ensuring
 *     lossless round-tripping of unsupported features.
 *   - New slides are generated from a minimal template.
 *   - Deleted slides have their entries removed and relationships updated.
 */

import JSZip from 'jszip';
import type {
  FillStyle,
  LineStyle,
  Paragraph,
  ParagraphChild,
  Presentation,
  ShapeElement,
  PictureElement,
  GroupElement,
  TableElement,
  Slide,
  SlideElement,
  TextBody,
  TextRunProperties,
  ParagraphProperties,
  Transform,
} from './types';

// ── XML Escape ───────────────────────────────────────────────────────────────

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Color / Fill Serialization ───────────────────────────────────────────────

function serializeFill(fill: FillStyle | undefined): string {
  if (!fill) return '';
  if (fill.type === 'none') return '<a:noFill/>';
  if (fill.type === 'solid') {
    let inner = `<a:srgbClr val="${fill.color}">`;
    if (fill.alpha !== undefined) inner += `<a:alpha val="${fill.alpha}"/>`;
    inner += '</a:srgbClr>';
    return `<a:solidFill>${inner}</a:solidFill>`;
  }
  if (fill.type === 'gradient') {
    let stops = '<a:gsLst>';
    for (const stop of fill.stops) {
      stops += `<a:gs pos="${stop.position}"><a:srgbClr val="${stop.color}"/></a:gs>`;
    }
    stops += '</a:gsLst>';
    const lin = fill.angle !== undefined ? `<a:lin ang="${fill.angle}" scaled="1"/>` : '';
    return `<a:gradFill>${stops}${lin}</a:gradFill>`;
  }
  return '';
}

function serializeLine(line: LineStyle | undefined): string {
  if (!line) return '';
  const fillStr = line.fill ? serializeFill(line.fill) : '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>';
  return `<a:ln w="${line.width}">${fillStr}</a:ln>`;
}

// ── Transform Serialization ──────────────────────────────────────────────────

function serializeTransform(t: Transform): string {
  let attrs = '';
  if (t.rotation) attrs += ` rot="${t.rotation}"`;
  if (t.flipH) attrs += ' flipH="1"';
  if (t.flipV) attrs += ' flipV="1"';
  return `<a:xfrm${attrs}>`
    + `<a:off x="${t.x}" y="${t.y}"/>`
    + `<a:ext cx="${t.width}" cy="${t.height}"/>`
    + '</a:xfrm>';
}

// ── Text Serialization ──────────────────────────────────────────────────────

function serializeRunProperties(props: TextRunProperties | undefined): string {
  if (!props) return '<a:rPr lang="en-US" dirty="0"/>';
  let attrs = ' lang="en-US" dirty="0"';
  if (props.bold) attrs += ' b="1"';
  if (props.italic) attrs += ' i="1"';
  if (props.underline) attrs += ' u="sng"';
  if (props.strikethrough) attrs += ' strike="sngStrike"';
  if (props.fontSize) attrs += ` sz="${props.fontSize}"`;

  let inner = '';
  if (props.color) {
    inner += `<a:solidFill><a:srgbClr val="${props.color}"/></a:solidFill>`;
  }
  if (props.fontFamily) {
    inner += `<a:latin typeface="${escXml(props.fontFamily)}"/>`;
  }
  if (inner) return `<a:rPr${attrs}>${inner}</a:rPr>`;
  return `<a:rPr${attrs}/>`;
}

function serializeParagraphProperties(props: ParagraphProperties | undefined): string {
  if (!props) return '';
  let attrs = '';
  if (props.alignment) {
    const map: Record<string, string> = { left: 'l', center: 'ctr', right: 'r', justify: 'just' };
    attrs += ` algn="${map[props.alignment] ?? 'l'}"`;
  }
  if (props.level !== undefined) attrs += ` lvl="${props.level}"`;

  let inner = '';
  if (props.bulletChar) {
    inner += `<a:buChar char="${escXml(props.bulletChar)}"/>`;
  } else if (props.bulletAutoNum) {
    inner += `<a:buAutoNum type="${props.bulletAutoNum}"/>`;
  }

  if (inner) return `<a:pPr${attrs}>${inner}</a:pPr>`;
  if (attrs) return `<a:pPr${attrs}/>`;
  return '';
}

function serializeParagraph(p: Paragraph): string {
  let xml = '<a:p>';
  xml += serializeParagraphProperties(p.properties);

  for (const child of p.children) {
    if ('type' in child && child.type === 'break') {
      xml += '<a:br/>';
    } else {
      const run = child as { text: string; properties?: TextRunProperties };
      xml += '<a:r>';
      xml += serializeRunProperties(run.properties);
      xml += `<a:t>${escXml(run.text)}</a:t>`;
      xml += '</a:r>';
    }
  }

  // If paragraph has no children, add an endParaRPr so PowerPoint doesn't complain
  if (p.children.length === 0) {
    xml += '<a:endParaRPr lang="en-US"/>';
  }

  xml += '</a:p>';
  return xml;
}

function serializeTextBody(tb: TextBody): string {
  let bodyAttrs = '';
  if (tb.bodyProperties) {
    const bp = tb.bodyProperties;
    if (bp.anchor) bodyAttrs += ` anchor="${bp.anchor === 'middle' ? 'ctr' : bp.anchor === 'bottom' ? 'b' : 't'}"`;
    if (bp.wrap) bodyAttrs += ` wrap="${bp.wrap}"`;
    if (bp.lIns !== undefined) bodyAttrs += ` lIns="${bp.lIns}"`;
    if (bp.tIns !== undefined) bodyAttrs += ` tIns="${bp.tIns}"`;
    if (bp.rIns !== undefined) bodyAttrs += ` rIns="${bp.rIns}"`;
    if (bp.bIns !== undefined) bodyAttrs += ` bIns="${bp.bIns}"`;
  }

  let xml = '<p:txBody>';
  xml += `<a:bodyPr${bodyAttrs}/>`;
  xml += '<a:lstStyle/>';
  for (const p of tb.paragraphs) {
    xml += serializeParagraph(p);
  }
  if (tb.paragraphs.length === 0) {
    xml += '<a:p><a:endParaRPr lang="en-US"/></a:p>';
  }
  xml += '</p:txBody>';
  return xml;
}

// ── Element Serialization ────────────────────────────────────────────────────

function serializeShape(shape: ShapeElement): string {
  let xml = '<p:sp>';

  // nvSpPr
  xml += '<p:nvSpPr>';
  xml += `<p:cNvPr id="${shape.id}" name="${escXml(shape.name)}"/>`;
  xml += '<p:cNvSpPr/>';
  xml += '<p:nvPr>';
  if (shape.placeholderType) {
    xml += `<p:ph type="${shape.placeholderType}"`;
    if (shape.placeholderIdx !== undefined) xml += ` idx="${shape.placeholderIdx}"`;
    xml += '/>';
  }
  xml += '</p:nvPr>';
  xml += '</p:nvSpPr>';

  // spPr
  xml += '<p:spPr>';
  xml += serializeTransform(shape.transform);
  xml += `<a:prstGeom prst="${shape.geometry}"><a:avLst/></a:prstGeom>`;
  xml += serializeFill(shape.fill);
  xml += serializeLine(shape.line);
  xml += '</p:spPr>';

  // txBody
  if (shape.textBody) {
    xml += serializeTextBody(shape.textBody);
  }

  xml += '</p:sp>';
  return xml;
}

function serializePicture(pic: PictureElement): string {
  let xml = '<p:pic>';

  xml += '<p:nvPicPr>';
  xml += `<p:cNvPr id="${pic.id}" name="${escXml(pic.name)}"/>`;
  xml += '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>';
  xml += '<p:nvPr/>';
  xml += '</p:nvPicPr>';

  xml += '<p:blipFill>';
  xml += `<a:blip r:embed="${pic.rId}"/>`;
  xml += '<a:stretch><a:fillRect/></a:stretch>';
  xml += '</p:blipFill>';

  xml += '<p:spPr>';
  xml += serializeTransform(pic.transform);
  xml += '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  xml += serializeLine(pic.line);
  xml += '</p:spPr>';

  xml += '</p:pic>';
  return xml;
}

function serializeGroup(group: GroupElement): string {
  let xml = '<p:grpSp>';

  xml += '<p:nvGrpSpPr>';
  xml += `<p:cNvPr id="${group.id}" name="${escXml(group.name)}"/>`;
  xml += '<p:cNvGrpSpPr/>';
  xml += '<p:nvPr/>';
  xml += '</p:nvGrpSpPr>';

  xml += '<p:grpSpPr>';
  xml += serializeTransform(group.transform);
  if (group.childTransform) {
    xml += `<a:chOff x="${group.childTransform.x}" y="${group.childTransform.y}"/>`;
    xml += `<a:chExt cx="${group.childTransform.width}" cy="${group.childTransform.height}"/>`;
  }
  xml += '</p:grpSpPr>';

  for (const child of group.children) {
    xml += serializeElement(child);
  }

  xml += '</p:grpSp>';
  return xml;
}

function serializeTable(table: TableElement): string {
  let xml = '<p:graphicFrame>';

  xml += '<p:nvGraphicFramePr>';
  xml += `<p:cNvPr id="${table.id}" name="${escXml(table.name)}"/>`;
  xml += '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>';
  xml += '<p:nvPr/>';
  xml += '</p:nvGraphicFramePr>';

  xml += serializeTransform(table.transform);

  xml += '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">';
  xml += '<a:tbl>';
  xml += '<a:tblPr firstRow="1" bandRow="1"/>';

  // Grid
  xml += '<a:tblGrid>';
  for (const w of table.columns) {
    xml += `<a:gridCol w="${w}"/>`;
  }
  xml += '</a:tblGrid>';

  // Rows
  for (const row of table.rows) {
    xml += `<a:tr h="${row.height}">`;
    for (const cell of row.cells) {
      let tcAttrs = '';
      if (cell.rowSpan) tcAttrs += ` rowSpan="${cell.rowSpan}"`;
      if (cell.colSpan) tcAttrs += ` gridSpan="${cell.colSpan}"`;
      xml += `<a:tc${tcAttrs}>`;
      if (cell.textBody) {
        // Re-use text body serializer with a: namespace (table cells use a: not p:)
        xml += serializeTextBody(cell.textBody).replace(/p:txBody/g, 'a:txBody');
      } else {
        xml += '<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></a:txBody>';
      }
      xml += '<a:tcPr>';
      xml += serializeFill(cell.fill);
      xml += '</a:tcPr>';
      xml += '</a:tc>';
    }
    xml += '</a:tr>';
  }

  xml += '</a:tbl>';
  xml += '</a:graphicData></a:graphic>';
  xml += '</p:graphicFrame>';
  return xml;
}

function serializeElement(el: SlideElement): string {
  switch (el.type) {
    case 'shape': return serializeShape(el);
    case 'picture': return serializePicture(el);
    case 'group': return serializeGroup(el);
    case 'table': return serializeTable(el);
  }
}

// ── Full Slide XML ───────────────────────────────────────────────────────────

function buildSlideXml(slide: Slide): string {
  let bgXml = '';
  if (slide.background?.fill) {
    bgXml = `<p:bg><p:bgPr>${serializeFill(slide.background.fill)}<a:effectLst/></p:bgPr></p:bg>`;
  }

  let elementsXml = '';
  for (const el of slide.elements) {
    elementsXml += serializeElement(el);
  }

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:cSld>'
    + bgXml
    + '<p:spTree>'
    + '<p:nvGrpSpPr>'
    + '<p:cNvPr id="1" name=""/>'
    + '<p:cNvGrpSpPr/>'
    + '<p:nvPr/>'
    + '</p:nvGrpSpPr>'
    + '<p:grpSpPr>'
    + '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>'
    + '</p:grpSpPr>'
    + elementsXml
    + '</p:spTree>'
    + '</p:cSld>'
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
    + '</p:sld>';
}

// ── Main Serialize Function ──────────────────────────────────────────────────

/**
 * Serialize a modified Presentation back to a PPTX ArrayBuffer.
 *
 * @param presentation - The presentation model with changes applied.
 * @param modifiedSlideIndices - Set of 0-based slide indices whose XML
 *   should be regenerated. Slides not in this set will keep their original
 *   rawXml (lossless round-trip).
 */
function collectPictures(elements: SlideElement[], pictures: PictureElement[] = []): PictureElement[] {
  for (const element of elements) {
    if (element.type === 'picture') {
      pictures.push(element);
    } else if (element.type === 'group') {
      collectPictures(element.children, pictures);
    }
  }
  return pictures;
}

function dataUriToUint8Array(dataUri: string): Uint8Array {
  const [, base64 = ''] = dataUri.split(',');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function mediaPathToRelationshipTarget(mediaPath: string): string {
  return mediaPath.startsWith('ppt/media/')
    ? `../media/${mediaPath.substring('ppt/media/'.length)}`
    : mediaPath;
}

async function ensureImageRelationship(zip: JSZip, slide: Slide, picture: PictureElement): Promise<void> {
  if (!picture.rId || !picture.mediaPath) return;

  const target = mediaPathToRelationshipTarget(picture.mediaPath);
  const rel = `<Relationship Id="${picture.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  const fallbackXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '</Relationships>';
  const existing = zip.file(slide.relsPath);
  const xml = existing ? await existing.async('string') : fallbackXml;
  if (xml.includes(`Id="${picture.rId}"`) || xml.includes(`Id='${picture.rId}'`)) return;

  const updated = xml.includes('</Relationships>')
    ? xml.replace('</Relationships>', `${rel}</Relationships>`)
    : fallbackXml.replace('</Relationships>', `${rel}</Relationships>`);
  zip.file(slide.relsPath, updated);
}

function contentTypeForExtension(ext: string): string | null {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };
  return map[ext.toLowerCase()] ?? null;
}

async function ensureContentType(zip: JSZip, mediaPath: string): Promise<void> {
  const ext = mediaPath.split('.').pop()?.toLowerCase();
  if (!ext) return;
  const type = contentTypeForExtension(ext);
  if (!type) return;

  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!contentTypesFile) return;
  const xml = await contentTypesFile.async('string');
  if (xml.includes(`Extension="${ext}"`) || xml.includes(`Extension='${ext}'`)) return;

  const defaultEntry = `<Default Extension="${ext}" ContentType="${type}"/>`;
  const updated = xml.includes('</Types>')
    ? xml.replace('</Types>', `${defaultEntry}</Types>`)
    : xml;
  zip.file('[Content_Types].xml', updated);
}

async function persistSlideMedia(zip: JSZip, slide: Slide): Promise<void> {
  const pictures = collectPictures(slide.elements);
  for (const picture of pictures) {
    if (picture.mediaPath && picture.dataUri?.startsWith('data:')) {
      zip.file(picture.mediaPath, dataUriToUint8Array(picture.dataUri));
      await ensureContentType(zip, picture.mediaPath);
    }
    await ensureImageRelationship(zip, slide, picture);
  }
}

export async function serializePptx(
  presentation: Presentation,
  modifiedSlideIndices: Set<number> = new Set(),
): Promise<ArrayBuffer> {
  const zip = presentation.zipInstance as JSZip;
  if (!zip) {
    throw new Error('Cannot serialize: no ZIP instance available. Parse the presentation first.');
  }

  // Update only modified slides
  for (let i = 0; i < presentation.slides.length; i++) {
    const slide = presentation.slides[i];
    if (modifiedSlideIndices.has(i)) {
      // Re-generate this slide's XML from the model
      const xml = buildSlideXml(slide);
      zip.file(slide.xmlPath, xml);
      await persistSlideMedia(zip, slide);
    }
    // If not modified, the original rawXml is already in the zip; do nothing.
  }

  // Generate the output buffer
  const buffer = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return buffer;
}

// ── New Slide Helper ─────────────────────────────────────────────────────────

/**
 * Create a new blank slide model with a title and optional subtitle.
 */
export function createBlankSlide(
  number: number,
  title: string = '',
  subtitle: string = '',
): Slide {
  const elements: SlideElement[] = [];

  // Title text box
  if (title || true) {
    elements.push({
      type: 'shape',
      id: `new_title_${number}`,
      name: 'Title',
      transform: { x: 457200, y: 274638, width: 8229600, height: 1143000 },
      geometry: 'rect',
      fill: { type: 'none' },
      textBody: {
        paragraphs: [
          {
            children: [
              {
                text: title || 'Click to add title',
                properties: { fontSize: 4400, bold: true },
              },
            ],
            properties: { alignment: 'center' },
          },
        ],
        bodyProperties: { anchor: 'middle' },
      },
      placeholderType: 'title',
    });
  }

  // Subtitle text box
  elements.push({
    type: 'shape',
    id: `new_subtitle_${number}`,
    name: 'Subtitle',
    transform: { x: 457200, y: 1600200, width: 8229600, height: 4525963 },
    geometry: 'rect',
    fill: { type: 'none' },
    textBody: {
      paragraphs: [
        {
          children: [
            {
              text: subtitle || 'Click to add text',
              properties: { fontSize: 2400 },
            },
          ],
        },
      ],
      bodyProperties: { anchor: 'top' },
    },
    placeholderType: 'body',
  });

  return {
    number,
    xmlPath: `ppt/slides/slide${number}.xml`,
    relsPath: `ppt/slides/_rels/slide${number}.xml.rels`,
    elements,
  };
}
