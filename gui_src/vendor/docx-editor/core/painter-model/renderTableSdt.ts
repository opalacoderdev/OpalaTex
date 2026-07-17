import type { SdtGroup } from '../pagination-model/types';
import type { SdtBoundaryExtent } from './sdtBoundary';

export function tagSdtCellBlock(
  el: HTMLElement,
  extents: SdtBoundaryExtent[],
  groups: SdtGroup[] | undefined,
  top: number,
  bottom: number
): void {
  if (!groups || groups.length === 0) return;

  const innermost = groups[groups.length - 1];
  if (!innermost) return;

  el.classList.add('layout-block-sdt');
  el.dataset.sdtGroupId = innermost.id;
  el.dataset.sdtType = innermost.sdtType;
  el.dataset.sdtDepth = String(groups.length);
  if (innermost.tag != null) el.dataset.sdtTag = innermost.tag;
  if (innermost.alias != null) el.dataset.sdtAlias = innermost.alias;
  if (innermost.lock != null) el.dataset.sdtLock = innermost.lock;

  extents.push({ groups, top, bottom });
}
