/**
 * Helpers for Word checkbox content controls (`w14:checkbox`).
 *
 * Native Word checkbox SDTs store the checked state in `w:sdtPr`; the visible
 * `w:sdtContent` may contain only the label text. These helpers keep display
 * glyph derivation shared between PM editing commands and the visible painter
 * bridge without changing the document model.
 */

const CHECKED_FALLBACK = String.fromCodePoint(0x2612);
const UNCHECKED_FALLBACK = String.fromCodePoint(0x2610);
const KNOWN_CHECKBOX_GLYPHS = new Set([
  CHECKED_FALLBACK,
  UNCHECKED_FALLBACK,
  String.fromCodePoint(0x2611),
]);

export interface CheckboxDisplayState {
  char: string;
  fontFamily?: string;
}

function codePointChar(hex: string | undefined, fallback: string): string {
  if (!hex) return fallback;
  const n = parseInt(hex, 16);
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

function readRawAttr(raw: string, localElement: string, localAttr: string): string | undefined {
  const elementPattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localElement}\\b[^>]*>`, 'u');
  const element = elementPattern.exec(raw)?.[0];
  if (!element) return undefined;
  const attrPattern = new RegExp(`\\b(?:[A-Za-z_][\\w.-]*:)?${localAttr}="([^"]*)"`, 'u');
  return attrPattern.exec(element)?.[1];
}

export function checkboxDisplayStateFromAttrs(
  attrs: Record<string, unknown>
): CheckboxDisplayState {
  const checked = attrs.checked === true;
  const raw = typeof attrs.rawPropertiesXml === 'string' ? attrs.rawPropertiesXml : '';
  const stateElement = checked ? 'checkedState' : 'uncheckedState';
  return {
    char: codePointChar(
      readRawAttr(raw, stateElement, 'val'),
      checked ? CHECKED_FALLBACK : UNCHECKED_FALLBACK
    ),
    fontFamily: readRawAttr(raw, stateElement, 'font'),
  };
}

export function textStartsWithCheckboxGlyph(text: string, display?: CheckboxDisplayState): boolean {
  const first = text.trimStart().charAt(0);
  return first.length > 0 && (first === display?.char || KNOWN_CHECKBOX_GLYPHS.has(first));
}
