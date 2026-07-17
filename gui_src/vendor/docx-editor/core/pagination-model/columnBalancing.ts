/**
 * Column balancing.
 *
 * When a multi-column region ends — a two-column pull-quote in a one-column
 * article, or the end of the document — Word evens the columns out rather than
 * filling the first to the bottom and leaving the last nearly empty. It does
 * this by shortening the region: give every column a bottom at
 * `total / count` and the ordinary column flow produces balanced columns for
 * free, with no second pass and no fragment shuffling.
 *
 * That is what this computes: not the layout, just the *bottom* the flow should
 * use.
 *
 * BEST-EFFORT. Nothing in ECMA-376 mandates balancing, no test pins it, and it
 * has not been checked against Word — see `tasks.md` §10.1. It is deliberately
 * conservative: it declines (returns null) on anything it isn't sure about, and
 * declining just means the region flows unbalanced, which is never *wrong*, only
 * less pretty.
 *
 * @packageDocumentation
 */

import type { ColumnLayout, ContentNode, LayoutMetrics } from './types';
import { borderGapExtent, collapsedGap, spaceAfter, spaceBefore } from './blockSpacingRules';

/**
 * The region a balanced multi-column stretch flows into.
 */
export interface BalancingRegion {
  /** Y where the multi-column region begins on its page. */
  top: number;
  /** Y where the page's content box ends. */
  bottom: number;
  columns: ColumnLayout;
}

/**
 * The bottom the flow should use so `nodes[start..end)` come out balanced
 * across `region.columns`, or `null` to leave the region alone.
 *
 * Declines when:
 *
 *  - there is only one column (nothing to balance);
 *  - the stretch holds anything but paragraphs. A table or an image can't be
 *    cut to an arbitrary height, so a balanced bottom would just push it whole
 *    into the next column and unbalance things worse than doing nothing;
 *  - the content is too tall to fit the region even unbalanced — it's going to
 *    spill onto another page, and the last page's columns are what Word
 *    balances, not this one;
 *  - the balanced height isn't actually shorter than the region. Nothing to do.
 */

/**
 * Unit-cost planner used by continuous-section column balancing tests and by
 * richer balancers. Operates on abstract height units so it stays independent
 * of ContentNode identity.
 */

export type BalanceUnit = {
  height: number;
  blockIndex: number;
  /** Only the first line/unit of a block can be forced before that block. */
  startsBlock: boolean;
  /** False when normal pagination semantics require this unit to stay with its predecessor. */
  canBreakBefore?: boolean;
  spaceBefore?: number;
  spaceAfter?: number;
  consumesTrailingSpacing?: boolean;
};

export type ContinuousSectionBalancePlan = {
  height: number;
  breakBeforeBlocks: Set<number>;
};

export const MAX_BALANCE_UNITS = 512;
export const MAX_BALANCE_COLUMNS = 8;
export const MAX_BALANCE_EVALUATIONS = 1_000_000;

export type SegmentCostIndex = {
  height(start: number, end: number): number;
  /** Number of scalar metadata slots retained; exposed for non-timing resource tests. */
  storageEntries: number;
};

/** Build an O(n)-space index that answers every contiguous segment cost in O(1). */
export function createSegmentCostIndex(
  units: BalanceUnit[],
  initialTrailingSpacing: number
): SegmentCostIndex {
  const length = units.length;
  const heightPrefix = new Float64Array(length + 1);
  const spacingPrefix = new Float64Array(length + 1);
  const consumerContribution = new Float64Array(length);
  const consumerSource = new Int32Array(length);
  consumerSource.fill(-1);
  const nextConsumer = new Int32Array(length + 1);
  nextConsumer.fill(length);

  let trailingSpacing = initialTrailingSpacing;
  let trailingSource = -1;
  for (let i = 0; i < length; i++) {
    const unit = units[i];
    heightPrefix[i + 1] = heightPrefix[i] + unit.height;
    let spacing = 0;
    if (unit.spaceBefore !== undefined) {
      spacing = Math.max(trailingSpacing, unit.spaceBefore);
      consumerSource[i] = trailingSource;
      trailingSpacing = 0;
      trailingSource = -1;
    } else if (unit.consumesTrailingSpacing) {
      spacing = trailingSpacing;
      consumerSource[i] = trailingSource;
      trailingSpacing = 0;
      trailingSource = -1;
    }
    consumerContribution[i] = spacing;
    spacingPrefix[i + 1] = spacingPrefix[i] + spacing;
    if (unit.spaceAfter !== undefined) {
      trailingSpacing = unit.spaceAfter;
      trailingSource = i;
    }
  }

  for (let i = length - 1; i >= 0; i--) {
    nextConsumer[i] =
      units[i].spaceBefore !== undefined || units[i].consumesTrailingSpacing
        ? i
        : nextConsumer[i + 1];
  }

  return {
    height(start, end) {
      let result =
        heightPrefix[end] - heightPrefix[start] + spacingPrefix[end] - spacingPrefix[start];
      const firstConsumer = nextConsumer[start];
      if (firstConsumer < end && consumerSource[firstConsumer] < start) {
        const unit = units[firstConsumer];
        const incoming = start === 0 ? initialTrailingSpacing : 0;
        const replacement =
          unit.spaceBefore !== undefined ? Math.max(incoming, unit.spaceBefore) : incoming;
        result += replacement - consumerContribution[firstConsumer];
      }
      return result;
    },
    storageEntries:
      heightPrefix.length +
      spacingPrefix.length +
      consumerContribution.length +
      consumerSource.length +
      nextConsumer.length,
  };
}

