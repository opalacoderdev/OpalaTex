/**
 * Border resolution: the authored `w:pBdr` / `w:tcBorders` spec → a painted edge.
 *
 * Three things happen here, and they all have to happen at this boundary rather
 * than at paint time:
 *
 *  - **Units.** `w:sz` is eighths of a point and `w:space` is points; the
 *    painter wants px.
 *  - **Theme colours.** `w:color` may be a theme reference with a tint or shade;
 *    resolving it needs the theme, which the painter doesn't carry.
 *  - **Absence.** `w:val="none"` and `w:val="nil"` mean *there is no border* —
 *    not "a border of style none". Collapsing them to `undefined` here is what
 *    lets every downstream reader treat a border as a simple truthy check.
 *
 * @packageDocumentation
 */

import type { BorderKind, ParagraphBorders } from '../../pagination-model/types';
import type { BorderSpec } from '../../types/colors';
import type { Theme } from '../../types/document';
import { resolveColorToHex } from '../../utils/colorResolver';
import { eighthsToPixels, pointsToPixels } from '../../utils/units';

/** A border with no colour is black. */
const DEFAULT_BORDER_COLOR = '#000000';

/** The `w:val` values that mean "no border here". */
const ABSENT_STYLES: ReadonlySet<string> = new Set(['none', 'nil']);

/** Convert OOXML border kinds to values accepted by CSS `border-style`. */
function borderStyleToCss(style: string): BorderKind['style'] {
  switch (style) {
    case 'double':
    case 'triple':
      return 'double';
    case 'dotted':
      return 'dotted';
    case 'dashed':
    case 'dashSmallGap':
      return 'dashed';
    case 'threeDEmboss':
      return 'ridge';
    case 'threeDEngrave':
      return 'groove';
    case 'outset':
      return 'outset';
    case 'inset':
      return 'inset';
    default:
      return 'solid';
  }
}

/**
 * Widest border we will draw, px.
 *
 * `w:sz` is a number from the file, and nothing in the format bounds it. Word
 * caps borders at 6pt; a crafted `w:sz="99999"` would otherwise paint a
 * ~3000px rule across the page and hide the document behind it.
 */
const MAX_BORDER_WIDTH_PX = 12;

/**
 * Resolve one authored border edge, or `undefined` when the document says there
 * isn't one.
 *
 * @public
 */
export function convertBorderSpecToLayout(
  border: BorderSpec,
  theme?: Theme | null
): BorderKind | undefined {
  if (!border.style || ABSENT_STYLES.has(border.style)) return undefined;

  const authored = border.size !== undefined ? eighthsToPixels(border.size) : 1;
  if (!Number.isFinite(authored) || authored <= 0) return undefined;

  const width = Math.min(authored, MAX_BORDER_WIDTH_PX);
  const resolvedColor = resolveColorToHex(border.color, theme);

  const kind: BorderKind = {
    style: borderStyleToCss(border.style),
    width,
    color: resolvedColor ? `#${resolvedColor}` : DEFAULT_BORDER_COLOR,
  };

  if (border.space != null) kind.space = pointsToPixels(border.space);
  if (border.shadow) kind.shadow = true;

  return kind;
}

/**
 * Pull a table cell's four border edges out of its ProseMirror attrs.
 *
 * The attrs arrive untyped (they're a PM node's attribute bag), so this is the
 * trust boundary for them: unknown shapes are dropped rather than passed on.
 * Returns `undefined` when the cell has no visible border at all, so callers can
 * skip the whole edge-drawing path.
 *
 * @public
 */
export function readBorderAttrs(
  attrs: Record<string, unknown>,
  theme?: Theme | null
): ParagraphBorders | undefined {
  const authored = attrs.borders;
  if (!authored || typeof authored !== 'object') return undefined;

  const sides = authored as Partial<Record<keyof ParagraphBorders, unknown>>;
  const borders: ParagraphBorders = {};
  let any = false;

  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const spec = sides[side];
    if (!isBorderSpec(spec)) continue;

    const resolved = convertBorderSpecToLayout(spec, theme);
    if (!resolved) continue;

    borders[side] = resolved;
    any = true;
  }

  return any ? borders : undefined;
}

/** A file-derived value only counts as a border if it actually names a style. */
function isBorderSpec(value: unknown): value is BorderSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { style?: unknown }).style === 'string'
  );
}
