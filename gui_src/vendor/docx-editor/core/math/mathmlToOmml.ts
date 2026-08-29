/**
 * MathML -> OMML
 *
 * This is the direction that writes into the .docx, so it decides what Word,
 * LibreOffice, and Pages will see. It runs only for equations the user edited:
 * an untouched equation keeps the OMML it arrived with, byte for byte, so the
 * properties MathML cannot express (`m:ctrlPr`, alignment hints, `m:limLoc`
 * variants a document relies on) survive as long as nobody rewrites them.
 *
 * The mapping is the inverse of `ommlToMathml`, plus the two inferences MathML
 * forces on us: an `munderover` over a summation sign has to become `m:nary`
 * again, and an `mrow` that opens and closes with fences has to become `m:d` —
 * MathML expresses both as ordinary containers.
 */

import { parseXml, getChildElements, getLocalName, getTextContent, type XmlElement } from '../docx/xmlParser';
import { FENCE_PAIRS, NARY_OPERATORS, escapeXmlAttr, escapeXmlText } from './shared';

export interface MathmlToOmmlOptions {
  /** `block` wraps the result in `m:oMathPara`, Word's displayed equation. */
  display?: 'inline' | 'block';
  /** Justification for a block equation (`m:oMathParaPr/m:jc`). */
  justification?: 'left' | 'center' | 'right' | 'centerGroup';
}

/** Invisible operators MathML uses for spacing; OMML has no place for them. */
const INVISIBLE_OPERATORS = new Set(['⁡', '⁢', '⁣', '⁤']);

/** Accent glyphs that mean "overbar"/"underbar" rather than a diacritic. */
const BAR_TOP_CHARS = new Set(['¯', '‾', '̅']);
const BAR_BOTTOM_CHARS = new Set(['_', '̲', '▁']);
/** Horizontal braces/brackets Word models as `m:groupChr`. */
const GROUP_CHARS = new Set(['⏞', '⏟', '⏜', '⏝', '⎴', '⎵']);

/**
 * The named entities a MathML producer is most likely to emit. XML has only
 * five built-in names, so anything else has to be resolved before parsing.
 */
const NAMED_ENTITIES: Record<string, string> = {
  ApplyFunction: '⁡',
  af: '⁡',
  InvisibleTimes: '⁢',
  it: '⁢',
  InvisibleComma: '⁣',
  ic: '⁣',
  nbsp: ' ',
  NonBreakingSpace: ' ',
  Sum: '∑',
  Product: '∏',
  Integral: '∫',
  PlusMinus: '±',
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  infin: '∞',
  radic: '√',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  phi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Gamma: 'Γ',
  Lambda: 'Λ',
  Omega: 'Ω',
  Sigma: 'Σ',
  Phi: 'Φ',
};

const NAMED_ENTITY_RE = /&([A-Za-z][A-Za-z0-9]*);/g;
const XML_BUILTIN_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/**
 * Resolve named entities the XML parser would reject. An unknown name is
 * escaped rather than dropped: the user then sees the literal `&foo;` in the
 * equation and can fix it, which beats silently losing a symbol.
 */
function resolveNamedEntities(mathml: string): string {
  return mathml.replace(NAMED_ENTITY_RE, (match, name: string) => {
    if (XML_BUILTIN_ENTITIES.has(name)) return match;
    const resolved = NAMED_ENTITIES[name];
    if (resolved) return resolved;
    return `&amp;${name};`;
  });
}

/** Formatting of one literal token, as OMML run properties express it. */
interface OmmlRunStyle {
  /** `m:sty` value, or null for OMML's default (italic). */
  sty: 'p' | 'b' | 'i' | 'bi' | null;
  /** `m:scr` alphabet, when the MathML asked for one. */
  scr: string | null;
}

/**
 * Convert a MathML `<math>` fragment into OMML. Returns an empty string when
 * the MathML cannot be parsed, which callers treat as "keep what you had".
 */
