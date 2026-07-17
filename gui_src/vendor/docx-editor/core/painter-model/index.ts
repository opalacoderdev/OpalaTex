/**
 * PageLayout Painter
 *
 * Main entry point for rendering PageLayout data to DOM.
 * Provides reconciliation for efficient incremental updates.
 *
 * @experimental Stable enough for the first-party React adapter, but the
 * API may change in minor releases until a third-party adapter validates
 * it. Pin a version range if you depend on this directly.
 * @packageDocumentation
 * @public
 */

import type {
  PageLayout,
  Page,
  Fragment,
  ContentNode,
  LayoutMetrics,
  ParagraphBlock,
  ParagraphMetrics,
  ParagraphFragment,
  TableBlock,
  TableMetrics,
  TableFragment,
  ImageBlock,
  ImageMetrics,
  ImageFragment,
  TextBoxBlock,
  TextBoxMetrics,
  TextBoxFragment,
} from '../pagination-model/types';
import {
  paintPage,
  paintPages,
  paintAllPagesNow,
  type RenderContext,
  type RenderPagesUpdateKind,
} from './paintPage';
import { isFloatingImageRun, isTextWrappingFloatingImageRun } from './floatingImageFlow';
import { paintParagraphFragment, runsWithinLine, paintLine } from './renderParagraph';
import { paintFragment, FRAGMENT_CLASS_NAMES } from './paintFragment';
import { paintTableFragment, TABLE_CLASS_NAMES } from './renderTable';
import { paintImageFragment, IMAGE_CLASS_NAMES } from './renderImage';
import { paintTextBoxFragment, TEXTBOX_CLASS_NAMES } from './renderTextBox';
import { semanticDigest } from './semanticDigest';

// Re-export render functions
export {
  paintPage,
  paintPages,
  paintAllPagesNow,
  paintParagraphFragment,
  paintTableFragment,
  paintImageFragment,
  paintFragment,
  runsWithinLine,
  paintLine,
  FRAGMENT_CLASS_NAMES,
  TABLE_CLASS_NAMES,
  IMAGE_CLASS_NAMES,
  paintTextBoxFragment,
  TEXTBOX_CLASS_NAMES,
  isFloatingImageRun,
  isTextWrappingFloatingImageRun,
  type RenderContext,
};
export type { RenderPagesUpdateKind };
export { RevisionBarCollector, applyRevisionMetadata } from './revisionIndicators';
export type {
  RevisionIndicatorKind,
  RevisionMetadata,
  RevisionBarSpan,
} from './revisionIndicators';
export type {
  HeaderFooterContent,
  SectionHeaderFooterContent,
  RenderPageOptions,
  FootnoteRenderItem,
} from './paintPage';
export { registerPageFurniture } from './pageFurnitureRegistry';

// Anchored-object position resolution — shared with the measure pipeline so the
// reserved float band lines up with where the painter places the object.
export {
  resolveAnchoredObjectPosition,
  resolveAnchoredObjectVerticalTop,
  pageGeometryFromPage,
  type PageGeometry,
} from './anchoredObjectPosition';

// Block-level content-control (SDT) focus chrome — keep the boundary box and
// label visible while the caret is inside the control, shared by both adapters.
export { enclosingSdtGroupIds, applySdtFocus } from './sdtBoundary';
export {
  syncTocRefreshButtons,
  createTocRefreshSyncCache,
  shouldSyncTocRefreshButtons,
  cleanupTocRefreshButtons,
  applyTocRefreshProxyFocus,
  getTocRefreshDescriptors,
  TOC_REFRESH_PROXY_FOCUSED_CLASS,
} from './tocRefresh';
export type {
  PaintedPagesReadyDetail,
  PaintedPagesReadyEvent,
  SyncTocRefreshOptions,
  TocRefreshDescriptor,
  TocRefreshSyncCache,
} from './tocRefresh';

