/**
 * Plain-text form of an equation.
 *
 * Word stores one alongside every equation, and the editor keeps it for three
 * things: the fallback the painter shows when MathML cannot be rendered, the
 * text the AI assistant sees when it reads a selection, and the accessible
 * label. It is a lossy flattening on purpose — `x²` becomes `x2` — so it is
 * never the source the editor round-trips through.
 */

import { parseXml, getChildElements, getLocalName, getTextContent, type XmlElement } from '../docx/xmlParser';

const INVISIBLE = new Set(['⁡', '⁢', '⁣', '⁤']);
const TOKEN_TAGS = new Set(['mi', 'mn', 'mo', 'mtext', 'ms']);

/** Flatten a MathML fragment to the literals it contains. */
export function mathmlPlainText(mathml: string): string {
  const trimmed = (mathml || '').trim();
  if (!trimmed) return '';

  let root: XmlElement | null = null;
  try {
    root = getChildElements(parseXml(trimmed))[0] ?? null;
  } catch {
    return '';
  }
  if (!root) return '';

  const parts: string[] = [];
  collect(root, parts);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function collect(el: XmlElement, out: string[]): void {
  const name = getLocalName(el.name ?? '');
  if (name === 'annotation' || name === 'annotation-xml') return;

  if (TOKEN_TAGS.has(name)) {
    const text = getTextContent(el);
    out.push([...text].filter((ch) => !INVISIBLE.has(ch)).join(''));
    return;
  }

  for (const child of getChildElements(el)) collect(child, out);
}
