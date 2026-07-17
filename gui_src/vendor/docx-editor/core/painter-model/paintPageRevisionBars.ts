import type {
  ImageBlock,
  ParagraphBlock,
  TableBlock,
  TableFragment,
  TableMetrics,
} from '../pagination-model/types';
import type { PageFloatingImage } from './paintPage/pageFloatingImage';
import { getImageRevisionData } from './renderImage';
import { getParagraphRevisionMetadata } from './renderParagraph';
import { getTableRevisionBarSpans } from './renderTableRevisionBars';
import { RevisionBarCollector } from './revisionIndicators';

export function createBodyRevisionBarCollector(
  floatingImages: PageFloatingImage[]
): RevisionBarCollector {
  const revisionBars = new RevisionBarCollector();
  for (const img of floatingImages) {
    const revision = getImageRevisionData(img);
    if (!revision) continue;
    revisionBars.register({
      top: img.y,
      height: img.height,
      kind: revision.kind,
      ...revision.metadata,
    });
  }
  return revisionBars;
}

export function bodyInlineImageRevisionBars(
  collector: RevisionBarCollector,
  fragmentY: number,
  pageMarginsTop: number,
  pageHeight: number,
  pageMarginsBottom: number,
  fragmentHeight: number
) {
  return {
    collector,
    originTop: fragmentY - pageMarginsTop,
    clipTop: Math.max(0, fragmentY - pageMarginsTop),
    clipBottom: Math.min(
      pageHeight - pageMarginsTop - pageMarginsBottom,
      fragmentY - pageMarginsTop + fragmentHeight
    ),
  };
}

export function registerBodyParagraphRevision(
  collector: RevisionBarCollector,
  paragraphBlock: ParagraphBlock,
  fragmentY: number,
  pageMarginsTop: number,
  fragmentHeight: number
): void {
  const paragraphRevision = getParagraphRevisionMetadata(paragraphBlock);
  if (!paragraphRevision) return;
  collector.register({
    top: fragmentY - pageMarginsTop,
    height: fragmentHeight,
    kind: paragraphRevision.kind,
    ...paragraphRevision.metadata,
  });
}

export function registerBodyTableRevisionSpans(
  collector: RevisionBarCollector,
  fragment: TableFragment,
  block: TableBlock,
  measure: TableMetrics,
  originTop: number
): void {
  for (const span of getTableRevisionBarSpans(fragment, block, measure, originTop)) {
    collector.register(span);
  }
}

export function registerBodyImageBlockRevision(
  collector: RevisionBarCollector,
  imageBlock: ImageBlock,
  fragmentY: number,
  pageMarginsTop: number,
  fragmentHeight: number
): void {
  const imageRevision = getImageRevisionData(imageBlock);
  if (!imageRevision) return;
  collector.register({
    top: fragmentY - pageMarginsTop,
    height: fragmentHeight,
    kind: imageRevision.kind,
    ...imageRevision.metadata,
  });
}

export function appendRevisionBarOverlay(
  collector: RevisionBarCollector,
  contentEl: HTMLElement,
  doc: Document
): void {
  const revisionOverlay = collector.paint(doc);
  if (revisionOverlay) {
    contentEl.appendChild(revisionOverlay);
  }
}
