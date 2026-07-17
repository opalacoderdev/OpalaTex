/**
 * Multi-page rendering with virtualization.
 *
 * For documents under VIRTUALIZATION_THRESHOLD pages, all pages render
 * eagerly. Larger documents render only pages near the viewport — off-screen
 * pages are lightweight shells (correct dimensions, no fragment content) so
 * scroll position is preserved. An IntersectionObserver populates and clears
 * page content as the user scrolls. Incremental updates (re-rendering only
 * fingerprint-changed pages) avoid blink when the document model shifts.
 */

import type { Page } from '../../pagination-model/types';
import {
  PAGE_CLASS_NAMES,
  paintPage,
  applyPageStyles,
  type RenderContext,
  type RenderPageOptions,
} from '../paintPage';
import type { FootnoteRenderItem } from './footnotes';
import { semanticDigest } from '../semanticDigest';
import { getPageFurniture } from '../pageFurnitureRegistry';

type FullPageOptions = RenderPageOptions & {
  pageGap?: number;
  footnotesByPage?: Map<number, FootnoteRenderItem[]>;
  /** Render every page eagerly for complete DOM snapshots and exports. */
  virtualize?: boolean;
};

/**
 * Build a RenderContext and resolved page config (with footnotes) for a page.
 * Centralises logic shared by populatePageShell, repopulatePageContent, and the eager render path.
 */
function buildPageRenderArgs(
  page: Page,
  totalPages: number,
  config: FullPageOptions
): { context: RenderContext; pageOptions: RenderPageOptions } {
  const context: RenderContext = {
    pageNumber: page.number,
    totalPages,
    section: 'body',
    resolvedCommentIds: config.resolvedCommentIds,
  };
  const pageOptions: RenderPageOptions = { ...config };
  const furniture = getPageFurniture(page);
  if (furniture) {
    pageOptions.headerContent = furniture.headerContent;
    pageOptions.footerContent = furniture.footerContent;
    pageOptions.firstPageHeaderContent = undefined;
    pageOptions.firstPageFooterContent = undefined;
    pageOptions.titlePg = false;
    pageOptions.headerDistance = furniture.headerDistance;
    pageOptions.footerDistance = furniture.footerDistance;
    pageOptions.pageBorders = furniture.pageBorders;
  }
  // Per-page header/footer selection when titlePg is enabled
  if (!furniture && config.titlePg && page.number === 1) {
    pageOptions.headerContent = config.firstPageHeaderContent;
    pageOptions.footerContent = config.firstPageFooterContent;
  }
  if (config.footnotesByPage) {
    const fns = config.footnotesByPage.get(page.number);
    if (fns && fns.length > 0) {
      (pageOptions as RenderPageOptions & { footnoteArea?: FootnoteRenderItem[] }).footnoteArea =
        fns;
    }
  }
  return { context, pageOptions };
}

interface PageShellState {
  element: HTMLElement;
  fingerprint: string;
  furnitureFingerprint: string;
}

interface PageContainerState {
  pageCursors: PageShellState[];
  totalPages: number;
  optionsHash: string;
  headerFooterHash: string;
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>;
  currentOptions: FullPageOptions;
}

interface PageContainer extends HTMLElement {
  __pageObserver?: IntersectionObserver;
  __pageRenderState?: PageContainerState;
}

/**
 * Compute a fingerprint that covers both layout and semantic paint inputs.
 *
 * Fragment geometry alone misses equal-length text edits, formatting, comments,
 * revisions, and image changes. `indexNodesById` versions each block together
 * with its measurement, so pages can invalidate semantically without comparing
 * or repainting the whole document.
 */
function computePageFingerprint(page: Page, config: FullPageOptions): string {
  const blockVersions = page.fragments.map((fragment) => {
    const entry = config.nodeLookup?.get(String(fragment.nodeId));
    return (
      entry?.version ??
      (entry ? semanticDigest(entry.node, entry.metrics) : `missing:${String(fragment.nodeId)}`)
    );
  });
  return semanticDigest(
    page,
    blockVersions,
    config.footnotesByPage?.get(page.number),
    getPageFurniture(page)
  );
}

function computePageFurnitureFingerprint(page: Page): string {
  return semanticDigest(page.size, page.margins, getPageFurniture(page));
}

