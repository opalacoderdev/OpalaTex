/**
 * MathML -> LaTeX
 *
 * Two jobs. First, it loads an existing equation into the equation editor:
 * MathLive reads LaTeX, not MathML, so a Word equation reaches it as
 * OMML -> MathML -> LaTeX. Second, it is the bridge to the LaTeX side of the
 * application — an equation authored in a .docx can be pasted into a .tex
 * document as source.
 *
 * The output targets what MathLive and a standard LaTeX preamble both accept.
 * Symbols with no command fall through as their literal Unicode character,
 * which MathLive understands and `unicode-math` typesets.
 */

import { parseXml, getChildElements, getLocalName, getTextContent, type XmlElement } from '../docx/xmlParser';
import { NARY_OPERATORS } from './shared';

/** Unicode -> LaTeX for the symbols Word equations actually produce. */
const SYMBOLS: Record<string, string> = {
  '∑': '\\sum',
  '∏': '\\prod',
  '∐': '\\coprod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '⋀': '\\bigwedge',
  '⋁': '\\bigvee',
  '⋂': '\\bigcap',
  '⋃': '\\bigcup',
  '⨁': '\\bigoplus',
  '⨂': '\\bigotimes',
  '⨀': '\\bigodot',
  '±': '\\pm',
  '∓': '\\mp',
  '×': '\\times',
  '÷': '\\div',
  '⋅': '\\cdot',
  '∘': '\\circ',
  '≤': '\\leq',
  '≥': '\\geq',
  '≠': '\\neq',
  '≈': '\\approx',
  '≡': '\\equiv',
  '∼': '\\sim',
  '≅': '\\cong',
  '∝': '\\propto',
  '→': '\\to',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto',
  '∞': '\\infty',
  '∂': '\\partial',
  '∇': '\\nabla',
  '√': '\\surd',
  '∈': '\\in',
  '∉': '\\notin',
  '∋': '\\ni',
  '⊂': '\\subset',
  '⊆': '\\subseteq',
  '⊃': '\\supset',
  '⊇': '\\supseteq',
  '∪': '\\cup',
  '∩': '\\cap',
  '∅': '\\emptyset',
  '∀': '\\forall',
  '∃': '\\exists',
  '¬': '\\neg',
  '∧': '\\land',
  '∨': '\\lor',
  '⊥': '\\perp',
  '∠': '\\angle',
  '…': '\\dots',
  '⋯': '\\cdots',
  '⋮': '\\vdots',
  '⋱': '\\ddots',
  '′': "'",
  'ℝ': '\\mathbb{R}',
  'ℕ': '\\mathbb{N}',
  'ℤ': '\\mathbb{Z}',
  'ℚ': '\\mathbb{Q}',
  'ℂ': '\\mathbb{C}',
  'α': '\\alpha',
  'β': '\\beta',
  'γ': '\\gamma',
  'δ': '\\delta',
  'ε': '\\epsilon',
  'ζ': '\\zeta',
  'η': '\\eta',
  'θ': '\\theta',
  'ϑ': '\\vartheta',
  'ι': '\\iota',
  'κ': '\\kappa',
  'λ': '\\lambda',
  'μ': '\\mu',
  'ν': '\\nu',
  'ξ': '\\xi',
  'π': '\\pi',
  'ρ': '\\rho',
  'σ': '\\sigma',
  'τ': '\\tau',
  'υ': '\\upsilon',
  'φ': '\\phi',
  'ϕ': '\\varphi',
  'χ': '\\chi',
  'ψ': '\\psi',
  'ω': '\\omega',
  'Γ': '\\Gamma',
  'Δ': '\\Delta',
  'Θ': '\\Theta',
  'Λ': '\\Lambda',
  'Ξ': '\\Xi',
  'Π': '\\Pi',
  'Σ': '\\Sigma',
  'Υ': '\\Upsilon',
  'Φ': '\\Phi',
  'Ψ': '\\Psi',
  'Ω': '\\Omega',
};

