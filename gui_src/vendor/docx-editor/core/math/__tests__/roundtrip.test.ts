/**
 * Round-trip stability.
 *
 * An equation the user edits goes OMML -> MathML -> editor -> MathML -> OMML.
 * The conversion cannot be lossless (MathML has no `m:ctrlPr`, OMML has no
 * `mathvariant`), but it must be *stable*: converting an already-converted
 * equation again has to land on the same MathML. Otherwise every save would
 * nudge the markup a little further from what Word wrote, and equations would
 * drift over a document's lifetime.
 */

import { describe, expect, it } from 'vitest';
import { ommlToMathml } from '../ommlToMathml';
import { mathmlToOmml } from '../mathmlToOmml';

/** OMML as Word actually writes it, one sample per construct that matters. */
const SAMPLES: Record<string, string> = {
  'quadratic formula':
    '<m:oMath><m:r><m:t>x=</m:t></m:r><m:f><m:num><m:r><m:t>-b±</m:t></m:r>' +
    '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e>' +
    '<m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>-4ac</m:t></m:r></m:e></m:rad></m:num>' +
    '<m:den><m:r><m:t>2a</m:t></m:r></m:den></m:f></m:oMath>',

  summation:
    '<m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>' +
    '<m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup>' +
    '<m:e><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub></m:e></m:nary></m:oMath>',

  'definite integral':
    '<m:oMath><m:nary><m:naryPr><m:chr m:val="∫"/><m:limLoc m:val="subSup"/></m:naryPr>' +
    '<m:sub><m:r><m:t>a</m:t></m:r></m:sub><m:sup><m:r><m:t>b</m:t></m:r></m:sup>' +
    '<m:e><m:r><m:t>f</m:t></m:r><m:d><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d>' +
    '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>d</m:t></m:r><m:r><m:t>x</m:t></m:r></m:e></m:nary></m:oMath>',

  matrix:
    '<m:oMath><m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>' +
    '<m:m><m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr>' +
    '<m:mr><m:e><m:r><m:t>c</m:t></m:r></m:e><m:e><m:r><m:t>d</m:t></m:r></m:e></m:mr></m:m>' +
    '</m:e></m:d></m:oMath>',

  'nth root':
    '<m:oMath><m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>x+1</m:t></m:r></m:e></m:rad></m:oMath>',

  accent:
    '<m:oMath><m:acc><m:accPr><m:chr m:val="̂"/></m:accPr><m:e><m:r><m:t>y</m:t></m:r></m:e></m:acc></m:oMath>',

  overbar:
    '<m:oMath><m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e><m:r><m:t>z</m:t></m:r></m:e></m:bar></m:oMath>',

  'under brace':
    '<m:oMath><m:groupChr><m:groupChrPr><m:chr m:val="⏟"/><m:pos m:val="bot"/><m:vertJc m:val="top"/></m:groupChrPr>' +
    '<m:e><m:r><m:t>a+b</m:t></m:r></m:e></m:groupChr></m:oMath>',

  limit:
    '<m:oMath><m:func><m:fName><m:limLow><m:e><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>lim</m:t></m:r></m:e>' +
    '<m:lim><m:r><m:t>n→∞</m:t></m:r></m:lim></m:limLow></m:fName>' +
    '<m:e><m:sSub><m:e><m:r><m:t>a</m:t></m:r></m:e><m:sub><m:r><m:t>n</m:t></m:r></m:sub></m:sSub></m:e></m:func></m:oMath>',

  'sub and superscript':
    '<m:oMath><m:sSubSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub>' +
    '<m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSubSup></m:oMath>',

  prescript:
    '<m:oMath><m:sPre><m:sub><m:r><m:t>1</m:t></m:r></m:sub><m:sup><m:r><m:t>2</m:t></m:r></m:sup>' +
    '<m:e><m:r><m:t>X</m:t></m:r></m:e></m:sPre></m:oMath>',

  binomial:
    '<m:oMath><m:d><m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr>' +
    '<m:num><m:r><m:t>n</m:t></m:r></m:num><m:den><m:r><m:t>k</m:t></m:r></m:den></m:f></m:e></m:d></m:oMath>',

  'displayed equation':
    '<m:oMathPara><m:oMath><m:r><m:t>E=m</m:t></m:r>' +
    '<m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara>',

  'boldface vector':
    '<m:oMath><m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>v</m:t></m:r>' +
    '<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>=</m:t></m:r>' +
    '<m:r><m:rPr><m:scr m:val="double-struck"/><m:sty m:val="p"/></m:rPr><m:t>R</m:t></m:r></m:oMath>',
};

describe('OMML round-trip', () => {
  for (const [name, omml] of Object.entries(SAMPLES)) {
    it(`is stable for a ${name}`, () => {
      const mathml = ommlToMathml(omml);
      expect(mathml).not.toBe('');

      const rebuilt = mathmlToOmml(mathml);
      expect(rebuilt).not.toBe('');

      const secondPass = ommlToMathml(rebuilt);
      expect(secondPass).toBe(mathml);
    });
  }

  it('keeps a displayed equation displayed', () => {
    const mathml = ommlToMathml(SAMPLES['displayed equation']);
    expect(mathml).toContain('display="block"');
    expect(mathmlToOmml(mathml)).toContain('<m:oMathPara>');
  });
});
