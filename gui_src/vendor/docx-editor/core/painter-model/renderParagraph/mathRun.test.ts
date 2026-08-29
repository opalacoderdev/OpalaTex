/**
 * @vitest-environment jsdom
 *
 * The equation painter is the one place document-derived markup is injected
 * into the page, so these cover both halves of that: the element it builds for
 * the layout/caret machinery, and the filtering that markup goes through.
 */

import { describe, expect, it } from 'vitest';
import { paintLine } from './line';
import { paintMathRun } from './runs';
import { sanitizeMathml } from '../../utils/sanitizeMathml';
import type { MathRun, MeasuredLine, ParagraphBlock } from '../../pagination-model/types';

const mathRun = (overrides: Partial<MathRun> = {}): MathRun => ({
  kind: 'math',
  mathml: '<math><mi>x</mi></math>',
  plainText: 'x',
  display: 'inline',
  width: 12,
  height: 18,
  ascent: 14,
  descent: 4,
  fontSizePx: 14.6667,
  docFrom: 5,
  docTo: 6,
  ...overrides,
});

describe('paintMathRun', () => {
  it('paints the MathML and carries the document positions', () => {
    const el = paintMathRun(mathRun(), document);

    expect(el.className).toContain('layout-run-math');
    expect(el.querySelector('math')).not.toBeNull();
    // The caret and click resolvers find a run by these attributes.
    expect(el.getAttribute('data-doc-from')).toBe('5');
    expect(el.getAttribute('data-doc-to')).toBe('6');
  });

  it('falls back to the plain text when there is no MathML', () => {
    const el = paintMathRun(mathRun({ mathml: '', plainText: 'x2+y2' }), document);

    expect(el.querySelector('math')).toBeNull();
    expect(el.textContent).toBe('x2+y2');
  });

  it('shows a placeholder when the equation has no text either', () => {
    const el = paintMathRun(mathRun({ mathml: '', plainText: '' }), document);
    expect(el.textContent).toBe('[equation]');
  });

  it('paints at exactly the size the box was measured at', () => {
    // Inheriting instead would paint an equation the line has no room for.
    const el = paintMathRun(mathRun({ fontSizePx: 16, fontSize: 12 }), document);
    expect(el.style.fontSize).toBe('16px');
  });

  it('always states a font size, even when the run carries none', () => {
    const el = paintMathRun(mathRun({ fontSizePx: 0, fontSize: undefined }), document);
    expect(el.style.fontSize).not.toBe('');
  });

  it('records the display mode for the stylesheet', () => {
    const el = paintMathRun(mathRun({ display: 'block' }), document);
    expect(el.dataset.mathDisplay).toBe('block');
  });
});

describe('sanitizeMathml', () => {
  it('keeps presentation MathML intact', () => {
    const clean = sanitizeMathml('<math><mfrac><mi>a</mi><mn>2</mn></mfrac></math>');
    expect(clean).toContain('<mfrac>');
    expect(clean).toContain('<mn>2</mn>');
  });

  it('keeps the display attribute, which selects the math style', () => {
    // Dropping it would render every displayed equation in compact style.
    expect(sanitizeMathml('<math display="block"><mi>x</mi></math>')).toContain('display="block"');
  });

  it('strips script and event handlers a hostile document could carry', () => {
    const clean = sanitizeMathml(
      '<math><mi onclick="alert(1)">x</mi><script>alert(2)</script></math>'
    );
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('x');
  });

  it('does not paint smuggled markup into the page', () => {
    const el = paintMathRun(
      mathRun({ mathml: '<math><mi>x</mi><script>alert(1)</script></math>' }),
      document
    );
    expect(el.querySelector('script')).toBeNull();
  });
});

describe('paintLine with a displayed equation', () => {
  const blockFor = (run: MathRun): ParagraphBlock => ({
    kind: 'paragraph',
    runs: [run],
    attrs: {},
  }) as ParagraphBlock;

  const line: MeasuredLine = {
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 1,
    width: 40,
    ascent: 16,
    descent: 5,
    lineHeight: 21,
  };

  it('centers a display equation regardless of the paragraph alignment', () => {
    const el = paintLine(blockFor(mathRun({ display: 'block' })), line, 'left', document);
    expect(el.style.justifyContent).toBe('center');
  });

  it('honours a display equation aligned left by the document', () => {
    const el = paintLine(
      blockFor(mathRun({ display: 'block', justification: 'left' })),
      line,
      'center',
      document
    );
    expect(el.style.justifyContent).toBe('flex-start');
  });

  it('keeps a line with an inline equation in the inline flow', () => {
    // Flex would lay the runs out as flex items, and `text-align: justify` —
    // how this painter justifies — does not reach flex items. A justified
    // paragraph holding an equation would lose its justification.
    const el = paintLine(blockFor(mathRun()), line, 'justify', document, {
      isLastLine: false,
      availableWidth: 400,
    });
    expect(el.style.display).not.toBe('flex');
    expect(el.style.textAlign).toBe('justify');
    expect(el.querySelector('math')).not.toBeNull();
  });

  it('hands the baseline to the equation when the equation sets the line height', () => {
    // `line-height` from the paragraph would place the baseline by the strut
    // font's half-leading, below a tall equation's measured ascent.
    const tall = mathRun({ height: 21, ascent: 16, descent: 5 });
    const el = paintLine(blockFor(tall), line, 'left', document);
    expect(el.style.lineHeight).toBe('normal');
  });

  it('leaves the paragraph line spacing alone for a short inline equation', () => {
    // A small equation in a widely-spaced paragraph must not collapse the
    // paragraph's own line spacing.
    const spacedLine: MeasuredLine = { ...line, lineHeight: 40 };
    const el = paintLine(blockFor(mathRun({ height: 18 })), spacedLine, 'left', document);
    expect(el.style.lineHeight).toBe('40px');
  });
});