/**
 * Render config whose changes require rebuilding the page shells.
 *
 * Header/footer content is deliberately separate: changing it should repaint
 * every currently populated shell while retaining virtualization and scroll
 * position, not tear down the whole stack.
 */
function computeOptionsHash(config: FullPageOptions): string {
  return semanticDigest({
    pageGap: config.pageGap,
    pageClassName: config.pageClassName,
    showBorders: config.showBorders,
    backgroundColor: config.backgroundColor,
    showShadow: config.showShadow,
    titlePg: config.titlePg,
    headerDistance: config.headerDistance,
    footerDistance: config.footerDistance,
    pageBorders: config.pageBorders,
    theme: config.theme,
    watermark: config.watermark,
    resolvedCommentIds: config.resolvedCommentIds,
  });
}

function computeHeaderFooterHash(config: FullPageOptions): string {
  return semanticDigest(
    config.headerContent,
    config.footerContent,
    config.firstPageHeaderContent,
    config.firstPageFooterContent
  );
}

function dispatchPainted(container: HTMLElement): void {
  const EventCtor = container.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
  container.dispatchEvent(new EventCtor('painter:painted', { bubbles: true }));
}

/**
 * Apply standard container styles for the pages wrapper.
 */
function applyContainerStyles(container: HTMLElement, pageGap: number): void {
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.alignItems = 'center';
  container.style.gap = `${pageGap}px`;
  container.style.padding = `${pageGap}px`;
  container.style.backgroundColor = 'var(--doc-bg, #f8f9fa)';
}

/** Pages to keep rendered above and below the visible area for smooth scrolling. */
const VIRTUALIZATION_BUFFER = 2;

/** Minimum page count before virtualization kicks in. */
const VIRTUALIZATION_THRESHOLD = 8;

export type RenderPagesUpdateKind = 'incremental' | 'full';

/**
 * Render multiple pages to a container with virtualization for large documents.
 *
 * For documents with fewer than VIRTUALIZATION_THRESHOLD pages, all pages
 * are rendered eagerly. For larger documents, only pages near the visible
 * viewport are fully rendered — off-screen pages are lightweight shells
 * with correct dimensions to preserve scroll position.
 *
 * An IntersectionObserver watches page elements and populates/clears
 * content as pages scroll into and out of view.
 */
