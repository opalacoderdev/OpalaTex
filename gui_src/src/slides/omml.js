// ─────────────────────────────────────────────────────────────────────────────
// omml.js
//
// LaTeX → OMML: the deck's equations as *PowerPoint's own* equations.
//
// A `.jpt` stores a formula as the LaTeX the user typed. PowerPoint stores one
// as OMML (Office Math Markup Language), the thing its equation editor edits.
// Exporting the LaTeX source as a text box — what this export used to do — is
// honest but useless: the reader gets `\frac{a}{b}` on the slide and has to
// retype it into an equation object to get a formula back.
//
// The bridge is MathML. KaTeX already parses the deck's LaTeX to MathML for
// every other surface in the app (see equation.js), so this module never parses
// LaTeX: it converts KaTeX's MathML, one element at a time, into the OMML that
// says the same thing. That split matters — LaTeX is a macro language with an
// endless surface, MathML is a fixed tree of about twenty element types, and
// only the second is something a few hundred lines can convert correctly.
//
// Two rules the conversion holds to:
//
//   1. **Never guess.** An element this module does not know is not silently
//      dropped or approximated into something else: `mathmlToOmml` returns
//      null, the caller keeps the LaTeX-source text box it would have written
//      anyway, and the export reports how many equations took that path. A
//      formula that is *wrong* in PowerPoint is worse than one that is plainly
//      still LaTeX, because only the second is visible as unfinished.
//   2. **No DOM.** The XML is parsed here rather than with `DOMParser`, so the
//      converter runs identically in the browser and under `node --test`. The
//      input is KaTeX's own output — well-formed, namespace-free, no DTD, no
//      CDATA, no processing instructions — which is a small enough language to
//      parse in the fifty lines below rather than depend on an environment for.
// ─────────────────────────────────────────────────────────────────────────────

import { renderEquation } from './equation.js';

// ─── a very small XML reader ─────────────────────────────────────────────────
// Nodes are `{ name, attrs, children }` for elements and plain strings for
// text. Only what KaTeX emits is accepted; anything else throws, which the
// caller turns into "keep the LaTeX".

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[body];
    return named ?? whole;
  });
}

export function parseXml(source) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let index = 0;

  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) break;
    if (open > index) {
      const text = decodeEntities(source.slice(index, open));
      if (text) stack[stack.length - 1].children.push(text);
    }
    const close = source.indexOf('>', open);
    if (close === -1) throw new Error('unterminated tag');
    let tag = source.slice(open + 1, close);
    index = close + 1;

    if (tag[0] === '!' || tag[0] === '?') continue;   // comment, doctype, PI
    if (tag[0] === '/') {
      const name = tag.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`unbalanced </${name}>`);
      continue;
    }

    const selfClosing = tag.endsWith('/');
    if (selfClosing) tag = tag.slice(0, -1);
    const match = /^([^\s/>]+)([\s\S]*)$/.exec(tag);
    if (!match) throw new Error('malformed tag');
    const node = { name: match[1], attrs: {}, children: [] };
    const attrPattern = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g;
    let attr;
    while ((attr = attrPattern.exec(match[2])) !== null) {
      const key = attr[1] ?? attr[3];
      node.attrs[key] = decodeEntities(attr[2] ?? attr[4] ?? '');
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) throw new Error('unclosed element');
  return root;
}

// ─── XML writing ─────────────────────────────────────────────────────────────

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── the operators that take limits above and below ──────────────────────────
// In OMML these are n-ary operators (`m:nary`), a different construction from
// an ordinary sub/superscript: the bounds sit under and over the sign in
// display style rather than beside it. Getting this wrong is the difference
// between a sum and a letter with two subscripts.
const NARY_OPERATORS = new Set([
  '∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰',
  '⋀', '⋁', '⋂', '⋃', '⨀', '⨁', '⨂', '⨃', '⨄', '⨅', '⨆',
]);

// Characters MathML uses to mean "an accent over this", mapped to the
// combining forms Word's equation editor stores. KaTeX emits the spacing
// variant for several of these (`^` for \hat, `ˉ` for \bar), which would show
// up beside the letter rather than above it.
const ACCENT_CHARS = {
  '^': '̂',      // \hat
  'ˆ': '̂',
  '~': '̃',      // \tilde
  '˜': '̃',
  'ˉ': '¯', // \bar
  '˙': '̇', // \dot
  '¨': '̈', // \ddot
  '˚': '̊', // \mathring
  'ˇ': '̌', // \check
  '´': '́', // \acute
  '`': '̀', // \grave
};

// Invisible MathML operators — function application, invisible times. They
// carry meaning for a screen reader and nothing for a renderer, and Word draws
// a blank box for the ones it does not recognise.
const INVISIBLE = /^[⁡-⁤​]+$/;