export function mathmlToOmml(mathml: string, options: MathmlToOmmlOptions = {}): string {
  const root = parseMathmlRoot(mathml);
  if (!root) return '';

  const declaredDisplay = (root.attributes?.display as string | undefined) === 'block' ? 'block' : 'inline';
  const display = options.display ?? declaredDisplay;
  const body = convertSequence(getChildElements(root));
  const oMath = `<m:oMath>${body}</m:oMath>`;

  if (display !== 'block') return oMath;

  const jc = options.justification ?? 'center';
  return `<m:oMathPara><m:oMathParaPr><m:jc m:val="${escapeXmlAttr(jc)}"/></m:oMathParaPr>${oMath}</m:oMathPara>`;
}

function parseMathmlRoot(mathml: string): XmlElement | null {
  const trimmed = (mathml || '').trim();
  if (!trimmed) return null;

  try {
    const doc = parseXml(resolveNamedEntities(trimmed));
    const [first] = getChildElements(doc);
    if (!first) return null;
    // A caller may hand us the children of <math> instead of the element.
    return getLocalName(first.name ?? '') === 'math' ? first : wrapAsMath(getChildElements(doc));
  } catch {
    return null;
  }
}

function wrapAsMath(children: XmlElement[]): XmlElement {
  return { type: 'element', name: 'math', elements: children };
}

function localName(el: XmlElement): string {
  return getLocalName(el.name ?? '');
}

function attr(el: XmlElement | null | undefined, name: string): string | null {
  if (!el || !el.attributes) return null;
  const value = (el.attributes as Record<string, string>)[name];
  return value === undefined ? null : String(value);
}

/** Convert a run of sibling MathML nodes into a sequence of OMML elements. */
function convertSequence(nodes: XmlElement[]): string {
  const fenced = convertFencedRow(nodes);
  if (fenced !== null) return fenced;

  const out: string[] = [];
  /** Literals waiting to be flushed as one `m:r`, all sharing one style. */
  let pending: { style: OmmlRunStyle; text: string } | null = null;

  const flush = (): void => {
    if (pending && pending.text) out.push(runElement(pending.text, pending.style));
    pending = null;
  };

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];

    // An n-ary operator owns everything that follows it in the row: MathML
    // writes the integrand as a sibling of the `msubsup`, OMML nests it in
    // `m:e`. Absorbing the rest here is what makes `∫ f(x)dx` survive a
    // round-trip with the same shape it arrived in.
    const nary = naryInfo(node);
    if (nary) {
      flush();
      const body = convertSequence(nodes.slice(index + 1));
      out.push(naryElement(nary.chr, nary.limLoc, nary.sub, nary.sup, body));
      return out.join('');
    }

    // U+2061 APPLY FUNCTION marks `name(argument)`, which is Word's `m:func`.
    // Rebuilding it keeps `lim`, `sin`, and friends from decaying into loose
    // runs the next time the equation is edited.
    if (isApplyFunction(node)) {
      flush();
      const name = out.join('');
      out.length = 0;
      const body = convertSequence(nodes.slice(index + 1));
      out.push(`<m:func><m:fName>${name}</m:fName><m:e>${body}</m:e></m:func>`);
      return out.join('');
    }

    const literal = literalOf(node);
    if (literal !== null) {
      if (!literal.text) continue;
      if (pending && sameStyle(pending.style, literal.style)) {
        pending.text += literal.text;
      } else {
        flush();
        pending = { style: literal.style, text: literal.text };
      }
      continue;
    }

    flush();
    const converted = convertElement(node);
    if (converted) out.push(converted);
  }

  flush();
  return out.join('');
}

/** True for the invisible APPLY FUNCTION operator MathML puts after a name. */
function isApplyFunction(el: XmlElement): boolean {
  return localName(el) === 'mo' && getTextContent(el).trim() === '\u2061';
}

