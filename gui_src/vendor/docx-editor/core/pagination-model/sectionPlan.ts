/**
 * Section geometry, resolved once into a schedule.
 *
 * A document's `w:sectPr` set is the awkward part of OOXML pagination: the
 * properties of a section are written at its *end*, on the paragraph that
 * closes it, and the last section's properties hang off the body instead of any
 * paragraph at all. Reading them while flowing would mean a mutable
 * "pending geometry" state machine — the pen is on page 4 with margins we won't
 * know are wrong until node 200.
 *
 * So we don't. One pass up front turns the breaks into an immutable schedule,
 * and the flow stage only ever *looks up* the geometry in force at a node.
 * A page's size is a lookup, never the product of accumulated mutations.
 *
 * @packageDocumentation
 */

import type { ContentNode, SectionLayoutConfig } from './types';

/**
 * Which geometry governs which nodes.
 *
 * `configs[k]` is the geometry of section `k`. `breakIndices[k]` is the node
 * index of the `sectionBreak` that *ends* section `k` — so section `k` covers
 * the nodes up to and including that break, and there is always one more
 * config than there are breaks (the trailing section, which no break closes).
 */
export interface SectionPlan {
  configs: SectionLayoutConfig[];
  breakIndices: number[];
}

/**
 * Resolve the section breaks in `nodes` into a schedule.
 *
 * A `sectionBreak` node carries the properties of the section it *closes*, not
 * the one it opens — that is how `w:sectPr` is authored (§17.6.18). Fields it
 * leaves out inherit from the section before it; a section that declares no
 * `w:cols` is single-column, so columns are the one thing that does *not*
 * inherit (an absent `w:cols` means one column, not "same as last time").
 *
 * @param initialConfig - geometry of the first section
 * @param finalConfig - geometry of the body's trailing `w:sectPr`
 */
export function collectSectionConfigs(
  nodes: ContentNode[],
  initialConfig: SectionLayoutConfig,
  finalConfig: SectionLayoutConfig
): SectionPlan {
  const configs: SectionLayoutConfig[] = [];
  const breakIndices: number[] = [];

  let inherited = initialConfig;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind !== 'sectionBreak') continue;

    const config: SectionLayoutConfig = {
      pageSize: node.pageSize ?? inherited.pageSize,
      margins: node.margins ?? inherited.margins,
      columns: node.columns,
      startType: node.type,
      headerFooterRefs: node.headerFooterRefs ?? inherited.headerFooterRefs,
    };

    configs.push(config);
    breakIndices.push(i);
    inherited = config;
  }

  configs.push(finalConfig);
  return { configs, breakIndices };
}
