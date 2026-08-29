import { describe, expect, it } from 'vitest';
import { mathmlToOmml } from '../mathmlToOmml';
import { ommlParagraphJustification } from '../ommlProperties';

const math = (inner: string, display = 'inline'): string =>
  `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display}">${inner}</math>`;

describe('mathmlToOmml', () => {
  it('merges adjacent literals of the same style into one run', () => {
    const omml = mathmlToOmml(math('<mn>2</mn><mo>+</mo><mn>3</mn>'));
    expect(omml).toBe(
      '<m:oMath><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>2+3</m:t></m:r></m:oMath>'
    );
  });

  it('leaves a single-letter identifier at the OMML default (italic)', () => {
    const omml = mathmlToOmml(math('<mi>x</mi>'));
    expect(omml).toBe('<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>');
  });

  it('marks a multi-letter identifier upright', () => {
    const omml = mathmlToOmml(math('<mi>sin</mi>'));
    expect(omml).toContain('<m:sty m:val="p"/>');
  });

  it('maps mathvariant onto m:sty and m:scr', () => {
    expect(mathmlToOmml(math('<mi mathvariant="bold">v</mi>'))).toContain('<m:sty m:val="b"/>');
    expect(mathmlToOmml(math('<mi mathvariant="double-struck">R</mi>'))).toContain(
      '<m:scr m:val="double-struck"/>'
    );
  });

  it('converts a fraction and its Word variants', () => {
    expect(mathmlToOmml(math('<mfrac><mi>a</mi><mi>b</mi></mfrac>'))).toContain(
      '<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>'
    );
    expect(mathmlToOmml(math('<mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac>'))).toContain(
      '<m:type m:val="noBar"/>'
    );
    expect(mathmlToOmml(math('<mfrac bevelled="true"><mi>a</mi><mi>b</mi></mfrac>'))).toContain(
      '<m:type m:val="skw"/>'
    );
  });

  it('converts roots', () => {
    expect(mathmlToOmml(math('<msqrt><mi>x</mi></msqrt>'))).toContain('<m:degHide m:val="1"/>');
    const root = mathmlToOmml(math('<mroot><mi>x</mi><mn>3</mn></mroot>'));
    expect(root).toContain('<m:deg>');
    expect(root).not.toContain('degHide');
  });

  it('rebuilds an n-ary operator and absorbs the expression that follows it', () => {
    const omml = mathmlToOmml(
      math(
        '<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover>' +
          '<msub><mi>x</mi><mi>i</mi></msub>'
      )
    );
    expect(omml).toContain('<m:nary>');
    expect(omml).toContain('<m:chr m:val="∑"/>');
    expect(omml).toContain('<m:limLoc m:val="undOvr"/>');
    // The integrand/summand belongs inside m:e, not beside the operator.
    expect(omml).toContain('<m:e><m:sSub>');
  });

  it('hides the missing limit of a one-sided n-ary operator', () => {
    const omml = mathmlToOmml(math('<msup><mo>∫</mo><mi>b</mi></msup><mi>f</mi>'));
    expect(omml).toContain('<m:subHide m:val="1"/>');
    expect(omml).not.toContain('<m:supHide');
  });

  it('rebuilds delimiters from a fenced row', () => {
    const omml = mathmlToOmml(
      math('<mo fence="true">(</mo><mi>x</mi><mo fence="true">)</mo>')
    );
    expect(omml).toContain('<m:d>');
    expect(omml).not.toContain('m:begChr');
    expect(omml).toContain('<m:e><m:r><m:t>x</m:t></m:r></m:e>');
  });

  it('records a non-default fence pair', () => {
    const omml = mathmlToOmml(math('<mo fence="true">[</mo><mi>x</mi><mo fence="true">]</mo>'));
    expect(omml).toContain('<m:begChr m:val="["/>');
    expect(omml).toContain('<m:endChr m:val="]"/>');
  });

  it('splits delimiter slots on a marked separator', () => {
    const omml = mathmlToOmml(
      math(
        '<mo fence="true">(</mo><mi>a</mi><mo separator="true">|</mo><mi>b</mi><mo fence="true">)</mo>'
      )
    );
    expect(omml).toContain('<m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e>');
  });

  it('does not treat a bare parenthesis as a fence construct', () => {
    const omml = mathmlToOmml(math('<mo>(</mo><mi>x</mi>'));
    expect(omml).not.toContain('<m:d>');
  });

  it('converts a table to a matrix with a column count', () => {
    const omml = mathmlToOmml(
      math('<mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr></mtable>')
    );
    expect(omml).toContain('<m:count m:val="2"/>');
    expect(omml).toContain('<m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e>');
  });

  it('distinguishes accents, bars, and group characters', () => {
    expect(mathmlToOmml(math('<mover accent="true"><mi>x</mi><mo>̂</mo></mover>'))).toContain('<m:acc>');
    expect(mathmlToOmml(math('<mover accent="true"><mi>x</mi><mo>¯</mo></mover>'))).toContain(
      '<m:bar><m:barPr><m:pos m:val="top"/>'
    );
    expect(mathmlToOmml(math('<munder><mi>x</mi><mo>⏟</mo></munder>'))).toContain('<m:groupChr>');
    expect(mathmlToOmml(math('<munder><mi>lim</mi><mrow><mi>n</mi></mrow></munder>'))).toContain(
      '<m:limLow>'
    );
  });

  it('converts prescripts', () => {
    const omml = mathmlToOmml(
      math('<mmultiscripts><mi>X</mi><mprescripts></mprescripts><mn>1</mn><mn>2</mn></mmultiscripts>')
    );
    expect(omml).toContain('<m:sPre>');
  });

  it('wraps a displayed equation in m:oMathPara', () => {
    const omml = mathmlToOmml(math('<mi>x</mi>', 'block'));
    expect(omml).toContain('<m:oMathPara>');
    expect(omml).toContain('<m:jc m:val="center"/>');
  });

  it('drops invisible operators', () => {
    const omml = mathmlToOmml(math('<mi>f</mi><mo>&#x2061;</mo><mi>x</mi>'));
    expect(omml).not.toContain('⁡');
  });

  it('resolves named entities XML does not define', () => {
    const omml = mathmlToOmml(math('<mi>&alpha;</mi>'));
    expect(omml).toContain('α');
  });

  it('escapes an unknown entity instead of losing the equation', () => {
    const omml = mathmlToOmml(math('<mi>&nosuchentity;</mi>'));
    expect(omml).toContain('&amp;nosuchentity;');
  });

  it('preserves significant whitespace', () => {
    const omml = mathmlToOmml(math('<mi>a</mi><mtext> </mtext><mi>b</mi>'));
    expect(omml).toContain('xml:space="preserve"');
  });

  it('returns an empty string when the MathML cannot be parsed', () => {
    expect(mathmlToOmml('not mathml')).toBe('');
    expect(mathmlToOmml('')).toBe('');
  });
});