// ─── conversion ──────────────────────────────────────────────────────────────

/**
 * A run's OMML style: `p` upright, `i` italic, `b`/`bi` bold.
 *
 * OMML's default for a math run is italic, which is right for a single-letter
 * variable and wrong for everything else — a number, an operator, or a
 * multi-letter function name like `sin`, all of which are upright in every
 * typographic convention for mathematics.
 */
function styleFor(node) {
  const variant = node.attrs.mathvariant;
  if (variant === 'bold') return 'b';
  if (variant === 'bold-italic') return 'bi';
  if (variant === 'italic') return 'i';
  if (variant === 'normal') return 'p';
  if (node.name === 'mi') {
    const text = textOf(node);
    // A single letter is a variable and is set in italics; `sin`, `log`, `max`
    // and the rest are names and are not.
    return [...text].length === 1 ? 'i' : 'p';
  }
  return 'p';
}

function textOf(node) {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

/**
 * The DrawingML run properties every math run carries: the size and colour the
 * deck gave the equation.
 *
 * OMML inside a slide takes its appearance from `a:rPr`, the same run
 * properties an ordinary text run uses — which is why an equation exported
 * without them comes out at PowerPoint's default 18pt in black, whatever the
 * slide said.
 */
function runProps(context, style) {
  const italic = style === 'i' || style === 'bi' ? 1 : 0;
  const bold = style === 'b' || style === 'bi' ? 1 : 0;
  const fill = context.color
    ? `<a:solidFill><a:srgbClr val="${context.color}"/></a:solidFill>`
    : '';
  return `<a:rPr lang="en-US" sz="${context.sz}" b="${bold}" i="${italic}" dirty="0">`
    + `${fill}</a:rPr>`;
}

/**
 * The properties of a construction's own marks — a fraction bar, a radical
 * sign, a delimiter. OMML calls these the control properties, and they are
 * separate from the runs inside: an equation exported without them draws its
 * numerator in the deck's colour and the bar under it in black.
 */
function ctrl(context) {
  return `<m:ctrlPr>${runProps(context, 'i')}</m:ctrlPr>`;
}

function run(context, text, style) {
  if (!text) return '';
  const properties = style === 'nor'
    ? '<m:rPr><m:nor/></m:rPr>'
    : `<m:rPr><m:sty m:val="${style}"/></m:rPr>`;
  const preserve = text !== text.trim() ? ' xml:space="preserve"' : '';
  return `<m:r>${properties}${runProps(context, style === 'nor' ? 'p' : style)}`
    + `<m:t${preserve}>${escapeXml(text)}</m:t></m:r>`;
}

/** Children of a node, converted and concatenated. */
function convertAll(nodes, context) {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      // Whitespace between elements is layout, not content: MathML ignores it
      // and so must this.
      if (node.trim()) throw new Error('unexpected text outside a token element');
      continue;
    }
    out += convert(node, context);
  }
  return out;
}

/** A node as an OMML `<m:e>`-style argument, always a single group. */
function arg(node, context) {
  return typeof node === 'string' ? run(context, node, 'p') : convert(node, context);
}

/** The element children of a node, with whitespace-only text dropped. */
function elementsOf(node) {
  return node.children.filter(child => typeof child !== 'string' || child.trim());
}

/**
 * The delimiters this row is wrapped in, or null.
 *
 * KaTeX marks the delimiters `\left` and `\right` produced with
 * `fence="true"`, and leaves an ordinary typed `(` unmarked — the same
 * distinction LaTeX itself makes, and the reason `P(t)` stays three characters
 * here while `\left(\frac{a}{b}\right)` becomes a stretching OMML delimiter.
 */
function fencesOf(children) {
  if (children.length < 2) return null;
  const first = children[0];
  const last = children[children.length - 1];
  if (typeof first === 'string' || typeof last === 'string') return null;
  if (first.name !== 'mo' || last.name !== 'mo') return null;
  if (first.attrs.fence !== 'true' || last.attrs.fence !== 'true') return null;
  return {
    begin: textOf(first),
    end: textOf(last),
    inner: children.slice(1, -1),
  };
}

function delimiter(begin, end, body, context) {
  // `.` is LaTeX's "no delimiter here" (`\left.`), which OMML spells as an
  // empty character rather than as a missing attribute.
  const beg = begin === '.' ? '' : begin;
  const fin = end === '.' ? '' : end;
  return '<m:d><m:dPr>'
    + `<m:begChr m:val="${escapeXml(beg)}"/><m:endChr m:val="${escapeXml(fin)}"/>`
    + `${ctrl(context)}</m:dPr>`
    + `<m:e>${body}</m:e></m:d>`;
}

