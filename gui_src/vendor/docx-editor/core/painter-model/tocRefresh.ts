import type { Node as PMNode } from 'prosemirror-model';

import { findTableOfContentsBlocks } from '../prosemirror/toc';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const TOC_BOUNDARY_CLASS = 'layout-block-sdt-box--has-toc-refresh';
export const TOC_REFRESH_PROXY_FOCUSED_CLASS = 'layout-toc-refresh--proxy-focused';
const REFRESH_SELECTOR = '[data-toc-refresh]';

export interface SyncTocRefreshOptions {
  doc: PMNode;
  label: string;
  /** Stable generation for the painted pages root; unchanged on selection-only overlay refresh. */
  paintGeneration?: string | number | null;
  /** Stable descriptor key for the currently focused accessible proxy. */
  focusedTocKey?: string | null;
}

export interface PaintedPagesReadyDetail {
  paintGeneration: number;
}

export type PaintedPagesReadyEvent = CustomEvent<PaintedPagesReadyDetail>;

/** Cache inputs for skipping redundant TOC scans on selection-only overlay refresh. */
export interface TocRefreshSyncCache {
  doc: PMNode | null;
  paintRoot: HTMLElement | null;
  paintGeneration: string | number | null;
  label: string | null;
  descriptors: TocRefreshDescriptor[];
}

export function createTocRefreshSyncCache(): TocRefreshSyncCache {
  return {
    doc: null,
    paintRoot: null,
    paintGeneration: null,
    label: null,
    descriptors: [],
  };
}

export interface TocRefreshDescriptor {
  key: string;
  position: number;
}

/**
 * Stable adapter identity for accessible TOC proxies. Imported SDT ids survive
 * position shifts; inserted/id-less TOCs fall back to logical TOC order.
 */
export function getTocRefreshDescriptors(doc: PMNode): TocRefreshDescriptor[] {
  const idOccurrences = new Map<string, number>();
  return findTableOfContentsBlocks(doc).map((block, index) => {
    const rawId = block.node.attrs.id;
    if (rawId == null || rawId === '') {
      return { key: `toc-order:${index}`, position: block.pos };
    }
    const id = String(rawId);
    const occurrence = idOccurrences.get(id) ?? 0;
    idOccurrences.set(id, occurrence + 1);
    return { key: `sdt-id:${id}:${occurrence}`, position: block.pos };
  });
}

function resolvePaintGeneration(
  container: HTMLElement,
  options: SyncTocRefreshOptions
): string | number | null {
  return options.paintGeneration ?? container.dataset.paintGeneration ?? null;
}

export function shouldSyncTocRefreshButtons(
  container: HTMLElement,
  options: SyncTocRefreshOptions,
  cache: TocRefreshSyncCache
): boolean {
  const paintGeneration = resolvePaintGeneration(container, options);
  const inputsUnchanged =
    cache.doc === options.doc &&
    cache.paintRoot === container &&
    cache.paintGeneration === paintGeneration;
  if (!inputsUnchanged) return true;

  return !hasCompleteTocRefreshButtons(container, cache.descriptors);
}

function matchingBoundaryBoxes(container: HTMLElement, position: number): HTMLElement[] {
  const groupId = `sdt@${position}`;
  return [...container.querySelectorAll<HTMLElement>('.layout-block-sdt-box')].filter(
    (box) => box.dataset.sdtGroupId === groupId
  );
}

function hasCompleteTocRefreshButtons(
  container: HTMLElement,
  descriptors: TocRefreshDescriptor[]
): boolean {
  let expectedButtonCount = 0;
  for (const descriptor of descriptors) {
    const boxes = matchingBoundaryBoxes(container, descriptor.position);
    if (boxes.length === 0) return false;
    expectedButtonCount += boxes.length;
    for (const box of boxes) {
      const buttons = box.querySelectorAll<HTMLElement>(':scope > [data-toc-refresh]');
      if (
        buttons.length !== 1 ||
        buttons[0]?.dataset.tocPosition !== String(descriptor.position) ||
        buttons[0]?.dataset.tocKey !== descriptor.key
      ) {
        return false;
      }
    }
  }
  return container.querySelectorAll(REFRESH_SELECTOR).length === expectedButtonCount;
}

/**
 * Remove painted TOC refresh affordances. Idempotent — safe on unmount and
 * read-only transitions when the pages root persists without a repaint.
 */