// Framework-agnostic image layout helpers shared by React + Vue adapters.
export {
  LAYOUT_IMAGE_CLASSES,
  pointerTargetResolveImage,
  findImageElement,
  captureInlinePositionEmu,
  deriveLayoutChoice,
  IMAGE_LAYOUT_OPTIONS,
  isImageLayoutOptionEnabled,
  toolbarValueToLayoutTarget,
} from './imageLayout';
export type {
  ImagePointerTargetResult,
  ImageLayoutIconHint,
  ImageLayoutOptionDef,
} from './imageLayout';

/**
 * Node lookup entry for painter
 */
export interface NodeLookupEntry {
  node: ContentNode;
  metrics: LayoutMetrics;
  version?: string;
}

/**
 * Node lookup map type
 */
export type NodeLookup = Map<string, NodeLookupEntry>;

/**
 * Build the painter's `node.id → { node, metrics, version }` lookup from the
 * parallel nodes/metrics arrays. The semantic version invalidates virtualized
 * pages for content-only changes that preserve all layout geometry.
 */
export function indexNodesById(nodes: ContentNode[], metrics: LayoutMetrics[]): NodeLookup {
  const lookup: NodeLookup = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeMetrics = metrics[i];
    if (node && nodeMetrics) {
      lookup.set(String(node.id), {
        node,
        metrics: nodeMetrics,
        version: semanticDigest(node, nodeMetrics),
      });
    }
  }
  return lookup;
}

/**
 * Painter config
 */
export interface PaintOptions {
  /** Document to create elements in */
  document?: Document;
  /** Gap between pages in pixels */
  pageGap?: number;
  /** Show page shadows */
  showShadow?: boolean;
  /** Background color for pages */
  pageBackground?: string;
  /** Container background color */
  containerBackground?: string;
}

/**
 * Page DOM state for reconciliation
 */
interface PageCursor {
  element: HTMLElement;
  pageNumber: number;
  fragmentCount: number;
}

/**
 * PageLayout Painter class
 *
 * Renders PageLayout data to DOM with efficient reconciliation.
 * Only updates changed pages and fragments for better performance.
 */
export class LayoutPainter {
  private container: HTMLElement | null = null;
  private nodeLookup: NodeLookup = new Map();
  private pageCursors: PageCursor[] = [];
  private totalPages = 0;
  private config: PaintOptions;
  private doc: Document;
  resolvedCommentIds: Set<number> = new Set();

  constructor(config: PaintOptions = {}) {
    this.config = config;
    this.doc = config.document ?? document;
  }

  /**
   * Set the node lookup map for rendering fragments
   */
  setNodeLookup(lookup: NodeLookup): void {
    this.nodeLookup = lookup;
  }

  /**
   * Mount the painter to a container element
   */
  mount(container: HTMLElement): void {
    this.container = container;
    this.applyContainerStyles();
  }

  /**
   * Unmount the painter
   */
  unmount(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.pageCursors = [];
  }

  /**
   * Apply styles to the container
   */
  private applyContainerStyles(): void {
    if (!this.container) return;

    const pageGap = this.config.pageGap ?? 24;

    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.container.style.alignItems = 'center';
    this.container.style.gap = `${pageGap}px`;
    this.container.style.padding = `${pageGap}px`;
    this.container.style.backgroundColor =
      this.config.containerBackground ?? 'var(--doc-bg, #f8f9fa)';
    this.container.style.minHeight = '100%';
  }