export type PartitionDiagnostics = { evaluations: number };

export function partitionUnits(
  units: BalanceUnit[],
  columnCount: number,
  maxHeight: number,
  initialTrailingSpacing: number,
  diagnostics?: PartitionDiagnostics
): ContinuousSectionBalancePlan | null {
  if (diagnostics) diagnostics.evaluations = 0;
  if (units.length > MAX_BALANCE_UNITS || columnCount > MAX_BALANCE_COLUMNS) return null;
  const count = Math.min(columnCount, units.length);
  if (count <= 1) return null;
  const estimatedEvaluations = (count * units.length * (units.length + 1)) / 2;
  if (estimatedEvaluations > MAX_BALANCE_EVALUATIONS) return null;

  const segmentCosts = createSegmentCostIndex(units, initialTrailingSpacing);

  let previousCosts = new Float64Array(units.length + 1);
  previousCosts.fill(Number.POSITIVE_INFINITY);
  previousCosts[0] = 0;
  const predecessors: Int32Array[] = [new Int32Array(units.length + 1)];

  for (let columns = 1; columns <= count; columns++) {
    const currentCosts = new Float64Array(units.length + 1);
    currentCosts.fill(Number.POSITIVE_INFINITY);
    const currentPredecessors = new Int32Array(units.length + 1);
    currentPredecessors.fill(-1);
    for (let end = columns; end <= units.length; end++) {
      for (let split = columns - 1; split < end; split++) {
        if (split > 0 && units[split]?.canBreakBefore === false) continue;
        if (diagnostics) diagnostics.evaluations++;
        const columnHeight = segmentCosts.height(split, end);
        const cost = Math.max(previousCosts[split], columnHeight);
        if (cost < currentCosts[end]) {
          currentCosts[end] = cost;
          currentPredecessors[end] = split;
        }
      }
    }
    previousCosts = currentCosts;
    predecessors.push(currentPredecessors);
  }

  const height = Math.ceil(previousCosts[units.length]);
  if (!Number.isFinite(height) || height <= 0 || height > maxHeight) return null;

  const boundaries: number[] = [];
  let end = units.length;
  for (let columns = count; columns > 1; columns--) {
    const split = predecessors[columns][end];
    if (split <= 0) return null;
    boundaries.push(split);
    end = split;
  }

  const breakBeforeBlocks = new Set<number>();
  for (const boundary of boundaries) {
    const unit = units[boundary];
    if (unit?.startsBlock) breakBeforeBlocks.add(unit.blockIndex);
  }

  return { height, breakBeforeBlocks };
}

function getBalanceUnits(
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  start: number,
  end: number
): BalanceUnit[] | null {
  const units: BalanceUnit[] = [];

  // Border extents are ADDITIVE on the collapsed gap (see borderGapExtent),
  // which the max-collapse spacing model here can't express — fold them into
  // the block's first unit height instead, so the planned column heights match
  // what the composer actually places.
  let prevContent: ContentNode | null = null;

  for (let i = start; i < end; i++) {
    const node = nodes[i];
    const nodeMetrics = metrics[i];
    if (node.kind === 'sectionBreak') continue;
    const boundaryExtent = prevContent ? borderGapExtent(prevContent, node) : 0;

    if (node.kind === 'paragraph' && nodeMetrics?.kind === 'paragraph') {
      for (let line = 0; line < nodeMetrics.lines.length; line++) {
        if (units.length >= MAX_BALANCE_UNITS) return null;
        units.push({
          height:
            nodeMetrics.lines[line].lineHeight +
            (nodeMetrics.lines[line].floatSkipBefore ?? 0) +
            (line === 0 ? boundaryExtent : 0),
          blockIndex: i,
          startsBlock: line === 0,
          spaceBefore: line === 0 ? spaceBefore(node) : undefined,
          spaceAfter: line === nodeMetrics.lines.length - 1 ? spaceAfter(node) : undefined,
        });
      }
      prevContent = node;
      continue;
    }

    if (node.kind === 'table' && nodeMetrics?.kind === 'table' && !node.floating) {
      for (let row = 0; row < nodeMetrics.rows.length; row++) {
        if (units.length >= MAX_BALANCE_UNITS) return null;
        units.push({
          height: nodeMetrics.rows[row].height + (row === 0 ? boundaryExtent : 0),
          blockIndex: i,
          startsBlock: row === 0,
          consumesTrailingSpacing: row === 0,
        });
      }
      prevContent = node;
      continue;
    }

    if (node.kind === 'paragraph' || node.kind === 'table') continue;
    return null;
  }

  return units.some((unit) => unit.height > 0) ? units : null;
}