export function cleanupTocRefreshButtons(container: HTMLElement): void {
  for (const button of container.querySelectorAll<HTMLElement>(REFRESH_SELECTOR)) {
    button.remove();
  }
  for (const box of container.querySelectorAll<HTMLElement>(`.${TOC_BOUNDARY_CLASS}`)) {
    box.classList.remove(TOC_BOUNDARY_CLASS, TOC_REFRESH_PROXY_FOCUSED_CLASS);
  }
  for (const button of container.querySelectorAll<HTMLElement>(
    `.layout-toc-refresh.${TOC_REFRESH_PROXY_FOCUSED_CLASS}`
  )) {
    button.classList.remove(TOC_REFRESH_PROXY_FOCUSED_CLASS);
  }
}

/**
 * Mirror accessible-proxy keyboard focus onto every painted boundary/button for
 * one TOC so sighted keyboard users see the inline affordance.
 */
export function applyTocRefreshProxyFocus(container: HTMLElement, position: number | null): void {
  const posKey = position == null ? null : String(position);
  for (const box of container.querySelectorAll<HTMLElement>('.layout-block-sdt-box')) {
    const button = box.querySelector<HTMLElement>('.layout-toc-refresh');
    const matches = posKey != null && button?.dataset.tocPosition === posKey;
    box.classList.toggle(TOC_REFRESH_PROXY_FOCUSED_CLASS, matches);
    if (button) button.classList.toggle(TOC_REFRESH_PROXY_FOCUSED_CLASS, matches);
  }
}

/**
 * Synchronize inline TOC refresh buttons on painted SDT boundaries.
 * Idempotent: strips prior buttons/classes before rebuilding for every TOC.
 */
export function syncTocRefreshButtons(
  container: HTMLElement,
  options: SyncTocRefreshOptions,
  cache?: TocRefreshSyncCache
): void {
  const paintGeneration = resolvePaintGeneration(container, options);
  if (cache && !shouldSyncTocRefreshButtons(container, options, cache)) {
    if (cache.label !== options.label) {
      updateRefreshButtonLabels(container, options.label);
      cache.label = options.label;
    }
    return;
  }

  cleanupTocRefreshButtons(container);

  const descriptors = getTocRefreshDescriptors(options.doc);
  const doc = container.ownerDocument;

  for (const descriptor of descriptors) {
    for (const box of matchingBoundaryBoxes(container, descriptor.position)) {
      box.classList.add(TOC_BOUNDARY_CLASS);

      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'layout-toc-refresh';
      button.dataset.tocRefresh = '';
      button.dataset.tocPosition = String(descriptor.position);
      button.dataset.tocKey = descriptor.key;
      button.setAttribute('aria-hidden', 'true');
      button.tabIndex = -1;
      button.title = options.label;
      button.appendChild(createTocRefreshIcon(doc));
      box.appendChild(button);
    }
  }

  if (options.focusedTocKey != null) {
    const focused = descriptors.find((descriptor) => descriptor.key === options.focusedTocKey);
    applyTocRefreshProxyFocus(container, focused?.position ?? null);
  }

  if (cache) {
    if (hasCompleteTocRefreshButtons(container, descriptors)) {
      cache.doc = options.doc;
      cache.paintRoot = container;
      cache.paintGeneration = paintGeneration;
      cache.label = options.label;
      cache.descriptors = descriptors;
    }
  }
}

function updateRefreshButtonLabels(container: HTMLElement, label: string): void {
  for (const button of container.querySelectorAll<HTMLElement>(REFRESH_SELECTOR)) {
    button.title = label;
  }
}

/** Circular-arrow refresh icon — matches the context-menu UpdateTocIcon paths. */
function createTocRefreshIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const arc = doc.createElementNS(SVG_NS, 'path');
  arc.setAttribute('d', 'M12.5 5.2A5 5 0 104 13');
  arc.setAttribute('stroke', 'currentColor');
  arc.setAttribute('stroke-width', '1.5');
  arc.setAttribute('stroke-linecap', 'round');

  const arrow = doc.createElementNS(SVG_NS, 'path');
  arrow.setAttribute('d', 'M12.5 5.2h-3M12.5 5.2V2.3');
  arrow.setAttribute('stroke', 'currentColor');
  arrow.setAttribute('stroke-width', '1.5');
  arrow.setAttribute('stroke-linecap', 'round');

  svg.appendChild(arc);
  svg.appendChild(arrow);
  return svg;
}
