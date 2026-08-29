/**
 * MathML sanitizer.
 *
 * Equation MathML is generated from the document's OMML by `core/math`, which
 * escapes every literal it copies, so the markup it produces is already safe.
 * This is the second line: the same string is also what the equation editor
 * hands back, and it is injected into the page with `innerHTML` (there is no
 * other way to insert MathML built as text). A hostile .docx should not be one
 * converter bug away from scripting the editor, so the markup is filtered
 * against the MathML profile before it reaches the DOM.
 */

import createDOMPurify from 'dompurify';

let domPurify: ReturnType<typeof createDOMPurify> | undefined;

/**
 * Filter a MathML fragment down to presentation MathML.
 *
 * Without a DOM (tests, workers) there is nothing to inject into, so the
 * markup is returned untouched — sanitizing is a property of the injection
 * point, not of the string.
 */
export function sanitizeMathml(mathml: string): string {
  if (!mathml) return '';
  if (typeof window === 'undefined' || typeof document === 'undefined') return mathml;

  domPurify ??= createDOMPurify(window);
  return domPurify.sanitize(mathml, {
    USE_PROFILES: { mathMl: true },
    ADD_ATTR: ['display', 'mathvariant', 'linethickness', 'bevelled', 'accent', 'columnalign'],
  });
}
