import type {
  Page,
  Fragment,
  ParagraphBlock,
  ParagraphMetrics,
  ParagraphFragment,
  ParagraphBorders,
  TableBlock,
  TableMetrics,
  TableFragment,
  ImageBlock,
  ImageMetrics,
  ImageFragment,
  TextBoxBlock,
  TextBoxMetrics,
  TextBoxFragment,
  SdtGroup,
} from '../../pagination-model/types';
import type { NodeLookup } from '../index';
import type { RenderContext } from '../paintPage';
import { paintFragment } from '../paintFragment';
import { paintParagraphFragment } from '../renderParagraph';
import { paintTableFragment } from '../renderTable';
import { paintImageFragment } from '../renderImage';
import { paintTextBoxFragment } from '../renderTextBox';
import { paragraphLayout, type FloatingImageZone } from '../../flow-model/metrics';
import type { RevisionBarCollector } from '../revisionIndicators';
import {
  bodyInlineImageRevisionBars,
  registerBodyImageBlockRevision,
  registerBodyParagraphRevision,
  registerBodyTableRevisionSpans,
} from '../paintPageRevisionBars';

function applyFragmentStyles(
  element: HTMLElement,
  fragment: Fragment,
  margins: { left: number; top: number }
): void {
  element.style.position = 'absolute';
  element.style.left = `${fragment.x - margins.left}px`;
  const top = fragment.y - margins.top;
  element.style.top = `${fragment.kind === 'table' ? Math.round(top) : top}px`;
  element.style.width = `${fragment.width}px`;
  if ('height' in fragment && fragment.kind !== 'table') {
    element.style.height = `${fragment.height}px`;
  }
}

function stampSdtFragment(el: HTMLElement, groups: SdtGroup[]): void {
  if (groups.length === 0) return;
  const innermost = groups[groups.length - 1];
  el.classList.add('layout-block-sdt');
  el.dataset.sdtGroupId = innermost.id;
  el.dataset.sdtType = innermost.sdtType;
  el.dataset.sdtDepth = String(groups.length);
  if (innermost.tag != null) el.dataset.sdtTag = innermost.tag;
  if (innermost.alias != null) el.dataset.sdtAlias = innermost.alias;
  if (innermost.lock != null) el.dataset.sdtLock = innermost.lock;
}

export interface PaintBodyFragmentsOptions {
  page: Page;
  contentEl: HTMLElement;
  doc: Document;
  contentWidth: number;
  context: RenderContext;
  nodeLookup?: NodeLookup;
  floatingZones: FloatingImageZone[];
  revisionBars: RevisionBarCollector;
}