function sameStyle(a: OmmlRunStyle, b: OmmlRunStyle): boolean {
  return a.sty === b.sty && a.scr === b.scr;
}

/** The literal text of a token element, or null when the node is a construct. */
function literalOf(el: XmlElement): { text: string; style: OmmlRunStyle } | null {
  const name = localName(el);
  if (name !== 'mi' && name !== 'mn' && name !== 'mo' && name !== 'mtext' && name !== 'ms') {
    return null;
  }

  const raw = getTextContent(el);
  const text = [...raw].filter((ch) => !INVISIBLE_OPERATORS.has(ch)).join('');
  return { text, style: styleOf(name, text, attr(el, 'mathvariant')) };
}

/**
 * Map a MathML token plus its `mathvariant` back onto OMML run properties.
 *
 * OMML's default for a math run is italic, so only `mi` with a single letter
 * can leave the properties off; every other token has to say `m:sty="p"` or
 * Word will italicise digits and operators.
 */
function styleOf(tag: string, text: string, mathvariant: string | null): OmmlRunStyle {
  if (mathvariant) {
    switch (mathvariant) {
      case 'normal':
        return { sty: 'p', scr: null };
      case 'bold':
        return { sty: 'b', scr: null };
      case 'italic':
        return { sty: 'i', scr: null };
      case 'bold-italic':
        return { sty: 'bi', scr: null };
      case 'double-struck':
      case 'script':
      case 'fraktur':
      case 'sans-serif':
      case 'monospace':
        return { sty: 'p', scr: mathvariant };
      case 'bold-script':
        return { sty: 'b', scr: 'script' };
      case 'bold-fraktur':
        return { sty: 'b', scr: 'fraktur' };
      case 'bold-sans-serif':
        return { sty: 'b', scr: 'sans-serif' };
      default:
        return { sty: 'p', scr: null };
    }
  }

  if (tag === 'mi') {
    // MathML italicises a one-character identifier and leaves longer ones
    // upright; OMML has to state the upright case explicitly.
    return [...text].length === 1 ? { sty: null, scr: null } : { sty: 'p', scr: null };
  }

  return { sty: 'p', scr: null };
}

function runElement(text: string, style: OmmlRunStyle): string {
  const props: string[] = [];
  if (style.scr) props.push(`<m:scr m:val="${escapeXmlAttr(style.scr)}"/>`);
  if (style.sty) props.push(`<m:sty m:val="${style.sty}"/>`);
  const rPr = props.length ? `<m:rPr>${props.join('')}</m:rPr>` : '';
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<m:r>${rPr}<m:t${preserve}>${escapeXmlText(text)}</m:t></m:r>`;
}

/** Wrap converted children as an OMML slot element (`m:e`, `m:num`, ...). */
function slot(tag: string, el: XmlElement | null | undefined): string {
  const content = el ? convertNode(el) : '';
  return `<${tag}>${content}</${tag}>`;
}

/** Convert one node in a position that expects a sequence of OMML elements. */
function convertNode(el: XmlElement): string {
  const name = localName(el);
  if (name === 'mrow' || name === 'mstyle' || name === 'mpadded' || name === 'math') {
    return convertSequence(getChildElements(el));
  }
  return convertSequence([el]);
}

function convertElement(el: XmlElement): string {
  const children = getChildElements(el);

  switch (localName(el)) {
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'math':
    case 'semantics':
      return convertSequence(children);

    case 'mfrac':
      return convertFraction(el, children);
    case 'msup':
      return convertScript(children, 'sup');
    case 'msub':
      return convertScript(children, 'sub');
    case 'msubsup':
      return convertScript(children, 'subSup');
    case 'munder':
      return convertUnderOver(children, 'under');
    case 'mover':
      return convertUnderOver(children, 'over');
    case 'munderover':
      return convertUnderOver(children, 'underover');
    case 'msqrt':
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${convertSequence(children)}</m:e></m:rad>`;
    case 'mroot':
      return `<m:rad><m:deg>${children[1] ? convertNode(children[1]) : ''}</m:deg><m:e>${children[0] ? convertNode(children[0]) : ''}</m:e></m:rad>`;
    case 'mtable':
      return convertTable(children);
    case 'mmultiscripts':
      return convertMultiscripts(children);
    case 'menclose':
      return `<m:borderBox><m:e>${convertSequence(children)}</m:e></m:borderBox>`;
    case 'mphantom':
      return `<m:phant><m:e>${convertSequence(children)}</m:e></m:phant>`;
    case 'mspace':
      return runElement(' ', { sty: 'p', scr: null });
    case 'mfenced':
      return convertLegacyFenced(el, children);
    case 'none':
    case 'mprescripts':
    case 'annotation':
    case 'annotation-xml':
      return '';

    default:
      return convertSequence(children);
  }
}