describe('ommlParagraphJustification', () => {
  it('reads the justification of a displayed equation', () => {
    expect(
      ommlParagraphJustification(
        '<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr>' +
          '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>'
      )
    ).toBe('left');
  });

  it('reports nothing for an inline equation or an unstated justification', () => {
    expect(ommlParagraphJustification('<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>')).toBeNull();
    expect(
      ommlParagraphJustification('<m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>')
    ).toBeNull();
  });

  it('rejects a value ECMA-376 does not define', () => {
    expect(
      ommlParagraphJustification(
        '<m:oMathPara><m:oMathParaPr><m:jc m:val="sideways"/></m:oMathParaPr>' +
          '<m:oMath/></m:oMathPara>'
      )
    ).toBeNull();
  });

  it('survives OMML it cannot parse', () => {
    expect(ommlParagraphJustification('<m:oMathPara not xml')).toBeNull();
  });

  it('round-trips a justification the user did not change', () => {
    const source =
      '<m:oMathPara><m:oMathParaPr><m:jc m:val="right"/></m:oMathParaPr>' +
      '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>';
    const justification = ommlParagraphJustification(source);
    const rebuilt = mathmlToOmml(math('<mi>x</mi>', 'block'), {
      display: 'block',
      justification: justification ?? 'center',
    });
    expect(ommlParagraphJustification(rebuilt)).toBe('right');
  });
});