export function paintPages(
  pages: Page[],
  container: HTMLElement,
  config: RenderPageOptions & {
    pageGap?: number;
    footnotesByPage?: Map<number, FootnoteRenderItem[]>;
    virtualize?: boolean;
  } = {}
): RenderPagesUpdateKind {
  const totalPages = pages.length;
  const pageGap = config.pageGap ?? 24;
  const pc = container as PageContainer;
  const prevState = pc.__pageRenderState;
  const currentOptionsHash = computeOptionsHash(config);
  const currentHeaderFooterHash = computeHeaderFooterHash(config);
  const useVirtualization = config.virtualize !== false && totalPages >= VIRTUALIZATION_THRESHOLD;

  // Determine if we can do an incremental update
  const canIncremental =
    prevState && prevState.optionsHash === currentOptionsHash && useVirtualization;

  if (canIncremental) {
    // --- INCREMENTAL UPDATE PATH ---
    const prevShells = prevState.pageCursors;
    const prevDataMap = prevState.pageDataMap;
    const observer = pc.__pageObserver;
    let didPaint = false;

    // Compute new fingerprints
    const newFingerprints: string[] = [];
    const newFurnitureFingerprints: string[] = [];
    for (const page of pages) {
      newFingerprints.push(computePageFingerprint(page, config));
      newFurnitureFingerprints.push(computePageFurnitureFingerprint(page));
    }

    // If total page count changed, NUMPAGES fields in headers/footers are stale.
    // Force re-render of all currently-rendered pages.
    const totalPagesChanged = prevState.totalPages !== totalPages;
    const headerFooterChanged = prevState.headerFooterHash !== currentHeaderFooterHash;

    // Update existing pages
    const commonCount = Math.min(prevShells.length, pages.length);
    for (let i = 0; i < commonCount; i++) {
      const prev = prevShells[i];
      const newFp = newFingerprints[i];
      const newFurnitureFp = newFurnitureFingerprints[i];
      const pageFurnitureChanged = prev.furnitureFingerprint !== newFurnitureFp;

      if (prev.fingerprint === newFp && !totalPagesChanged && !headerFooterChanged) {
        // Page unchanged — update data map with new page data (references may differ)
        const data = prevDataMap.get(prev.element);
        if (data) {
          data.page = pages[i];
        }
        continue;
      }

      // Page changed — update the shell
      const shell = prev.element;
      const data = prevDataMap.get(shell);

      // Update data map entry
      if (data) {
        data.page = pages[i];

        if (data.rendered) {
          if (totalPagesChanged || headerFooterChanged || pageFurnitureChanged) {
            // NUMPAGES and semantic HF edits affect the page chrome, so replace
            // the entire populated shell. Empty virtualized shells stay lazy.
            repopulatePageShell(shell, prevDataMap, totalPages, config);
          } else {
            // Body-only edit: preserve unchanged header/footer DOM.
            repopulatePageContent(shell, prevDataMap, totalPages, config);
          }
          didPaint = true;
        }
        // If not rendered, it will be populated when it scrolls into view
      }

      // Update fingerprint
      prev.fingerprint = newFp;
      prev.furnitureFingerprint = newFurnitureFp;

      // Update page styles in case size changed
      applyPageStyles(shell, pages[i].size.w, pages[i].size.h, config);
      shell.dataset.pageNumber = String(pages[i].number);
    }

    // Handle new pages (document grew)
    if (pages.length > prevShells.length) {
      const doc = config.document ?? document;
      for (let i = prevShells.length; i < pages.length; i++) {
        const page = pages[i];
        const pageEl = doc.createElement('div');
        pageEl.className = config.pageClassName ?? PAGE_CLASS_NAMES.page;
        pageEl.dataset.pageNumber = String(page.number);
        pageEl.dataset.pageIndex = String(i);
        applyPageStyles(pageEl, page.size.w, page.size.h, config);
        container.appendChild(pageEl);
        didPaint = true;

        prevShells.push({
          element: pageEl,
          fingerprint: newFingerprints[i],
          furnitureFingerprint: newFurnitureFingerprints[i],
        });
        prevDataMap.set(pageEl, { page, index: i, rendered: false });

        if (observer) {
          observer.observe(pageEl);
        }
      }
    }

    // Handle removed pages (document shrank)
    if (pages.length < prevShells.length) {
      for (let i = prevShells.length - 1; i >= pages.length; i--) {
        const shell = prevShells[i].element;
        if (observer) {
          observer.unobserve(shell);
        }
        prevDataMap.delete(shell);
        container.removeChild(shell);
        didPaint = true;
      }
      prevShells.length = pages.length;
    }

    // Update indices in data map (they may have shifted)
    for (let i = 0; i < prevShells.length; i++) {
      const data = prevDataMap.get(prevShells[i].element);
      if (data) {
        data.index = i;
      }
    }

    // Update stored state with fresh config (nodeLookup, footnotes, etc.)
    prevState.totalPages = totalPages;
    prevState.headerFooterHash = currentHeaderFooterHash;
    prevState.currentOptions = config;

    if (didPaint) dispatchPainted(container);
    return 'incremental';
  }

  // --- FULL REBUILD PATH ---

  // Disconnect any previous observer
  const prevObserver = pc.__pageObserver;
  if (prevObserver) {
    prevObserver.disconnect();
    pc.__pageObserver = undefined;
  }

  // Clear existing content
  container.innerHTML = '';
  pc.__pageRenderState = undefined;

  applyContainerStyles(container, pageGap);

  // Build all page shells
  const pageShells: HTMLElement[] = [];
  const fingerprints: string[] = [];
  const furnitureFingerprints: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    fingerprints.push(computePageFingerprint(page, config));
    furnitureFingerprints.push(computePageFurnitureFingerprint(page));

    if (!useVirtualization) {
      // Small document: render all pages eagerly
      const { context, pageOptions } = buildPageRenderArgs(page, totalPages, config);
      const pageEl = paintPage(page, context, pageOptions);
      container.appendChild(pageEl);
      pageShells.push(pageEl);
    } else {
      // Large document: create lightweight shell with correct dimensions
      const doc = config.document ?? document;
      const pageEl = doc.createElement('div');
      pageEl.className = config.pageClassName ?? PAGE_CLASS_NAMES.page;
      pageEl.dataset.pageNumber = String(page.number);
      pageEl.dataset.pageIndex = String(i);
      applyPageStyles(pageEl, page.size.w, page.size.h, config);
      container.appendChild(pageEl);
      pageShells.push(pageEl);
    }
  }

  if (!useVirtualization) {
    // Store state for potential future incremental updates (won't be used
    // since small docs skip the incremental path, but keeps data consistent)
    dispatchPainted(container);
    return 'full';
  }

  // --- Virtualization via IntersectionObserver ---

  // Store page data for lazy rendering
  const pageDataMap = new Map<HTMLElement, { page: Page; index: number; rendered: boolean }>();
  for (let i = 0; i < pages.length; i++) {
    pageDataMap.set(pageShells[i], { page: pages[i], index: i, rendered: false });
  }

  // Use the browser viewport as intersection root.
  // The observer reads from pc.__pageRenderState so it always uses
  // the latest config/totalPages (updated by the incremental path).
  const observer = new IntersectionObserver(
    (entries) => {
      const renderState = pc.__pageRenderState;
      if (!renderState) return;
      const {
        currentOptions: liveOptions,
        totalPages: liveTotalPages,
        pageDataMap: liveDataMap,
      } = renderState;

      let didPaint = false;
      for (const entry of entries) {
        const shell = entry.target as HTMLElement;
        const data = liveDataMap.get(shell);
        if (!data) continue;

        if (entry.isIntersecting) {
          // Page is near viewport — render it and neighbors
          didPaint = populatePageShell(shell, liveDataMap, liveTotalPages, liveOptions) || didPaint;

          // Also render buffer pages above and below
          for (let offset = -VIRTUALIZATION_BUFFER; offset <= VIRTUALIZATION_BUFFER; offset++) {
            const neighborIdx = data.index + offset;
            if (
              neighborIdx >= 0 &&
              neighborIdx < renderState.pageCursors.length &&
              neighborIdx !== data.index
            ) {
              didPaint =
                populatePageShell(
                  renderState.pageCursors[neighborIdx].element,
                  liveDataMap,
                  liveTotalPages,
                  liveOptions
                ) || didPaint;
            }
          }
        }
      }

      // Sweep: depopulate pages far from any currently-visible page.
      const viewportHeight = window.innerHeight;
      const nearThreshold = viewportHeight * 3;
      const nearIndices = new Set<number>();

      for (const [el, data] of liveDataMap) {
        if (!data.rendered) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > -nearThreshold && rect.top < viewportHeight + nearThreshold) {
          nearIndices.add(data.index);
        }
      }

      for (const [el, data] of liveDataMap) {
        if (!data.rendered) continue;
        let keepRendered = false;
        for (const nearIdx of nearIndices) {
          if (Math.abs(data.index - nearIdx) <= VIRTUALIZATION_BUFFER + 1) {
            keepRendered = true;
            break;
          }
        }
        if (!keepRendered && nearIndices.size > 0) {
          didPaint = depopulatePageShell(el, liveDataMap) || didPaint;
        }
      }
      if (didPaint) dispatchPainted(container);
    },
    {
      root: null,
      rootMargin: '1500px 0px 1500px 0px',
    }
  );

  // Observe all page shells
  for (const shell of pageShells) {
    observer.observe(shell);
  }

  // Store observer and render state on the container BEFORE eager rendering,
  // so the populatePageShell calls below can find state if needed.
  pc.__pageObserver = observer;
  pc.__pageRenderState = {
    pageCursors: pageShells.map((el, i) => ({
      element: el,
      fingerprint: fingerprints[i],
      furnitureFingerprint: furnitureFingerprints[i],
    })),
    totalPages,
    optionsHash: currentOptionsHash,
    headerFooterHash: currentHeaderFooterHash,
    pageDataMap,
    currentOptions: config,
  };

  // Eagerly render the first few pages so the initial view isn't blank
  const initialRenderCount = Math.min(pages.length, VIRTUALIZATION_BUFFER + 3);
  for (let i = 0; i < initialRenderCount; i++) {
    populatePageShell(pageShells[i], pageDataMap, totalPages, config);
  }

  dispatchPainted(container);
  return 'full';
}

