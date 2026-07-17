import type { RevisionInfo } from '../types/content/trackedChange';

/**
 * Apply tracked-change classes + data attrs to a painted row/cell. The sidebar
 * reads the data attrs, and shared CSS keys on the revision classes.
 */
export function applyRevisionAttrs(
  el: HTMLElement,
  scope: 'row' | 'cell',
  kind: 'ins' | 'del' | 'merge',
  info: RevisionInfo
): void {
  el.classList.add(`ep-revision-${scope}`, `ep-revision-${kind}`);
  el.dataset.revisionId = String(info.revisionId);
  el.dataset.revisionAuthor = info.author;
  if (info.date) el.dataset.revisionDate = info.date;
}