function applyKeepConstraints(units: BalanceUnit[], nodes: ContentNode[]): void {
  for (const unit of units) {
    const node = nodes[unit.blockIndex];
    if (node?.kind === 'paragraph' && node.attrs?.keepLines && !unit.startsBlock) {
      unit.canBreakBefore = false;
    }
  }

  let chainStart = -1;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node?.kind === 'paragraph' && node.attrs?.keepNext) {
      if (chainStart < 0) chainStart = i;
      continue;
    }
    if (chainStart >= 0) {
      const memberIndices = new Set<number>();
      for (let j = chainStart; j < i; j++) memberIndices.add(j);
      const anchorIndex = i;
      let seenChainStart = false;
      for (const unit of units) {
        if (memberIndices.has(unit.blockIndex)) {
          if (seenChainStart) unit.canBreakBefore = false;
          seenChainStart = true;
          continue;
        }
        if (unit.blockIndex === anchorIndex && unit.startsBlock) {
          unit.canBreakBefore = false;
        }
      }
      chainStart = -1;
    }
  }
}

/**
 * The bottom the flow should use so `nodes[start..end)` come out balanced
 * across `region.columns`, or `null` to leave the region alone.
 */

/**
 * Full continuous-section balance plan: shortened region bottom plus the
 * block indexes that must open a fresh column so legal units land correctly.
 */
export function planContinuousSectionBalance(
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  start: number,
  end: number,
  region: BalancingRegion
): ContinuousSectionBalancePlan | null {
  const count = region.columns.count;
  if (count <= 1) return null;

  const regionHeight = region.bottom - region.top;
  if (regionHeight <= 0) return null;

  const units = getBalanceUnits(nodes, metrics, start, end);
  if (!units) return null;
  applyKeepConstraints(units, nodes);
  return partitionUnits(units, count, regionHeight, 0);
}

export function balancedColumnBottom(
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  start: number,
  end: number,
  region: BalancingRegion
): number | null {
  const plan = planContinuousSectionBalance(nodes, metrics, start, end, region);
  if (plan) return region.top + plan.height;

  const count = region.columns.count;
  if (count <= 1) return null;

  const regionHeight = region.bottom - region.top;
  if (regionHeight <= 0) return null;

  const height = paragraphOnlyHeight(nodes, metrics, start, end);
  if (height === null || height <= 0) return null;
  if (height > regionHeight * count) return null;

  const balanced = Math.ceil(height / count);
  if (balanced <= 0 || balanced >= regionHeight) return null;

  return region.top + balanced;
}

function paragraphOnlyHeight(
  nodes: ContentNode[],
  metrics: LayoutMetrics[],
  start: number,
  end: number
): number | null {
  let total = 0;
  let sawText = false;
  let prev: ContentNode | null = null;

  for (let i = start; i < end; i++) {
    const node = nodes[i];
    const nodeMetrics = metrics[i];

    if (node.kind === 'sectionBreak') continue;

    if (node.kind !== 'paragraph' || nodeMetrics?.kind !== 'paragraph') return null;

    // Measure the stretch exactly the way the flow will lay it out: the
    // collapsed gap between neighbours, plus the paragraph's own lines.
    //
    // Not `spaceBefore + totalHeight + spaceAfter`. That double-counts, because
    // `totalHeight` ALREADY includes the paragraph's before/after — and it sums
    // adjacent spacing where the flow collapses it. A balanced height computed
    // from the wrong total puts the column bottom in the wrong place, which is
    // worse than not balancing at all.
    total += collapsedGap(prev, node);
    total += nodeMetrics.lines.reduce(
      (h, line) => h + line.lineHeight + (line.floatSkipBefore ?? 0),
      0
    );

    sawText ||= nodeMetrics.lines.length > 0;
    prev = node;
  }

  return sawText ? total : null;
}