/** Accent glyphs and the LaTeX command that draws them over a base. */
const ACCENTS: Record<string, string> = {
  '̂': '\\hat',
  '^': '\\hat',
  '̃': '\\tilde',
  '~': '\\tilde',
  '̄': '\\bar',
  '¯': '\\bar',
  '‾': '\\overline',
  '̇': '\\dot',
  '̈': '\\ddot',
  '⃗': '\\vec',
  '̆': '\\breve',
  '̌': '\\check',
  '́': '\\acute',
  '̀': '\\grave',
};

/** `mathvariant` -> the LaTeX alphabet command that reproduces it. */
const VARIANT_COMMANDS: Record<string, string> = {
  normal: '\\mathrm',
  bold: '\\mathbf',
  italic: '\\mathit',
  'bold-italic': '\\boldsymbol',
  'double-struck': '\\mathbb',
  script: '\\mathcal',
  fraktur: '\\mathfrak',
  'sans-serif': '\\mathsf',
  monospace: '\\mathtt',
};

/**
 * Names LaTeX has a command for. `\sin` is not just `sin` in upright type: it
 * also carries the spacing of a function, and `\lim` takes its limit under the
 * name instead of beside it.
 */
const FUNCTION_NAMES = new Set([
  'arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth', 'csc',
  'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'ker', 'lg', 'lim',
  'liminf', 'limsup', 'ln', 'log', 'max', 'min', 'Pr', 'sec', 'sin', 'sinh',
  'sup', 'tan', 'tanh',
]);

/** Characters LaTeX would otherwise read as markup. */
const ESCAPES: Record<string, string> = {
  '\\': '\\backslash ',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  _: '\\_',
  '%': '\\%',
};

const INVISIBLE = new Set(['⁡', '⁢', '⁣', '⁤']);

/** Convert a MathML fragment to LaTeX. Returns '' when it cannot be parsed. */
export function mathmlToLatex(mathml: string): string {
  const trimmed = (mathml || '').trim();
  if (!trimmed) return '';

  let root: XmlElement | null = null;
  try {
    const doc = parseXml(trimmed);
    root = getChildElements(doc)[0] ?? null;
  } catch {
    return '';
  }
  if (!root) return '';

  return convertSequence(getChildElements(root)).trim();
}

function localName(el: XmlElement): string {
  return getLocalName(el.name ?? '');
}

function attr(el: XmlElement, name: string): string | null {
  const value = (el.attributes as Record<string, string> | undefined)?.[name];
  return value === undefined ? null : String(value);
}

function escapeLiteral(text: string): string {
  return [...text].map((ch) => ESCAPES[ch] ?? SYMBOLS[ch] ?? ch).join('');
}

/** Wrap in braces unless the LaTeX is already a single token. */
function brace(latex: string): string {
  const trimmed = latex.trim();
  if (trimmed.length === 0) return '{}';
  if (trimmed.length === 1) return trimmed;
  if (/^\\[a-zA-Z]+$/.test(trimmed)) return trimmed;
  return `{${trimmed}}`;
}

function convertSequence(nodes: XmlElement[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    // An n-ary operator's limits are already attached to it; what follows in
    // the row is the expression it applies to, and needs no extra grouping.
    const piece = convertNode(node);
    if (piece) parts.push(piece);
  }
  return joinParts(parts);
}

/**
 * Join siblings with a space only where LaTeX needs one — after a command, so
 * `\alpha x` does not become `\alphax`.
 */
function joinParts(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (out && /[a-zA-Z]$/.test(out) && /^[a-zA-Z]/.test(part) && /\\[a-zA-Z]+$/.test(out)) {
      out += ' ';
    }
    out += part;
  }
  return out;
}

