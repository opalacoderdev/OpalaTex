import { describe, expect, it } from 'vitest';
import { ommlToMathml } from '../ommlToMathml';

const wrap = (inner: string): string => `<m:oMath>${inner}</m:oMath>`;

describe('ommlToMathml', () => {
  it('splits a literal run into MathML token elements', () => {
    const mathml = ommlToMathml(wrap('<m:r><m:t>2x+1</m:t></m:r>'));
    expect(mathml).toContain('<mn>2</mn>');
    expect(mathml).toContain('<mi>x</mi>');
    expect(mathml).toContain('<mo>+</mo>');
    expect(mathml).toContain('<mn>1</mn>');
  });

  it('keeps a multi-letter run italic, which is what OMML means by default', () => {
    // MathML renders a multi-character `mi` upright, OMML renders an unstyled
    // math run italic. The variant has to be explicit or the two disagree.
    const mathml = ommlToMathml(wrap('<m:r><m:t>sin</m:t></m:r>'));
    expect(mathml).toContain('<mi mathvariant="italic">sin</mi>');
  });

  it('leaves a function name upright when the document says so', () => {
    const mathml = ommlToMathml(
      wrap(
        '<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r></m:fName>' +
          '<m:e><m:r><m:t>x</m:t></m:r></m:e></m:func>'
      )
    );
    expect(mathml).toContain('<mi>sin</mi>');
    expect(mathml).toContain('&#x2061;');
  });

  it('keeps an explicitly upright single letter upright', () => {
    const mathml = ommlToMathml(
      wrap('<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>d</m:t></m:r>')
    );
    expect(mathml).toContain('<mi mathvariant="normal">d</mi>');
  });

  it('converts a fraction', () => {
    const mathml = ommlToMathml(
      wrap('<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>')
    );
    expect(mathml).toContain('<mfrac><mi>a</mi><mi>b</mi></mfrac>');
  });

  it('converts a binomial (noBar fraction) to a zero-thickness mfrac', () => {
    const mathml = ommlToMathml(
      wrap(
        '<m:f><m:fPr><m:type m:val="noBar"/></m:fPr>' +
          '<m:num><m:r><m:t>n</m:t></m:r></m:num><m:den><m:r><m:t>k</m:t></m:r></m:den></m:f>'
      )
    );
    expect(mathml).toContain('<mfrac linethickness="0">');
  });

  it('converts a square root and an nth root', () => {
    const sqrt = ommlToMathml(
      wrap('<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>')
    );
    expect(sqrt).toContain('<msqrt><mi>x</mi></msqrt>');

    const root = ommlToMathml(
      wrap('<m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>')
    );
    expect(root).toContain('<mroot><mi>x</mi><mn>3</mn></mroot>');
  });

  it('converts a summation with under/over limits', () => {
    const mathml = ommlToMathml(
      wrap(
        '<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>' +
          '<m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup>' +
          '<m:e><m:r><m:t>i</m:t></m:r></m:e></m:nary>'
      )
    );
    expect(mathml).toContain('<munderover>');
    expect(mathml).toContain('<mo largeop="true" movablelimits="false">∑</mo>');
  });

  it('defaults an n-ary operator without a glyph to the integral sign', () => {
    const mathml = ommlToMathml(
      wrap('<m:nary><m:naryPr/><m:sub/><m:sup/><m:e><m:r><m:t>f</m:t></m:r></m:e></m:nary>')
    );
    expect(mathml).toContain('∫');
  });

  it('converts delimiters, including a non-default pair', () => {
    const parens = ommlToMathml(wrap('<m:d><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d>'));
    expect(parens).toContain('<mo fence="true" stretchy="true">(</mo>');
    expect(parens).toContain('<mo fence="true" stretchy="true">)</mo>');

    const braces = ommlToMathml(
      wrap(
        '<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val="}"/></m:dPr>' +
          '<m:e><m:r><m:t>x</m:t></m:r></m:e></m:d>'
      )
    );
    expect(braces).toContain('>{</mo>');
    expect(braces).toContain('>}</mo>');
  });

  it('converts a matrix to an mtable', () => {
    const mathml = ommlToMathml(
      wrap(
        '<m:m><m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr>' +
          '<m:mr><m:e><m:r><m:t>c</m:t></m:r></m:e><m:e><m:r><m:t>d</m:t></m:r></m:e></m:mr></m:m>'
      )
    );
    expect(mathml).toContain('<mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr>');
  });

  it('converts an accent and an overbar', () => {
    const accent = ommlToMathml(
      wrap('<m:acc><m:accPr><m:chr m:val="̂"/></m:accPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:acc>')
    );
    expect(accent).toContain('<mover accent="true">');

    const bar = ommlToMathml(
      wrap('<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:bar>')
    );
    expect(bar).toContain('<mover accent="true"><mi>x</mi><mo stretchy="true">¯</mo></mover>');
  });

  it('marks m:oMathPara as a displayed equation', () => {
    const mathml = ommlToMathml('<m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>');
    expect(mathml).toContain('display="block"');
  });

  it('returns an empty string for input it cannot parse', () => {
    // The painter falls back to the equation's plain text when this happens,
    // so a malformed fragment must never throw out of the layout pass.
    expect(ommlToMathml('not xml at all')).toBe('');
    expect(ommlToMathml('<m:oMath><m:t>a < b</m:t></m:oMath>')).toBe('');
    expect(ommlToMathml('')).toBe('');
  });

  it('escapes XML metacharacters coming from the document', () => {
    const mathml = ommlToMathml(wrap('<m:r><m:t>a&lt;b</m:t></m:r>'));
    expect(mathml).toContain('<mo>&lt;</mo>');
  });
});
