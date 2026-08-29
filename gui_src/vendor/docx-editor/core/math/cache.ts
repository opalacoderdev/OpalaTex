/**
 * Memoized OMML -> MathML conversion.
 *
 * The layout pass converts every equation on every relayout. Parsing the same
 * OMML repeatedly is pure waste: the OMML string is the identity of the
 * equation, and it only changes when the user edits it.
 */

import { ommlToMathml } from './ommlToMathml';

const CACHE = new Map<string, string>();
const MAX_ENTRIES = 2000;

/** Convert an equation's OMML to MathML, reusing the previous result. */
export function mathmlForOmml(ommlXml: string, display: 'inline' | 'block'): string {
  if (!ommlXml) return '';

  const key = `${display}|${ommlXml}`;
  const cached = CACHE.get(key);
  if (cached !== undefined) return cached;

  const mathml = ommlToMathml(ommlXml, { display });
  if (CACHE.size >= MAX_ENTRIES) CACHE.clear();
  CACHE.set(key, mathml);
  return mathml;
}

/** Drop every memoized conversion. */
export function clearMathmlCache(): void {
  CACHE.clear();
}