function convertFraction(el: XmlElement, children: XmlElement[]): string {
  const num = children[0] ? convertNode(children[0]) : '';
  const den = children[1] ? convertNode(children[1]) : '';
  const linethickness = attr(el, 'linethickness');
  const bevelled = attr(el, 'bevelled') === 'true';

  let props = '';
  if (bevelled) props = '<m:fPr><m:type m:val="skw"/></m:fPr>';
  else if (linethickness === '0' || linethickness === '0pt' || linethickness === 'none') {
    props = '<m:fPr><m:type m:val="noBar"/></m:fPr>';
  }

  return `<m:f>${props}<m:num>${num}</m:num><m:den>${den}</m:den></m:f>`;
}

/** The n-ary glyph of a base node, when it is one. */
function naryCharOf(el: XmlElement | undefined): string | null {
  if (!el) return null;
  if (localName(el) === 'mrow') {
    const children = getChildElements(el);
    return children.length === 1 ? naryCharOf(children[0]) : null;
  }
  if (localName(el) !== 'mo') return null;
  const text = getTextContent(el).trim();
  return NARY_OPERATORS.has(text) ? text : null;
}

/** Describe a script node whose base is an n-ary operator, or null. */
function naryInfo(el: XmlElement): {
  chr: string;
  limLoc: 'subSup' | 'undOvr';
  sub: XmlElement | undefined;
  sup: XmlElement | undefined;
} | null {
  const name = localName(el);
  const children = getChildElements(el);
  const chr = naryCharOf(children[0]);
  if (!chr) return null;

  switch (name) {
    case 'msub':
      return { chr, limLoc: 'subSup', sub: children[1], sup: undefined };
    case 'msup':
      return { chr, limLoc: 'subSup', sub: undefined, sup: children[1] };
    case 'msubsup':
      return { chr, limLoc: 'subSup', sub: children[1], sup: children[2] };
    case 'munder':
      return { chr, limLoc: 'undOvr', sub: children[1], sup: undefined };
    case 'mover':
      return { chr, limLoc: 'undOvr', sub: undefined, sup: children[1] };
    case 'munderover':
      return { chr, limLoc: 'undOvr', sub: children[1], sup: children[2] };
    default:
      return null;
  }
}

function naryElement(
  chr: string,
  limLoc: 'subSup' | 'undOvr',
  sub: XmlElement | undefined,
  sup: XmlElement | undefined,
  body: string
): string {
  const props =
    `<m:naryPr><m:chr m:val="${escapeXmlAttr(chr)}"/><m:limLoc m:val="${limLoc}"/>` +
    `${sub ? '' : '<m:subHide m:val="1"/>'}${sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>`;
  const subEl = `<m:sub>${sub ? convertNode(sub) : ''}</m:sub>`;
  const supEl = `<m:sup>${sup ? convertNode(sup) : ''}</m:sup>`;
  return `<m:nary>${props}${subEl}${supEl}<m:e>${body}</m:e></m:nary>`;
}

