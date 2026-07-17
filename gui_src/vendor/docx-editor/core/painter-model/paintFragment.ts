/**
 * The fallback fragment painter.
 *
 * `paintPage` dispatches each fragment to its specialist renderer — paragraph,
 * table, image, text box — by matching the fragment's `kind` against the block
 * and measure it looked up. When that match *fails*, this is what paints
 * instead: a block whose lookup entry is missing, or whose measure doesn't agree
 * with its fragment kind.
 *
 * That only happens when something upstream is inconsistent, so the useful thing
 * to paint is not "nothing" — an invisible hole is the hardest kind of layout
 * bug to find. It's an element that occupies the fragment's box and still
 * carries its identity: the dataset attrs that hit-testing, selection mapping,
 * and scroll anchoring read. A document with one broken fragment stays navigable
 * instead of losing its position map.
 *
 * The element is deliberately *unpositioned*. The caller applies the geometry
 * (`applyFragmentStyles` / `applyFragmentPosition`) to every fragment element
 * uniformly, and a renderer that positioned itself would be positioned twice.
 *
 * @packageDocumentation
 */

import type { Fragment } from '../pagination-model/types';
import type { RenderContext } from './paintPage';

/**
 * Class names for the generic fragment element. Same `layout-*` family as the
 * specialist renderers, so a stylesheet or a query can reach it the same way.
 *
 * @public
 */
export const FRAGMENT_CLASS_NAMES = {
  fragment: 'layout-fragment',
  placeholder: 'layout-fragment-placeholder',
};

/**
 * Options for {@link paintFragment}.
 *
 * @public
 */
export interface PaintFragmentOptions {
  /** The document to create elements in — an offscreen one, when printing. */
  document?: Document;
}

/**
 * Paint a fragment that has no specialist renderer.
 *
 * @public
 */
export function paintFragment(
  fragment: Fragment,
  context: RenderContext,
  config: PaintFragmentOptions = {}
): HTMLElement {
  void context;
  const doc = config.document ?? document;

  const el = doc.createElement('div');
  el.className = `${FRAGMENT_CLASS_NAMES.fragment} ${FRAGMENT_CLASS_NAMES.placeholder}`;

  // Identity, so the fragment stays addressable even though its content didn't
  // paint. Everything downstream — click → position, position → rect, scroll
  // restore — reads these and nothing else.
  el.dataset.blockId = String(fragment.nodeId);
  if (fragment.docFrom !== undefined) el.dataset.docFrom = String(fragment.docFrom);
  if (fragment.docTo !== undefined) el.dataset.docTo = String(fragment.docTo);

  return el;
}
