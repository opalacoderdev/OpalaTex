/**
 * OMML -> MathML
 *
 * Word stores equations as Office Math Markup Language (ECMA-376 Part 1,
 * §22.1). Browsers render MathML, and the equation editor edits MathML, so
 * every equation that comes out of a .docx passes through here first.
 *
 * The conversion is structural, not semantic: each OMML construct maps onto
 * the MathML element that lays out the same way. Properties OMML carries but
 * MathML has no room for (`m:ctrlPr` run formatting, justification hints) are
 * dropped here on purpose — the document model keeps the original OMML
 * verbatim and only regenerates it for equations the user actually edits, so
 * nothing is lost by this direction being lossy.
 */

import {
  parseXml,
  getChildElements,
  getLocalName,
  getTextContent,
  type XmlElement,
} from '../docx/xmlParser';
import {
  NARY_OPERATORS,
  OMML_DEFAULTS,
  escapeXmlAttr,
  escapeXmlText,
  tokenizeMathText,
  wrapRow,
} from './shared';

export interface OmmlToMathmlOptions {
  /**
   * `block` renders as a displayed equation (`display="block"`), which is what
   * `m:oMathPara` means. Defaults to the display implied by the OMML root.
   */
  display?: 'inline' | 'block';
}

/** Run-level formatting an `m:rPr` can impose on the literals of a run. */
interface RunStyle {
  upright: boolean;
  bold: boolean;
  /** `m:scr` alphabet (double-struck, script, fraktur, ...), if any. */
  script: string | null;
}

const DEFAULT_RUN_STYLE: RunStyle = { upright: false, bold: false, script: null };

/**
 * Convert an OMML fragment (`m:oMath` or `m:oMathPara`) to a MathML `<math>`
 * element. Returns an empty string when the input cannot be parsed — callers
 * render their plain-text fallback in that case rather than failing the page.
 */
export function ommlToMathml(ommlXml: string, options: OmmlToMathmlOptions = {}): string {
  const root = parseOmmlRoot(ommlXml);
  if (!root) return '';

  const isPara = getLocalName(root.name ?? '') === 'oMathPara';
  const display = options.display ?? (isPara ? 'block' : 'inline');
  const body = wrapRow(convertChildren(root));

  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display}">${body}</math>`;
}