function convertScript(children: XmlElement[], kind: 'sub' | 'sup' | 'subSup'): string {
  const base = children[0];
  const baseXml = base ? convertNode(base) : '';
  if (kind === 'sub') {
    return `<m:sSub><m:e>${baseXml}</m:e><m:sub>${children[1] ? convertNode(children[1]) : ''}</m:sub></m:sSub>`;
  }
  if (kind === 'sup') {
    return `<m:sSup><m:e>${baseXml}</m:e><m:sup>${children[1] ? convertNode(children[1]) : ''}</m:sup></m:sSup>`;
  }
  return (
    `<m:sSubSup><m:e>${baseXml}</m:e>` +
    `<m:sub>${children[1] ? convertNode(children[1]) : ''}</m:sub>` +
    `<m:sup>${children[2] ? convertNode(children[2]) : ''}</m:sup></m:sSubSup>`
  );
}

/** The single character of a script node, when it is one character. */
function singleCharOf(el: XmlElement | undefined): string | null {
  if (!el) return null;
  if (localName(el) === 'mrow') {
    const children = getChildElements(el);
    return children.length === 1 ? singleCharOf(children[0]) : null;
  }
  const text = getTextContent(el).trim();
  return [...text].length === 1 ? text : null;
}

function convertUnderOver(children: XmlElement[], kind: 'under' | 'over' | 'underover'): string {
  const base = children[0];
  const baseXml = base ? convertNode(base) : '';

  if (kind === 'underover') {
    // No OMML construct carries both limits over a non-operator base; Word
    // nests the two it does have.
    const inner = `<m:limLow><m:e>${baseXml}</m:e><m:lim>${children[1] ? convertNode(children[1]) : ''}</m:lim></m:limLow>`;
    return `<m:limUpp><m:e>${inner}</m:e><m:lim>${children[2] ? convertNode(children[2]) : ''}</m:lim></m:limUpp>`;
  }

  const script = children[1];
  const chr = singleCharOf(script);

  if (chr && GROUP_CHARS.has(chr)) {
    const pos = kind === 'over' ? 'top' : 'bot';
    const vert = kind === 'over' ? 'bot' : 'top';
    return (
      `<m:groupChr><m:groupChrPr><m:chr m:val="${escapeXmlAttr(chr)}"/>` +
      `<m:pos m:val="${pos}"/><m:vertJc m:val="${vert}"/></m:groupChrPr>` +
      `<m:e>${baseXml}</m:e></m:groupChr>`
    );
  }

  if (chr && kind === 'over' && BAR_TOP_CHARS.has(chr)) {
    return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${baseXml}</m:e></m:bar>`;
  }
  if (chr && kind === 'under' && BAR_BOTTOM_CHARS.has(chr)) {
    return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${baseXml}</m:e></m:bar>`;
  }

  if (chr && kind === 'over') {
    return `<m:acc><m:accPr><m:chr m:val="${escapeXmlAttr(chr)}"/></m:accPr><m:e>${baseXml}</m:e></m:acc>`;
  }

  const tag = kind === 'over' ? 'limUpp' : 'limLow';
  return `<m:${tag}><m:e>${baseXml}</m:e><m:lim>${script ? convertNode(script) : ''}</m:lim></m:${tag}>`;
}

function convertTable(children: XmlElement[]): string {
  const rows = children.filter((row) => localName(row) === 'mtr' || localName(row) === 'mlabeledtr');
  const columnCount = rows.reduce(
    (max, row) => Math.max(max, getChildElements(row).filter((c) => localName(c) === 'mtd').length),
    0
  );

  const body = rows
    .map((row) => {
      const cells = getChildElements(row)
        .filter((cell) => localName(cell) === 'mtd')
        .map((cell) => `<m:e>${convertSequence(getChildElements(cell))}</m:e>`);
      return `<m:mr>${cells.join('')}</m:mr>`;
    })
    .join('');

  const columnSpec = `<m:mcs><m:mc><m:mcPr><m:count m:val="${columnCount || 1}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs>`;
  return `<m:m><m:mPr>${columnSpec}</m:mPr>${body}</m:m>`;
}

