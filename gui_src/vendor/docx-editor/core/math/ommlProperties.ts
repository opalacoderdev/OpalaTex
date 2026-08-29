/**
 * Properties read off an OMML fragment without converting it.
 *
 * A displayed equation (`m:oMathPara`) carries its own justification, which is
 * a paragraph-level decision MathML has no way to express. The layout needs it
 * before any conversion happens, and an edit has to carry it through, so it is
 * read straight from the OMML.
 */

import { parseXml, getChildElements, getLocalName, type XmlElement } from '../docx/xmlParser';

/** `m:oMathParaPr/m:jc` values, as ECMA-376 defines them. */
export type MathJustification = 'left' | 'center' | 'right' | 'centerGroup';

const VALID: ReadonlySet<string> = new Set(['left', 'center', 'right', 'centerGroup']);

/**
 * Justification of a displayed equation, or null when the fragment is not a
 * `m:oMathPara` or does not state one (Word then falls back to the document's
 * `m:mathPr/m:defJc`, which is `centerGroup` in a default document).
 */
export function ommlParagraphJustification(ommlXml: string): MathJustification | null {
  const trimmed = (ommlXml || '').trim();
  if (!trimmed.includes('oMathPara')) return null;

  let root: XmlElement | null = null;
  try {
    root = getChildElements(parseXml(trimmed))[0] ?? null;
  } catch {
    return null;
  }
  if (!root || getLocalName(root.name ?? '') !== 'oMathPara') return null;

  for (const child of getChildElements(root)) {
    if (getLocalName(child.name ?? '') !== 'oMathParaPr') continue;
    for (const prop of getChildElements(child)) {
      if (getLocalName(prop.name ?? '') !== 'jc') continue;
      const attrs = (prop.attributes ?? {}) as Record<string, string>;
      const value = String(attrs['m:val'] ?? attrs['val'] ?? '');
      return VALID.has(value) ? (value as MathJustification) : null;
    }
  }
  return null;
}