function convertNode(el: XmlElement): string {
  const name = localName(el);
  const children = getChildElements(el);

  switch (name) {
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'semantics':
      return convertRow(children);

    case 'mi':
      return convertIdentifier(el);
    case 'mn':
      return escapeLiteral(getTextContent(el).trim());
    case 'mo':
      return convertOperator(el);
    case 'mtext':
      return convertText(el);

    case 'mfrac':
      return convertFraction(el, children);
    case 'msqrt':
      return `\\sqrt{${convertRow(children)}}`;
    case 'mroot':
      return `\\sqrt[${convertNodeOrEmpty(children[1])}]{${convertNodeOrEmpty(children[0])}}`;
    case 'msup':
      return `${baseOf(children[0])}^${brace(convertNodeOrEmpty(children[1]))}`;
    case 'msub':
      return `${baseOf(children[0])}_${brace(convertNodeOrEmpty(children[1]))}`;
    case 'msubsup':
      return (
        `${baseOf(children[0])}_${brace(convertNodeOrEmpty(children[1]))}` +
        `^${brace(convertNodeOrEmpty(children[2]))}`
      );
    case 'munder':
      return convertUnder(children);
    case 'mover':
      return convertOver(children);
    case 'munderover':
      return convertUnderOver(children);
    case 'mmultiscripts':
      return convertMultiscripts(children);
    case 'mtable':
      return convertTable(children);
    case 'menclose':
      return `\\boxed{${convertRow(children)}}`;
    case 'mphantom':
      return `\\phantom{${convertRow(children)}}`;
    case 'mspace':
      return '\\,';
    case 'none':
    case 'mprescripts':
    case 'annotation':
    case 'annotation-xml':
      return '';

    default:
      return convertRow(children);
  }
}

function convertNodeOrEmpty(el: XmlElement | undefined): string {
  return el ? convertNode(el) : '';
}

/** A script's base has to be a single token: `x^2`, but `{a+b}^2`. */
function baseOf(el: XmlElement | undefined): string {
  return brace(convertNodeOrEmpty(el));
}

function convertIdentifier(el: XmlElement): string {
  const text = getTextContent(el).trim();
  if (!text) return '';

  const variant = attr(el, 'mathvariant');
  const symbol = SYMBOLS[text];
  if (symbol && !variant) return symbol;

  if (FUNCTION_NAMES.has(text)) return `\\${text}`;

  const body = escapeLiteral(text);
  if (variant && VARIANT_COMMANDS[variant]) return `${VARIANT_COMMANDS[variant]}{${body}}`;
  // A multi-letter name is a word, not a product of variables.
  if ([...text].length > 1) return `\\mathrm{${body}}`;
  return body;
}

function convertOperator(el: XmlElement): string {
  const raw = getTextContent(el).trim();
  const text = [...raw].filter((ch) => !INVISIBLE.has(ch)).join('');
  if (!text) return '';
  return escapeLiteral(text);
}

function convertText(el: XmlElement): string {
  const text = getTextContent(el);
  if (!text) return '';
  if (!text.trim()) return '\\ '.repeat(Math.min(3, text.length));
  return `\\text{${text.replace(/([{}\\$&#_%])/g, '\\$1')}}`;
}

/**
 * A row, with `\left…\right` restored around a fenced group. MathML marks the
 * fences; LaTeX needs the pair to grow with what it encloses.
 */
function convertRow(nodes: XmlElement[]): string {
  if (nodes.length >= 2) {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const isFence = (el: XmlElement): boolean =>
      localName(el) === 'mo' && attr(el, 'fence') === 'true';

    if (isFence(first) && isFence(last)) {
      const open = latexDelimiter(getTextContent(first).trim());
      const close = latexDelimiter(getTextContent(last).trim());
      const inner = convertSequence(nodes.slice(1, -1));
      return `\\left${open}${inner}\\right${close}`;
    }
  }
  return convertSequence(nodes);
}

function latexDelimiter(chr: string): string {
  if (!chr) return '.';
  if (chr === '{' || chr === '}') return `\\${chr}`;
  if (chr === '|') return '|';
  if (chr === '‖') return '\\|';
  if (chr === '⟨') return '\\langle';
  if (chr === '⟩') return '\\rangle';
  if (chr === '⌈') return '\\lceil';
  if (chr === '⌉') return '\\rceil';
  if (chr === '⌊') return '\\lfloor';
  if (chr === '⌋') return '\\rfloor';
  return chr;
}