/**
 * A `<mtable>` as either an equation array or a matrix.
 *
 * The two look alike in MathML and are different objects in OMML, so the
 * distinction is read from the column alignment KaTeX writes: `aligned` and
 * `align` produce alternating `right left` columns, every matrix-like
 * environment produces uniform ones.
 *
 * Known limitation: OMML equation arrays align their rows as a block, so the
 * `&` alignment point inside a row is not carried across — `a &= 1` and
 * `\Delta &= 16` line up on the left rather than on the `=`.
 */
function table(node, context) {
  const rows = elementsOf(node).filter(child => child.name === 'mtr');
  if (!rows.length) throw new Error('mtable with no rows');
  const cellsOf = (row) => elementsOf(row).filter(cell => cell.name === 'mtd');
  const alignment = String(node.attrs.columnalign || '').split(/\s+/).filter(Boolean);
  const isEquationArray = alignment.length >= 2
    && alignment[0] === 'right' && alignment[1] === 'left';

  if (isEquationArray) {
    const body = rows
      .map(row => `<m:e>${cellsOf(row).map(cell => convertAll(cell.children, context)).join('')}</m:e>`)
      .join('');
    return `<m:eqArr><m:eqArrPr>${ctrl(context)}</m:eqArrPr>${body}</m:eqArr>`;
  }

  const columns = Math.max(...rows.map(row => cellsOf(row).length));
  const body = rows.map(row => (
    `<m:mr>${cellsOf(row).map(cell => `<m:e>${convertAll(cell.children, context)}</m:e>`).join('')}</m:mr>`
  )).join('');
  return '<m:m><m:mPr>'
    + `<m:mcs><m:mc><m:mcPr><m:count m:val="${columns}"/>`
    + '<m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs>'
    + `${ctrl(context)}</m:mPr>`
    + `${body}</m:m>`;
}

/** An `<munder>` / `<mover>` / `<munderover>`, which is three OMML shapes. */
function limits(node, context, { under, over }) {
  const children = elementsOf(node);
  const base = children[0];
  if (!base) throw new Error(`${node.name} with no base`);

  // An accent — \vec, \hat, \bar — is a mark attached to the symbol, not a
  // limit above it, and OMML has its own construction for it.
  if (over != null && under == null && node.attrs.accent === 'true') {
    const mark = textOf(children[over]);
    const chr = ACCENT_CHARS[mark] ?? mark;
    return '<m:acc><m:accPr>'
      + `<m:chr m:val="${escapeXml(chr)}"/>${ctrl(context)}</m:accPr>`
      + `<m:e>${arg(base, context)}</m:e></m:acc>`;
  }

  const symbol = textOf(base).trim();
  if (NARY_OPERATORS.has(symbol)) {
    const sub = under != null ? `<m:sub>${arg(children[under], context)}</m:sub>` : '<m:sub/>';
    const sup = over != null ? `<m:sup>${arg(children[over], context)}</m:sup>` : '<m:sup/>';
    return '<m:nary><m:naryPr>'
      + `<m:chr m:val="${escapeXml(symbol)}"/><m:limLoc m:val="undOvr"/>`
      + `<m:subHide m:val="${under != null ? 0 : 1}"/>`
      + `<m:supHide m:val="${over != null ? 0 : 1}"/>${ctrl(context)}</m:naryPr>`
      + `${sub}${sup}<m:e/></m:nary>`;
  }

  let out = arg(base, context);
  if (under != null) {
    out = `<m:limLow><m:limLowPr>${ctrl(context)}</m:limLowPr><m:e>${out}</m:e>`
      + `<m:lim>${arg(children[under], context)}</m:lim></m:limLow>`;
  }
  if (over != null) {
    out = `<m:limUpp><m:limUppPr>${ctrl(context)}</m:limUppPr><m:e>${out}</m:e>`
      + `<m:lim>${arg(children[over], context)}</m:lim></m:limUpp>`;
  }
  return out;
}

