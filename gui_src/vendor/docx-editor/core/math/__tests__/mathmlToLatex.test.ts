/**
 * The LaTeX writer feeds the equation editor (MathLive reads LaTeX, not
 * MathML) and the LaTeX side of the application, so these assertions are on
 * the exact source a user would see in a .tex file.
 */

import { describe, expect, it } from 'vitest';
import { ommlToMathml } from '../ommlToMathml';
import { mathmlToLatex } from '../mathmlToLatex';

const fromOmml = (omml: string): string => mathmlToLatex(ommlToMathml(omml));
const wrap = (inner: string): string => `<m:oMath>${inner}</m:oMath>`;

describe('mathmlToLatex', () => {
  it('writes a fraction over a radical', () => {
    const latex = fromOmml(
      wrap(
        '<m:f><m:num><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>' +
          '<m:e><m:r><m:t>b</m:t></m:r></m:e></m:rad></m:num>' +
          '<m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>'
      )
    );
    expect(latex).toBe('\\frac{\\sqrt{b}}{2}');
  });

  it('writes a summation with both limits', () => {
    const latex = fromOmml(
      wrap(
        '<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>' +
          '<m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup>' +
          '<m:e><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub></m:e></m:nary>'
      )
    );
    expect(latex).toBe('\\sum_{i=1}^nx_i');
  });

  it('writes stretchy delimiters around a matrix', () => {
    const latex = fromOmml(
      wrap(
        '<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>' +
          '<m:m><m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr></m:m>' +
          '</m:e></m:d>'
      )
    );
    expect(latex).toBe('\\left[\\begin{matrix}a & b\\end{matrix}\\right]');
  });

  it('uses the LaTeX command for a function name', () => {
    expect(fromOmml(wrap('<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r>'))).toBe('\\sin');
  });

  it('puts a limit under lim instead of using underset', () => {
    const latex = fromOmml(
      wrap(
        '<m:limLow><m:e><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>lim</m:t></m:r></m:e>' +
          '<m:lim><m:r><m:t>n→∞</m:t></m:r></m:lim></m:limLow>'
      )
    );
    expect(latex).toBe('\\lim_{n\\to\\infty}');
  });

  it('writes accents with their LaTeX command', () => {
    expect(fromOmml(wrap('<m:acc><m:accPr><m:chr m:val="̂"/></m:accPr><m:e><m:r><m:t>y</m:t></m:r></m:e></m:acc>'))).toBe(
      '\\hat{y}'
    );
    expect(
      fromOmml(wrap('<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e><m:r><m:t>z</m:t></m:r></m:e></m:bar>'))
    ).toBe('\\bar{z}');
  });

  it('writes a binomial for a bar-less fraction', () => {
    const latex = fromOmml(
      wrap(
        '<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num><m:r><m:t>n</m:t></m:r></m:num>' +
          '<m:den><m:r><m:t>k</m:t></m:r></m:den></m:f>'
      )
    );
    expect(latex).toBe('\\binom{n}{k}');
  });

  it('translates Greek letters and relations', () => {
    expect(fromOmml(wrap('<m:r><m:t>α≤β</m:t></m:r>'))).toBe('\\alpha\\leq\\beta');
  });

  it('escapes characters LaTeX would read as markup', () => {
    expect(fromOmml(wrap('<m:r><m:t>a%b</m:t></m:r>'))).toContain('\\%');
  });

  it('returns an empty string for MathML it cannot parse', () => {
    expect(mathmlToLatex('not mathml')).toBe('');
    expect(mathmlToLatex('')).toBe('');
  });
});