function convertFraction(el: XmlElement, children: XmlElement[]): string {
  const num = convertNodeOrEmpty(children[0]);
  const den = convertNodeOrEmpty(children[1]);
  const thickness = attr(el, 'linethickness');
  if (thickness === '0' || thickness === '0pt' || thickness === 'none') {
    return `\\binom{${num}}{${den}}`;
  }
  return `\\frac{${num}}{${den}}`;
}

/** The n-ary glyph of a script base, when it is one. */
function naryCommandOf(el: XmlElement | undefined): string | null {
  if (!el) return null;
  if (localName(el) === 'mrow') {
    const children = getChildElements(el);
    return children.length === 1 ? naryCommandOf(children[0]) : null;
  }
  if (localName(el) !== 'mo') return null;
  const text = getTextContent(el).trim();
  return NARY_OPERATORS.has(text) ? (SYMBOLS[text] ?? text) : null;
}

function convertUnder(children: XmlElement[]): string {
  const nary = naryCommandOf(children[0]);
  if (nary) return `${nary}_${brace(convertNodeOrEmpty(children[1]))}`;

  const script = children[1] ? getTextContent(children[1]).trim() : '';
  if (script === '⏟' || script === '⎵') return `\\underbrace{${convertNodeOrEmpty(children[0])}}`;
  if (script === '_' || script === '̲') return `\\underline{${convertNodeOrEmpty(children[0])}}`;

  // `lim` with something under it is `\\lim_{...}`, not an \\underset.
  const base = children[0] ? getTextContent(children[0]).trim() : '';
  if (FUNCTION_NAMES.has(base)) {
    return `\\${base}_${brace(convertNodeOrEmpty(children[1]))}`;
  }

  return `\\underset{${convertNodeOrEmpty(children[1])}}{${convertNodeOrEmpty(children[0])}}`;
}

function convertOver(children: XmlElement[]): string {
  const nary = naryCommandOf(children[0]);
  if (nary) return `${nary}^${brace(convertNodeOrEmpty(children[1]))}`;

  const script = children[1] ? getTextContent(children[1]).trim() : '';
  if (script === '⏞' || script === '⎴') return `\\overbrace{${convertNodeOrEmpty(children[0])}}`;

  const accent = ACCENTS[script];
  if (accent) return `${accent}{${convertNodeOrEmpty(children[0])}}`;
  return `\\overset{${convertNodeOrEmpty(children[1])}}{${convertNodeOrEmpty(children[0])}}`;
}

function convertUnderOver(children: XmlElement[]): string {
  const nary = naryCommandOf(children[0]);
  if (nary) {
    return (
      `${nary}_${brace(convertNodeOrEmpty(children[1]))}` +
      `^${brace(convertNodeOrEmpty(children[2]))}`
    );
  }
  return (
    `\\overset{${convertNodeOrEmpty(children[2])}}` +
    `{\\underset{${convertNodeOrEmpty(children[1])}}{${convertNodeOrEmpty(children[0])}}}`
  );
}

function convertMultiscripts(children: XmlElement[]): string {
  const separator = children.findIndex((child) => localName(child) === 'mprescripts');
  if (separator < 0) return convertSequence(children);

  const base = convertNodeOrEmpty(children[0]);
  const pre = children.slice(separator + 1);
  const sub = pre[0] && localName(pre[0]) !== 'none' ? convertNode(pre[0]) : '';
  const sup = pre[1] && localName(pre[1]) !== 'none' ? convertNode(pre[1]) : '';

  let prefix = '{}';
  if (sub) prefix += `_${brace(sub)}`;
  if (sup) prefix += `^${brace(sup)}`;
  return `${prefix}${base}`;
}

function convertTable(children: XmlElement[]): string {
  const rows = children
    .filter((row) => localName(row) === 'mtr' || localName(row) === 'mlabeledtr')
    .map((row) =>
      getChildElements(row)
        .filter((cell) => localName(cell) === 'mtd')
        .map((cell) => convertRow(getChildElements(cell)))
        .join(' & ')
    );

  return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
}