function convertMultiscripts(children: XmlElement[]): string {
  const separatorIndex = children.findIndex((child) => localName(child) === 'mprescripts');
  if (separatorIndex < 0) {
    // Postscripts only: that is exactly what msubsup expresses.
    return convertScript(children, 'subSup');
  }

  const base = children[0];
  const pre = children.slice(separatorIndex + 1).filter((child) => localName(child) !== 'none');
  const sub = pre[0];
  const sup = pre[1];
  return (
    `<m:sPre><m:sub>${sub ? convertNode(sub) : ''}</m:sub>` +
    `<m:sup>${sup ? convertNode(sup) : ''}</m:sup>` +
    `<m:e>${base ? convertNode(base) : ''}</m:e></m:sPre>`
  );
}

function delimiterElement(beg: string, end: string, sep: string, slots: string[]): string {
  const props: string[] = [];
  if (beg !== '(') props.push(`<m:begChr m:val="${escapeXmlAttr(beg)}"/>`);
  if (end !== ')') props.push(`<m:endChr m:val="${escapeXmlAttr(end)}"/>`);
  if (sep !== '|') props.push(`<m:sepChr m:val="${escapeXmlAttr(sep)}"/>`);
  const dPr = props.length ? `<m:dPr>${props.join('')}</m:dPr>` : '';
  const body = slots.map((content) => `<m:e>${content}</m:e>`).join('');
  return `<m:d>${dPr}${body || '<m:e></m:e>'}</m:d>`;
}

/**
 * Recognise `mo(fence) ... mo(fence)` and rebuild Word's `m:d`.
 *
 * Returns null when the sequence is not fenced, so the caller falls through to
 * the ordinary path.
 */
function convertFencedRow(nodes: XmlElement[]): string | null {
  if (nodes.length < 2) return null;

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (localName(first) !== 'mo') return null;

  const beg = getTextContent(first).trim();
  const isOpen = attr(first, 'fence') === 'true' || beg in FENCE_PAIRS;
  if (!isOpen || !beg) return null;

  const end = localName(last) === 'mo' ? getTextContent(last).trim() : '';
  const closesHere =
    nodes.length > 2 &&
    localName(last) === 'mo' &&
    (attr(last, 'fence') === 'true' || FENCE_PAIRS[beg] === end);

  // An unmatched opener is only treated as a fence when the producer marked it
  // as one — otherwise a stray `(` would swallow the rest of the row.
  if (!closesHere && attr(first, 'fence') !== 'true') return null;

  const inner = closesHere ? nodes.slice(1, -1) : nodes.slice(1);
  const separators = inner.filter((node) => localName(node) === 'mo' && attr(node, 'separator') === 'true');
  const sepChar = separators.length ? getTextContent(separators[0]).trim() : '|';

  const slots: string[] = [];
  let current: XmlElement[] = [];
  for (const node of inner) {
    if (localName(node) === 'mo' && attr(node, 'separator') === 'true') {
      slots.push(convertSequence(current));
      current = [];
      continue;
    }
    current.push(node);
  }
  slots.push(convertSequence(current));

  return delimiterElement(beg, closesHere ? end : '', sepChar, slots);
}

/** MathML 3's `mfenced`, still emitted by older producers. */
function convertLegacyFenced(el: XmlElement, children: XmlElement[]): string {
  const beg = attr(el, 'open') ?? '(';
  const end = attr(el, 'close') ?? ')';
  const sep = (attr(el, 'separators') ?? ',').trim().charAt(0) || ',';
  return delimiterElement(beg, end, sep, children.map((child) => convertNode(child)));
}
