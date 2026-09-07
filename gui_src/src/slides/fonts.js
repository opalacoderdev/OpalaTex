// Font resolution shared by every HTML/CSS presentation surface.
//
// A text box is allowed to contain ordinary prose and Unicode mathematical
// notation in the same string. Theme faces such as Inter do not contain all
// combining marks and operators (notably U+20D7 and U+2212), while the STIX
// font already shipped for equation elements does. Put it immediately before
// the final CSS generic family: the chosen prose face still draws every glyph
// it owns, and STIX is consulted only for characters that face cannot draw.

const MATH_FALLBACK = "'STIX Two Math', 'Noto Sans Math', 'Cambria Math', 'DejaVu Math TeX Gyre'";
const GENERIC_FAMILY_AT_END = /(?:,\s*)?(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|fangsong)\s*$/i;

export function fontFamilyWithMathFallback(fontFamily) {
  const family = String(fontFamily || '').trim();
  if (!family) return `${MATH_FALLBACK}, sans-serif`;
  if (/(['"]?)STIX Two Math\1/i.test(family)) return family;

  const generic = GENERIC_FAMILY_AT_END.exec(family);
  if (!generic) return `${family}, ${MATH_FALLBACK}`;

  const before = family.slice(0, generic.index).replace(/,\s*$/, '').trim();
  return `${before ? `${before}, ` : ''}${MATH_FALLBACK}, ${generic[1]}`;
}