  /**
   * Paint a layout to the container
   */
  paint(layout: PageLayout): void {
    if (!this.container) {
      throw new Error('LayoutPainter: not mounted');
    }

    const { pages } = layout;
    this.totalPages = pages.length;

    // Full repaint for now (reconciliation can be added later)
    this.container.innerHTML = '';
    this.pageCursors = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const context: RenderContext = {
        pageNumber: page.number,
        totalPages: this.totalPages,
        section: 'body',
        resolvedCommentIds: this.resolvedCommentIds,
      };

      const pageEl = this.paintPageWithLookup(page, context);
      this.container.appendChild(pageEl);

      this.pageCursors.push({
        element: pageEl,
        pageNumber: page.number,
        fragmentCount: page.fragments.length,
      });
    }
  }

  /**
   * Render a page using block lookup for full fragment rendering
   */
  private paintPageWithLookup(page: Page, context: RenderContext): HTMLElement {
    const pageEl = this.doc.createElement('div');
    pageEl.className = 'layout-page';
    pageEl.dataset.pageNumber = String(page.number);

    // Apply page styles
    pageEl.style.position = 'relative';
    pageEl.style.width = `${page.size.w}px`;
    pageEl.style.height = `${page.size.h}px`;
    // CSS vars so .ep-root.dark re-themes the canvas (view transform only —
    // saved DOCX unchanged). Mirrors applyPageStyles in paintPage.ts.
    pageEl.style.backgroundColor = this.config.pageBackground ?? 'var(--doc-page-bg, #ffffff)';
    pageEl.style.color = 'var(--doc-page-text, #000000)';
    pageEl.style.overflow = 'hidden';

    if (this.config.showShadow) {
      pageEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)';
    }

    // Create content area
    const contentEl = this.doc.createElement('div');
    contentEl.className = 'layout-page-content';
    contentEl.style.position = 'absolute';
    contentEl.style.top = `${page.margins.top}px`;
    contentEl.style.left = `${page.margins.left}px`;
    contentEl.style.right = `${page.margins.right}px`;
    contentEl.style.bottom = `${page.margins.bottom}px`;
    contentEl.style.overflow = 'visible';

    // Render fragments
    for (const fragment of page.fragments) {
      const fragmentEl = this.paintFragmentWithLookup(fragment, context);
      this.applyFragmentPosition(fragmentEl, fragment);
      contentEl.appendChild(fragmentEl);
    }

    pageEl.appendChild(contentEl);
    return pageEl;
  }

  /**
   * Render a fragment using block lookup for full content rendering
   */
  private paintFragmentWithLookup(fragment: Fragment, context: RenderContext): HTMLElement {
    const lookup = this.nodeLookup.get(String(fragment.nodeId));

    if (fragment.kind === 'paragraph' && lookup) {
      const block = lookup.node as ParagraphBlock;
      const measure = lookup.metrics as ParagraphMetrics;
      return paintParagraphFragment(fragment as ParagraphFragment, block, measure, context, {
        document: this.doc,
      });
    }

    if (fragment.kind === 'table' && lookup) {
      const block = lookup.node as TableBlock;
      const measure = lookup.metrics as TableMetrics;
      return paintTableFragment(fragment as TableFragment, block, measure, context, {
        document: this.doc,
      });
    }

    if (fragment.kind === 'image' && lookup) {
      const block = lookup.node as ImageBlock;
      const measure = lookup.metrics as ImageMetrics;
      return paintImageFragment(fragment as ImageFragment, block, measure, context, {
        document: this.doc,
      });
    }

    if (fragment.kind === 'textBox' && lookup) {
      const block = lookup.node as TextBoxBlock;
      const measure = lookup.metrics as TextBoxMetrics;
      return paintTextBoxFragment(fragment as TextBoxFragment, block, measure, context, {
        document: this.doc,
      });
    }

    // Fallback to placeholder for other fragment types
    return paintFragment(fragment, context, { document: this.doc });
  }

  /**
   * Apply positioning styles to a fragment element
   */
  private applyFragmentPosition(element: HTMLElement, fragment: Fragment): void {
    element.style.position = 'absolute';
    element.style.left = `${fragment.x}px`;
    element.style.top = `${fragment.y}px`;
    element.style.width = `${fragment.width}px`;

    if ('height' in fragment) {
      element.style.height = `${fragment.height}px`;
    }
  }

  /**
   * Get the current page count
   */
  getPageCount(): number {
    return this.totalPages;
  }

  /**
   * Get a page element by index
   */
  getPageElement(index: number): HTMLElement | null {
    return this.pageCursors[index]?.element ?? null;
  }

  /**
   * Scroll to a specific page
   */
  scrollToPage(pageNumber: number): void {
    const state = this.pageCursors.find((s) => s.pageNumber === pageNumber);
    if (state?.element) {
      state.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

/**
 * Create a new LayoutPainter instance
 */
export function createPainter(config?: PaintOptions): LayoutPainter {
  return new LayoutPainter(config);
}
