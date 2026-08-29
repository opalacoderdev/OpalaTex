/**
 * Shared tables and helpers for the OMML <-> MathML converters.
 *
 * Word stores equations as OMML (ECMA-376 Part 1, §22.1). The browser renders
 * MathML, and the equation editor speaks MathML too, so every conversion in
 * this folder goes through one of the two directions implemented here. The
 * tables below are the parts both directions need to agree on: which glyphs
 * Word treats as n-ary operators, which OMML defaults apply when a property is
 * absent, and how a run of literal characters splits into MathML token
 * elements.
 */

/** XML-escape text content (`<`, `&`, and `>` for safety inside CDATA-free XML). */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** XML-escape an attribute value. */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

/**
 * Glyphs Word renders as an n-ary operator (`m:nary`): the limits sit under and
 * over the sign, or as sub/superscripts, instead of behaving like an ordinary
 * binary operator. MathML has no n-ary element, so the MathML side represents
 * these as `munderover`/`msubsup` over an `mo`, and the reverse direction uses
 * this set to decide when such a construct must become `m:nary` again.
 */
export const NARY_OPERATORS = new Set([
  '∑', // ∑ n-ary summation
  '∏', // ∏ n-ary product
  '∐', // ∐ n-ary coproduct
  '∫', // ∫ integral
  '∬', // ∬ double integral
  '∭', // ∭ triple integral
  '∮', // ∮ contour integral
  '∯', // ∯ surface integral
  '∰', // ∰ volume integral
  '∱', // ∱ clockwise integral
  '∲', // ∲ clockwise contour integral
  '∳', // ∳ anticlockwise contour integral
  '⋀', // ⋀ n-ary logical and
  '⋁', // ⋁ n-ary logical or
  '⋂', // ⋂ n-ary intersection
  '⋃', // ⋃ n-ary union
  '⨀', // ⨀ n-ary circled dot
  '⨁', // ⨁ n-ary circled plus
  '⨂', // ⨂ n-ary circled times
  '⨄', // ⨄ n-ary union with plus
  '⨆', // ⨆ n-ary square union
]);

/** Opening fences, mapped to the closer Word would pair them with. */
export const FENCE_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '⌈': '⌉', // ⌈ ⌉
  '⌊': '⌋', // ⌊ ⌋
  '⟨': '⟩', // ⟨ ⟩
  '|': '|',
  '‖': '‖', // ‖
};

/** OMML property defaults that matter for a faithful conversion. */
export const OMML_DEFAULTS = {
  /** `m:naryPr/m:chr` — ECMA-376 says the integral sign when absent. */
  naryChr: '∫',
  /** `m:naryPr/m:limLoc` — limits as sub/superscripts unless stated otherwise. */
  naryLimLoc: 'subSup',
  /** `m:dPr/m:begChr` */
  delimiterBegin: '(',
  /** `m:dPr/m:endChr` */
  delimiterEnd: ')',
  /** `m:dPr/m:sepChr` */
  delimiterSeparator: '|',
  /** `m:accPr/m:chr` — combining circumflex. */
  accentChr: '̂',
  /** `m:groupChrPr/m:chr` — bottom curly bracket. */
  groupChr: '⏟',
  /** Overline glyph used for `m:bar` with `m:pos="top"`. */
  barTop: '¯',
  /** Underline glyph used for `m:bar` with `m:pos="bot"` (the default). */
  barBottom: '_',
} as const;

/** A MathML token element produced from a literal run of characters. */
export interface MathToken {
  /** MathML element name for this piece of the run. */
  tag: 'mi' | 'mn' | 'mo' | 'mtext';
  text: string;
}

/** Space, non-breaking space, and tab all read as inter-token spacing. */
function isMathSpace(ch: string): boolean {
  return ch === ' ' || ch === '\u00A0' || ch === '\t';
}

const DIGIT_RE = /[0-9]/;
// Letters that Word italicises as variables: ASCII, Latin-1 accented, and Greek.
const LETTER_RE = /[A-Za-zÀ-ɏΑ-ωϑ-ϵ]/;

/**
 * Split a literal string (the text of one `m:t`) into MathML token elements.
 *
 * OMML keeps whole expressions such as `2x+1` in a single `m:t`, while MathML
 * wants one element per semantic token (`mn`, `mi`, `mo`). Splitting here is
 * what makes the browser space the expression like an equation instead of like
 * a word: `x+1` renders with operator spacing only once `+` is its own `mo`.
 */
export function tokenizeMathText(text: string): MathToken[] {
  const tokens: MathToken[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (DIGIT_RE.test(ch)) {
      // A number keeps its decimal separator: `3.14` is one `mn`, and so is
      // `3,14` — but only when a digit follows, so `f(x,y)` still splits.
      let j = i;
      while (j < text.length) {
        if (DIGIT_RE.test(text[j])) {
          j++;
        } else if (
          (text[j] === '.' || text[j] === ',') &&
          j + 1 < text.length &&
          DIGIT_RE.test(text[j + 1])
        ) {
          j++;
        } else {
          break;
        }
      }
      tokens.push({ tag: 'mn', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (LETTER_RE.test(ch)) {
      // Consecutive letters stay together so function names (`sin`, `log`) and
      // multi-letter identifiers survive as one `mi`, which MathML then renders
      // upright — the same thing Word does for them.
      let j = i;
      while (j < text.length && LETTER_RE.test(text[j])) j++;
      tokens.push({ tag: 'mi', text: text.slice(i, j) });
      i = j;
      continue;
    }

    if (isMathSpace(ch)) {
      let j = i;
      while (j < text.length && isMathSpace(text[j])) j++;
      tokens.push({ tag: 'mtext', text: text.slice(i, j) });
      i = j;
      continue;
    }

    tokens.push({ tag: 'mo', text: ch });
    i++;
  }

  return tokens;
}

/**
 * Wrap a list of already-serialized MathML nodes in an `mrow` when there is
 * more than one, which is what every MathML container expects for a slot that
 * holds a sequence.
 */
export function wrapRow(children: string[]): string {
  const parts = children.filter((child) => child.length > 0);
  if (parts.length === 0) return '<mrow></mrow>';
  if (parts.length === 1) return parts[0];
  return `<mrow>${parts.join('')}</mrow>`;
}