function convert(node, context) {
  const children = elementsOf(node);

  switch (node.name) {
    // Wrappers that carry no shape of their own.
    case 'math':
    case 'mstyle':
    case 'mpadded':
    case 'menclose':
      return convertAll(node.children, context);
    case 'semantics':
      // The MathML tree, then the LaTeX annotation KaTeX appends for
      // round-tripping — which is the source, not the formula.
      return children.length ? convert(children[0], context) : '';
    case 'annotation':
      return '';
    case 'mphantom':
      // Space the size of its contents. There is no OMML phantom, and drawing
      // the contents would be a different formula, so it contributes nothing.
      return '';

    case 'mrow': {
      const fences = fencesOf(children);
      if (fences) {
        return delimiter(fences.begin, fences.end, convertAll(fences.inner, context), context);
      }
      return convertAll(node.children, context);
    }

    case 'mi':
    case 'mn':
      return run(context, textOf(node), styleFor(node));
    case 'mo': {
      const text = textOf(node);
      if (INVISIBLE.test(text)) return '';
      return run(context, text, styleFor(node));
    }
    case 'mtext': {
      const text = textOf(node);
      // `\text{...}` and KaTeX's spacing macros both land here. Upright, and
      // marked as ordinary text so Word does not italicise a word.
      return run(context, text, 'nor');
    }
    case 'mspace': {
      const width = parseFloat(node.attrs.width) || 0;
      return run(context, width >= 1 ? ' ' : ' ', 'nor');
    }

    case 'mfrac': {
      if (children.length !== 2) throw new Error('mfrac needs two children');
      // `\binom` is a fraction with no rule, wrapped in fences by KaTeX.
      const bare = parseFloat(node.attrs.linethickness) === 0;
      return '<m:f><m:fPr>'
        + `<m:type m:val="${bare ? 'noBar' : 'bar'}"/>${ctrl(context)}</m:fPr>`
        + `<m:num>${arg(children[0], context)}</m:num>`
        + `<m:den>${arg(children[1], context)}</m:den></m:f>`;
    }

    case 'msqrt':
      return `<m:rad><m:radPr><m:degHide m:val="1"/>${ctrl(context)}</m:radPr>`
        + `<m:deg/><m:e>${convertAll(node.children, context)}</m:e></m:rad>`;
    case 'mroot': {
      if (children.length !== 2) throw new Error('mroot needs two children');
      return `<m:rad><m:radPr><m:degHide m:val="0"/>${ctrl(context)}</m:radPr>`
        + `<m:deg>${arg(children[1], context)}</m:deg>`
        + `<m:e>${arg(children[0], context)}</m:e></m:rad>`;
    }

    case 'msub':
      if (children.length !== 2) throw new Error('msub needs two children');
      return `<m:sSub><m:sSubPr>${ctrl(context)}</m:sSubPr>`
        + `<m:e>${arg(children[0], context)}</m:e>`
        + `<m:sub>${arg(children[1], context)}</m:sub></m:sSub>`;
    case 'msup':
      if (children.length !== 2) throw new Error('msup needs two children');
      return `<m:sSup><m:sSupPr>${ctrl(context)}</m:sSupPr>`
        + `<m:e>${arg(children[0], context)}</m:e>`
        + `<m:sup>${arg(children[1], context)}</m:sup></m:sSup>`;
    case 'msubsup':
      if (children.length !== 3) throw new Error('msubsup needs three children');
      return `<m:sSubSup><m:sSubSupPr>${ctrl(context)}</m:sSubSupPr>`
        + `<m:e>${arg(children[0], context)}</m:e>`
        + `<m:sub>${arg(children[1], context)}</m:sub>`
        + `<m:sup>${arg(children[2], context)}</m:sup></m:sSubSup>`;

    case 'munder':
      return limits(node, context, { under: 1, over: null });
    case 'mover':
      return limits(node, context, { under: null, over: 1 });
    case 'munderover':
      return limits(node, context, { under: 1, over: 2 });

    case 'mtable':
      return table(node, context);

    default:
      // Rule 1 of this module: an element nobody wrote a mapping for stops the
      // conversion rather than being approximated into one that happens to
      // parse.
      throw new Error(`no OMML mapping for <${node.name}>`);
  }
}

/**
 * KaTeX MathML as an OMML `<m:oMath>` body, or null when it cannot be
 * converted faithfully.
 *
 * `sz` is hundredths of a point, PowerPoint's own unit; `color` is a six-digit
 * uppercase hex string with no `#`, the same shape `hex()` in export.js
 * produces.
 */
export function mathmlToOmml(mathml, { sz = 1800, color = null } = {}) {
  try {
    const tree = parseXml(mathml);
    const math = findElement(tree, 'math');
    if (!math) return null;
    const body = convert(math, { sz, color });
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

function findElement(node, name) {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.name === name) return child;
    const found = findElement(child, name);
    if (found) return found;
  }
  return null;
}

/**
 * A deck's LaTeX as an OMML body, or null when it cannot be converted.
 *
 * Null is a normal outcome, not a failure: LaTeX that KaTeX cannot parse, and
 * MathML this module has no mapping for, both land here, and the caller falls
 * back to writing the source as text — which is what the export did for every
 * equation before this module existed.
 */
export function latexToOmml(latex, { displayMode = true, sz = 1800, color = null } = {}) {
  const source = typeof latex === 'string' ? latex.trim() : '';
  if (!source) return null;
  const { html, error } = renderEquation(source, { displayMode });
  // A formula KaTeX could only parse halfway renders as far as it got and
  // marks the rest in red. That is the right thing on the editing canvas and
  // the wrong thing in an export, where it would ship a truncated formula.
  if (error || !html) return null;
  return mathmlToOmml(html, { sz, color });
}