/**
 * Populate a page shell with full rendered content.
 */
function populatePageShell(
  shell: HTMLElement,
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>,
  totalPages: number,
  config: FullPageOptions
): boolean {
  const data = pageDataMap.get(shell);
  if (!data || data.rendered) return false;

  const { context, pageOptions } = buildPageRenderArgs(data.page, totalPages, config);
  const fullPageEl = paintPage(data.page, context, pageOptions);
  syncPageShellMetadata(shell, fullPageEl);

  while (fullPageEl.firstChild) {
    shell.appendChild(fullPageEl.firstChild);
  }

  data.rendered = true;
  return true;
}

/** Replace header, body, and footer inside an already populated shell. */
function repopulatePageShell(
  shell: HTMLElement,
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>,
  totalPages: number,
  config: FullPageOptions
): void {
  const data = pageDataMap.get(shell);
  if (!data) return;

  const { context, pageOptions } = buildPageRenderArgs(data.page, totalPages, config);
  const fullPageEl = paintPage(data.page, context, pageOptions);
  syncPageShellMetadata(shell, fullPageEl);
  shell.replaceChildren(...Array.from(fullPageEl.childNodes));
  data.rendered = true;
}

function syncPageShellMetadata(shell: HTMLElement, painted: HTMLElement): void {
  for (const key of ['sectionIndex', 'sectionPageNumber'] as const) {
    const value = painted.dataset[key];
    if (value === undefined) delete shell.dataset[key];
    else shell.dataset[key] = value;
  }
}