export function paintBodyPageFragments(options: PaintBodyFragmentsOptions): void {
  const { page, contentEl, doc, contentWidth, context, nodeLookup, floatingZones, revisionBars } =
    options;

  const getParaBorders = (frag: Fragment): ParagraphBorders | undefined => {
    if (frag.kind !== 'paragraph' || !nodeLookup || !frag.nodeId) return undefined;
    const nodeData = nodeLookup.get(String(frag.nodeId));
    if (nodeData?.node.kind === 'paragraph')
      return (nodeData.node as ParagraphBlock).attrs?.borders;
    return undefined;
  };

  let prevParagraphBorders: ParagraphBorders | undefined;
  const renderedInlineImageKeysByBlock = new Map<string, Set<string>>();

  const sdtGroupsOf = (frag: Fragment): SdtGroup[] => {
    if (!nodeLookup || !frag.nodeId) return [];
    return nodeLookup.get(String(frag.nodeId))?.node.sdtGroups ?? [];
  };

  for (let i = 0; i < page.fragments.length; i++) {
    const fragment = page.fragments[i];
    let fragmentEl: HTMLElement;
    const fragmentContext = { ...context, section: 'body' as const, contentWidth };
    const fragmentContentY = fragment.y - page.margins.top;

    if (nodeLookup && fragment.nodeId) {
      const nodeData = nodeLookup.get(String(fragment.nodeId));

      if (
        fragment.kind === 'paragraph' &&
        nodeData?.node.kind === 'paragraph' &&
        nodeData?.metrics.kind === 'paragraph'
      ) {
        const paragraphBlock = nodeData.node as ParagraphBlock;
        const nextBorders =
          i + 1 < page.fragments.length ? getParaBorders(page.fragments[i + 1]) : undefined;
        const blockKey = String(fragment.nodeId);
        let renderedInlineImageKeys = renderedInlineImageKeysByBlock.get(blockKey);
        if (!renderedInlineImageKeys) {
          renderedInlineImageKeys = new Set<string>();
          renderedInlineImageKeysByBlock.set(blockKey, renderedInlineImageKeys);
        }

        let paragraphMetrics = nodeData.metrics as ParagraphMetrics;
        if (floatingZones.length > 0) {
          paragraphMetrics = paragraphLayout(paragraphBlock, contentWidth, {
            floatingZones,
            paragraphYOffset: fragmentContentY,
          });
        }

        fragmentEl = paintParagraphFragment(
          fragment as ParagraphFragment,
          paragraphBlock,
          paragraphMetrics,
          fragmentContext,
          {
            document: doc,
            fragmentContentY,
            prevBorders: prevParagraphBorders,
            nextBorders,
            renderedInlineImageKeys,
            inlineImageRevisionBars: bodyInlineImageRevisionBars(
              revisionBars,
              fragment.y,
              page.margins.top,
              page.size.h,
              page.margins.bottom,
              fragment.height
            ),
          }
        );
        registerBodyParagraphRevision(
          revisionBars,
          paragraphBlock,
          fragment.y,
          page.margins.top,
          fragment.height
        );
        prevParagraphBorders = paragraphBlock.attrs?.borders;
      } else if (
        fragment.kind === 'table' &&
        nodeData?.node.kind === 'table' &&
        nodeData?.metrics.kind === 'table'
      ) {
        fragmentEl = paintTableFragment(
          fragment as TableFragment,
          nodeData.node as TableBlock,
          nodeData.metrics as TableMetrics,
          fragmentContext,
          {
            document: doc,
            revisionBars: {
              collector: revisionBars,
              originTop: Math.round(fragment.y - page.margins.top),
            },
          }
        );
        registerBodyTableRevisionSpans(
          revisionBars,
          fragment as TableFragment,
          nodeData.node as TableBlock,
          nodeData.metrics as TableMetrics,
          Math.round(fragment.y - page.margins.top)
        );
        prevParagraphBorders = undefined;
      } else if (
        fragment.kind === 'image' &&
        nodeData?.node.kind === 'image' &&
        nodeData?.metrics.kind === 'image'
      ) {
        fragmentEl = paintImageFragment(
          fragment as ImageFragment,
          nodeData.node as ImageBlock,
          nodeData.metrics as ImageMetrics,
          fragmentContext,
          { document: doc }
        );
        registerBodyImageBlockRevision(
          revisionBars,
          nodeData.node as ImageBlock,
          fragment.y,
          page.margins.top,
          fragment.height
        );
        prevParagraphBorders = undefined;
      } else if (
        fragment.kind === 'textBox' &&
        nodeData?.node.kind === 'textBox' &&
        nodeData?.metrics.kind === 'textBox'
      ) {
        fragmentEl = paintTextBoxFragment(
          fragment as TextBoxFragment,
          nodeData.node as TextBoxBlock,
          nodeData.metrics as TextBoxMetrics,
          fragmentContext,
          { document: doc }
        );
        prevParagraphBorders = undefined;
      } else {
        fragmentEl = paintFragment(fragment, fragmentContext, { document: doc });
        prevParagraphBorders = undefined;
      }
    } else {
      fragmentEl = paintFragment(fragment, fragmentContext, { document: doc });
      prevParagraphBorders = undefined;
    }

    applyFragmentStyles(fragmentEl, fragment, { left: page.margins.left, top: page.margins.top });
    stampSdtFragment(fragmentEl, sdtGroupsOf(fragment));
    contentEl.appendChild(fragmentEl);
  }
}

export function bodySdtGroupsOf(nodeLookup?: NodeLookup) {
  return (frag: Fragment): SdtGroup[] => {
    if (!nodeLookup || !frag.nodeId) return [];
    return nodeLookup.get(String(frag.nodeId))?.node.sdtGroups ?? [];
  };
}
