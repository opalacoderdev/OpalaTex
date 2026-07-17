import type { ParagraphFormatting } from '../../types/document';

export interface DirectIndentSemantics {
  hasLeft: boolean;
  hasFirstLine: boolean;
  hasFirstLineAttribute: boolean;
  allZeroComposite: boolean;
}

const INDENT_ATTRS = ['left', 'start', 'right', 'end', 'firstLine', 'hanging'] as const;
type DirectIndentSource = NonNullable<
  NonNullable<ParagraphFormatting['_indentProvenance']>['source']
>;

function isExactIntegerZero(raw: string | null): boolean {
  return raw !== null && /^[+-]?0+$/.test(raw.trim());
}

/**
 * Interpret raw direct indentation without changing the source formatting.
 *
 * Numbered paragraphs sometimes carry an all-zero composite while retaining
 * their numbering level's marker geometry. `allZeroComposite` lets numbering
 * fallback recognize that case; paragraph styles must still be cleared by the
 * direct zero values. Exact zero first-line values clear style hanging indents,
 * while numbering fallback treats them as absent. Malformed values such as
 * "0oops" and "0.5" are never neutral.
 */
export function getDirectIndentSemantics(
  source: DirectIndentSource | undefined
): DirectIndentSemantics {
  if (!source) {
    return {
      hasLeft: false,
      hasFirstLine: false,
      hasFirstLineAttribute: false,
      allZeroComposite: false,
    };
  }

  const { left, start, firstLine, hanging } = source;
  const hasLeftAttr = left !== undefined || start !== undefined;
  const hasRightAttr = source.right !== undefined || source.end !== undefined;
  const hasFirstLineAttr = firstLine !== undefined || hanging !== undefined;
  const canonicalFullClear =
    left !== undefined &&
    source.right !== undefined &&
    start === undefined &&
    source.end === undefined &&
    firstLine !== undefined &&
    hanging === undefined;
  const presentValues = INDENT_ATTRS.map((name) => source[name]).filter(
    (value): value is string => value !== undefined
  );
  const allZeroComposite =
    (hasLeftAttr || hasRightAttr) &&
    hasFirstLineAttr &&
    !canonicalFullClear &&
    presentValues.length > 0 &&
    presentValues.every((value) => isExactIntegerZero(value));

  const hasNonZeroFirstLine = [firstLine, hanging].some((raw) => {
    if (raw === undefined) return false;
    return !isExactIntegerZero(raw);
  });

  return {
    hasLeft: hasLeftAttr && !allZeroComposite,
    hasFirstLine: hasNonZeroFirstLine,
    hasFirstLineAttribute: hasFirstLineAttr,
    allZeroComposite,
  };
}