/**
 * Surgically replace only the content area of a rendered page shell.
 * Preserves header/footer elements to avoid blinking.
 */
function repopulatePageContent(
  shell: HTMLElement,
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>,
  totalPages: number,
  config: FullPageOptions
): void {
  const data = pageDataMap.get(shell);
  if (!data) return;

  const { context, pageOptions } = buildPageRenderArgs(data.page, totalPages, config);

  // Render a full page off-screen
  const fullPageEl = paintPage(data.page, context, pageOptions);

  // Extract the new content area from the rendered page
  const newContentEl = fullPageEl.querySelector(`.${PAGE_CLASS_NAMES.content}`);
  const oldContentEl = shell.querySelector(`.${PAGE_CLASS_NAMES.content}`);

  if (newContentEl && oldContentEl) {
    // Replace only the content area — header/footer stay untouched
    shell.replaceChild(newContentEl, oldContentEl);
  } else {
    // Fallback: full replace if structure doesn't match
    shell.innerHTML = '';
    data.rendered = false;
    populatePageShell(shell, pageDataMap, totalPages, config);
  }
}

/**
 * Clear a page shell's content (keep shell dimensions for scroll).
 */
function depopulatePageShell(
  shell: HTMLElement,
  pageDataMap: Map<HTMLElement, { page: Page; index: number; rendered: boolean }>
): boolean {
  const data = pageDataMap.get(shell);
  if (!data || !data.rendered) return false;

  shell.innerHTML = '';
  data.rendered = false;
  return true;
}

/**
 * Force every virtualized page shell in `container` to be fully rendered.
 *
 * Virtualization keeps off-screen pages as empty shells so cloning the
 * pages container for print (or any DOM snapshot) yields blank pages past
 * the visible band. Callers that need every page populated — print,
 * export-to-HTML, pdf snapshot — should call this first.
 *
 * No-op for small documents (rendered eagerly) or containers that were
 * never managed by `paintPages`. Returns the number of shells populated
 * by this call (useful for tests).
 */
export function paintAllPagesNow(container: HTMLElement): number {
  const pc = container as PageContainer;
  const state = pc.__pageRenderState;
  if (!state) return 0;

  const { pageCursors, totalPages, currentOptions, pageDataMap } = state;
  let populated = 0;
  for (const { element } of pageCursors) {
    const data = pageDataMap.get(element);
    if (!data || data.rendered) continue;
    populatePageShell(element, pageDataMap, totalPages, currentOptions);
    populated++;
  }
  if (populated > 0) dispatchPainted(container);
  return populated;
}
