/**
 * Equation conversion between Word's OMML and MathML.
 *
 * The document model stores equations as OMML (that is what a .docx holds and
 * what Word, LibreOffice, and Pages read). Everything else in the app speaks
 * MathML: the painter renders it natively, and the equation editor edits it.
 */

export { ommlToMathml, type OmmlToMathmlOptions } from './ommlToMathml';
export { mathmlToOmml, type MathmlToOmmlOptions } from './mathmlToOmml';
export { mathmlToLatex } from './mathmlToLatex';
export { mathmlPlainText } from './mathmlPlainText';
export { ommlParagraphJustification, type MathJustification } from './ommlProperties';
export { tokenizeMathText, NARY_OPERATORS, type MathToken } from './shared';
export { mathmlForOmml, clearMathmlCache } from './cache';