/** Parse the OMML string and return its `m:oMath`/`m:oMathPara` root. */
function parseOmmlRoot(ommlXml: string): XmlElement | null {
  const trimmed = (ommlXml || '').trim();
  if (!trimmed) return null;

  try {
    const doc = parseXml(trimmed);
    const [first] = getChildElements(doc);
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Convert every convertible child of a container element, one entry per MathML
 * node. A single `m:r` can yield several tokens (`2a` is `mn` + `mi`), and the
 * count matters: `mfrac` and friends take a fixed number of children, so a slot
 * that produced two nodes has to end up inside one `mrow`.
 */
function convertChildren(parent: XmlElement | null | undefined): string[] {
  const out: string[] = [];
  for (const child of getChildElements(parent)) {
    out.push(...convertElementNodes(child));
  }
  return out;
}

/** Convert one OMML slot (`m:e`, `m:num`, `m:sup`, ...) into a single node. */
function convertSlot(slot: XmlElement | null | undefined): string {
  return wrapRow(convertChildren(slot));
}

function childByName(parent: XmlElement | null | undefined, localName: string): XmlElement | null {
  for (const child of getChildElements(parent)) {
    if (getLocalName(child.name ?? '') === localName) return child;
  }
  return null;
}

function childrenByName(parent: XmlElement | null | undefined, localName: string): XmlElement[] {
  return getChildElements(parent).filter((child) => getLocalName(child.name ?? '') === localName);
}

/**
 * Read an OMML property value (`<m:chr m:val="∑"/>`). Returns `null` when the
 * property element is absent and `''` when it is present but empty, which OMML
 * uses to mean "no glyph" (a `\left.` style invisible fence).
 */
function propValue(
  parent: XmlElement | null | undefined,
  localName: string
): string | null {
  const el = childByName(parent, localName);
  if (!el) return null;
  const attrs = (el.attributes ?? {}) as Record<string, string>;
  const raw = attrs['m:val'] ?? attrs['val'] ?? attrs['w:val'];
  return raw === undefined ? '' : String(raw);
}

/** OMML on/off property: present with no value, or an explicit truthy value. */
function propFlag(parent: XmlElement | null | undefined, localName: string): boolean {
  const value = propValue(parent, localName);
  if (value === null) return false;
  return value === '' || value === '1' || value === 'true' || value === 'on';
}

function runStyleOf(runEl: XmlElement): RunStyle {
  const rPr = childByName(runEl, 'rPr');
  if (!rPr) return DEFAULT_RUN_STYLE;

  // `m:nor` means "normal text": the run is prose inside the equation and is
  // never italicised as a variable.
  if (propFlag(rPr, 'nor')) return { upright: true, bold: false, script: null };

  const sty = propValue(rPr, 'sty');
  const script = propValue(rPr, 'scr');
  return {
    upright: sty === 'p' || sty === 'b',
    bold: sty === 'b' || sty === 'bi',
    script: script && script !== 'roman' ? script : null,
  };
}

/**
 * MathML `mathvariant` for a token, or `null` when the default rendering
 * already matches. A single-letter `mi` is italic by default and a multi-letter
 * one is upright, so only the departures from that need an attribute.
 */
function mathVariantFor(tag: string, text: string, style: RunStyle): string | null {
  if (style.script) {
    const variant = SCRIPT_VARIANTS[style.script];
    if (variant) return style.bold ? boldVariant(variant) : variant;
  }

  if (tag !== 'mi') return style.bold ? 'bold' : null;

  const defaultsItalic = [...text].length === 1;
  if (style.upright) return style.bold ? 'bold' : defaultsItalic ? 'normal' : null;
  if (style.bold) return defaultsItalic ? 'bold-italic' : 'bold-italic';
  return defaultsItalic ? null : 'italic';
}

const SCRIPT_VARIANTS: Record<string, string> = {
  'double-struck': 'double-struck',
  script: 'script',
  fraktur: 'fraktur',
  'sans-serif': 'sans-serif',
  monospace: 'monospace',
};

function boldVariant(variant: string): string {
  if (variant === 'double-struck' || variant === 'monospace') return variant;
  return `bold-${variant}`;
}

function token(tag: string, text: string, style: RunStyle): string {
  const variant = mathVariantFor(tag, text, style);
  const attr = variant ? ` mathvariant="${escapeXmlAttr(variant)}"` : '';
  const extra = tag === 'mo' && NARY_OPERATORS.has(text) ? ' largeop="true"' : '';
  return `<${tag}${attr}${extra}>${escapeXmlText(text)}</${tag}>`;
}

/** Convert a math run (`m:r`): its literals become MathML token elements. */
function convertRun(runEl: XmlElement): string[] {
  const style = runStyleOf(runEl);
  const parts: string[] = [];

  for (const child of getChildElements(runEl)) {
    const name = getLocalName(child.name ?? '');
    if (name === 't') {
      const text = getTextContent(child);
      for (const tok of tokenizeMathText(text)) {
        parts.push(token(tok.tag, tok.text, style));
      }
    } else if (name === 'br') {
      parts.push('<mspace linebreak="newline"></mspace>');
    }
  }

  return parts;
}

/** Convert a WordprocessingML run that Word allowed inside the equation. */
function convertTextRun(runEl: XmlElement): string[] {
  const parts: string[] = [];
  for (const child of getChildElements(runEl)) {
    if (getLocalName(child.name ?? '') !== 't') continue;
    const text = getTextContent(child);
    if (text) parts.push(`<mtext>${escapeXmlText(text)}</mtext>`);
  }
  return parts;
}

/** Convert one OMML element into the MathML nodes it stands for. */
function convertElementNodes(el: XmlElement): string[] {
  const name = getLocalName(el.name ?? '');

  // Property elements are read by their owning construct, never walked into.
  if (name.endsWith('Pr')) return [];

  if (name === 'r') {
    return el.name?.startsWith('w:') ? convertTextRun(el) : convertRun(el);
  }

  // A container passes its children through unwrapped, so the slot that holds
  // it sees the real node count.
  if (name === 'oMath' || name === 'oMathPara') return convertChildren(el);

  const converted = convertElement(el);
  return converted ? [converted] : [];
}

function convertElement(el: XmlElement): string {
  const name = getLocalName(el.name ?? '');

  switch (name) {
    case 'oMath':
    case 'oMathPara':
      return wrapRow(convertChildren(el));

    case 'f':
      return convertFraction(el);
    case 'sSup':
      return `<msup>${convertSlot(childByName(el, 'e'))}${convertSlot(childByName(el, 'sup'))}</msup>`;
    case 'sSub':
      return `<msub>${convertSlot(childByName(el, 'e'))}${convertSlot(childByName(el, 'sub'))}</msub>`;
    case 'sSubSup':
      return (
        `<msubsup>${convertSlot(childByName(el, 'e'))}` +
        `${convertSlot(childByName(el, 'sub'))}${convertSlot(childByName(el, 'sup'))}</msubsup>`
      );
    case 'sPre':
      return convertPreScript(el);
    case 'rad':
      return convertRadical(el);
    case 'nary':
      return convertNary(el);
    case 'd':
      return convertDelimiter(el);
    case 'm':
      return convertMatrix(el);
    case 'eqArr':
      return convertEquationArray(el);
    case 'acc':
      return convertAccent(el);
    case 'bar':
      return convertBar(el);
    case 'groupChr':
      return convertGroupChar(el);
    case 'limLow':
      return `<munder>${convertSlot(childByName(el, 'e'))}${convertSlot(childByName(el, 'lim'))}</munder>`;
    case 'limUpp':
      return `<mover>${convertSlot(childByName(el, 'e'))}${convertSlot(childByName(el, 'lim'))}</mover>`;
    case 'func':
      return convertFunction(el);
    case 'box':
      return convertSlot(childByName(el, 'e'));
    case 'borderBox':
      return `<menclose notation="box">${convertSlot(childByName(el, 'e'))}</menclose>`;
    case 'phant':
      return `<mphantom>${convertSlot(childByName(el, 'e'))}</mphantom>`;

    // Containers that only appear as a slot of something else. Reached only
    // when the OMML is malformed; treating them as a row keeps their content.
    case 'e':
    case 'num':
    case 'den':
    case 'sup':
    case 'sub':
    case 'deg':
    case 'lim':
    case 'fName':
      return convertSlot(el);

    default:
      // Unknown construct: keep whatever content it holds rather than dropping
      // the equation's text on the floor.
      return wrapRow(convertChildren(el));
  }
}

function convertFraction(el: XmlElement): string {
  const type = propValue(childByName(el, 'fPr'), 'type') ?? 'bar';
  const num = convertSlot(childByName(el, 'num'));
  const den = convertSlot(childByName(el, 'den'));

  if (type === 'lin') return `<mrow>${num}<mo>/</mo>${den}</mrow>`;
  if (type === 'skw') return `<mfrac bevelled="true">${num}${den}</mfrac>`;
  // `noBar` is Word's stacked pair — a binomial coefficient without a rule.
  if (type === 'noBar') return `<mfrac linethickness="0">${num}${den}</mfrac>`;
  return `<mfrac>${num}${den}</mfrac>`;
}

function convertPreScript(el: XmlElement): string {
  const base = convertSlot(childByName(el, 'e'));
  const sub = childByName(el, 'sub');
  const sup = childByName(el, 'sup');
  const preSub = sub ? convertSlot(sub) : '<none></none>';
  const preSup = sup ? convertSlot(sup) : '<none></none>';
  return `<mmultiscripts>${base}<mprescripts></mprescripts>${preSub}${preSup}</mmultiscripts>`;
}

function convertRadical(el: XmlElement): string {
  const radPr = childByName(el, 'radPr');
  const degEl = childByName(el, 'deg');
  const base = convertSlot(childByName(el, 'e'));
  const degreeEmpty = !degEl || getChildElements(degEl).length === 0;

  if (propFlag(radPr, 'degHide') || degreeEmpty) return `<msqrt>${base}</msqrt>`;
  return `<mroot>${base}${convertSlot(degEl)}</mroot>`;
}

function convertNary(el: XmlElement): string {
  const naryPr = childByName(el, 'naryPr');
  const chr = propValue(naryPr, 'chr') ?? OMML_DEFAULTS.naryChr;
  const limLoc = propValue(naryPr, 'limLoc') ?? OMML_DEFAULTS.naryLimLoc;
  const subHidden = propFlag(naryPr, 'subHide');
  const supHidden = propFlag(naryPr, 'supHide');

  const subEl = subHidden ? null : childByName(el, 'sub');
  const supEl = supHidden ? null : childByName(el, 'sup');
  const hasSub = !!subEl && getChildElements(subEl).length > 0;
  const hasSup = !!supEl && getChildElements(supEl).length > 0;

  const operator = `<mo largeop="true" movablelimits="false">${escapeXmlText(chr)}</mo>`;
  const under = limLoc === 'undOvr';

  let script = operator;
  if (hasSub && hasSup) {
    const tag = under ? 'munderover' : 'msubsup';
    script = `<${tag}>${operator}${convertSlot(subEl)}${convertSlot(supEl)}</${tag}>`;
  } else if (hasSub) {
    const tag = under ? 'munder' : 'msub';
    script = `<${tag}>${operator}${convertSlot(subEl)}</${tag}>`;
  } else if (hasSup) {
    const tag = under ? 'mover' : 'msup';
    script = `<${tag}>${operator}${convertSlot(supEl)}</${tag}>`;
  }

  const body = convertSlot(childByName(el, 'e'));
  return `<mrow>${script}${body}</mrow>`;
}

function convertDelimiter(el: XmlElement): string {
  const dPr = childByName(el, 'dPr');
  const beg = propValue(dPr, 'begChr') ?? OMML_DEFAULTS.delimiterBegin;
  const end = propValue(dPr, 'endChr') ?? OMML_DEFAULTS.delimiterEnd;
  const sep = propValue(dPr, 'sepChr') ?? OMML_DEFAULTS.delimiterSeparator;

  const parts: string[] = [];
  if (beg) parts.push(`<mo fence="true" stretchy="true">${escapeXmlText(beg)}</mo>`);

  const slots = childrenByName(el, 'e');
  slots.forEach((slot, index) => {
    if (index > 0 && sep) {
      parts.push(`<mo separator="true" stretchy="true">${escapeXmlText(sep)}</mo>`);
    }
    parts.push(convertSlot(slot));
  });

  if (end) parts.push(`<mo fence="true" stretchy="true">${escapeXmlText(end)}</mo>`);
  return `<mrow>${parts.join('')}</mrow>`;
}

function convertMatrix(el: XmlElement): string {
  const rows = childrenByName(el, 'mr').map((row) => {
    const cells = childrenByName(row, 'e').map((cell) => `<mtd>${convertSlot(cell)}</mtd>`);
    return `<mtr>${cells.join('')}</mtr>`;
  });
  return `<mtable>${rows.join('')}</mtable>`;
}

function convertEquationArray(el: XmlElement): string {
  const rows = childrenByName(el, 'e').map((row) => `<mtr><mtd>${convertSlot(row)}</mtd></mtr>`);
  return `<mtable columnalign="left">${rows.join('')}</mtable>`;
}

function convertAccent(el: XmlElement): string {
  const chr = propValue(childByName(el, 'accPr'), 'chr') || OMML_DEFAULTS.accentChr;
  const base = convertSlot(childByName(el, 'e'));
  return `<mover accent="true">${base}<mo stretchy="false">${escapeXmlText(chr)}</mo></mover>`;
}

function convertBar(el: XmlElement): string {
  const pos = propValue(childByName(el, 'barPr'), 'pos') ?? 'bot';
  const base = convertSlot(childByName(el, 'e'));
  if (pos === 'top') {
    return `<mover accent="true">${base}<mo stretchy="true">${OMML_DEFAULTS.barTop}</mo></mover>`;
  }
  return `<munder accent="true">${base}<mo stretchy="true">${OMML_DEFAULTS.barBottom}</mo></munder>`;
}

function convertGroupChar(el: XmlElement): string {
  const groupChrPr = childByName(el, 'groupChrPr');
  const chr = propValue(groupChrPr, 'chr') || OMML_DEFAULTS.groupChr;
  const pos = propValue(groupChrPr, 'pos') ?? 'bot';
  const base = convertSlot(childByName(el, 'e'));
  const tag = pos === 'top' ? 'mover' : 'munder';
  return `<${tag} accent="true">${base}<mo stretchy="true">${escapeXmlText(chr)}</mo></${tag}>`;
}

function convertFunction(el: XmlElement): string {
  const name = convertSlot(childByName(el, 'fName'));
  const body = convertSlot(childByName(el, 'e'));
  // U+2061 APPLY FUNCTION is invisible; it gives the browser the spacing of a
  // function application instead of a juxtaposition.
  return `<mrow>${name}<mo>&#x2061;</mo>${body}</mrow>`;
}
