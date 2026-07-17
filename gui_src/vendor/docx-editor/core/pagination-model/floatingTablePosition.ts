/**
 * Horizontal placement of a `w:tblpPr` positioned table.
 *
 * Three call sites need the same answer — the wrap-zone extractor and the
 * full-width-float demotion check in the flow model, and the composer that
 * finally places the fragment. They resolved `tblpXSpec` independently and the
 * composer's copy forgot the spec entirely (a `tblpXSpec="center"` table
 * painted at the left margin while its wrap zone was centered), so the
 * resolution lives here and nowhere else.
 *
 * @packageDocumentation
 */

import type { TableFloatingAnchor, TableBlock } from './types';

/**
 * X of the table's left edge relative to the content-box left edge, px.
 *
 * Resolution order per `w:tblpPr` (§17.4.57): a `tblpXSpec` keyword supersedes
 * any `tblpX` offset ("that value is ignored"), then the explicit `tblpX`
 * offset, then the table's own `w:jc` justification, then the left margin.
 * `inside`/`outside` resolve as `left`/`right` — the editor does not model
 * facing pages.
 */
export function resolveFloatingTableX(
  anchor: TableFloatingAnchor,
  justification: TableBlock['justification'],
  tableWidth: number,
  contentWidth: number
): number {
  // An over-wide table pins to the left content edge rather than overhanging
  // the left margin; an explicit tblpX may be negative on purpose.
  const clamp = (x: number) => Math.max(0, x);
  const spec = anchor.tblpXSpec;
  if (spec === 'left' || spec === 'inside') return 0;
  if (spec === 'right' || spec === 'outside') return clamp(contentWidth - tableWidth);
  if (spec === 'center') return clamp((contentWidth - tableWidth) / 2);
  if (anchor.tblpX !== undefined) return anchor.tblpX;
  if (justification === 'center') return clamp((contentWidth - tableWidth) / 2);
  if (justification === 'right') return clamp(contentWidth - tableWidth);
  return 0;
}
