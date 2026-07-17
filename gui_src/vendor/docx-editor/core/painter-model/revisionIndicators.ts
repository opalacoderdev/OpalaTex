const REVISION_BAR_LEFT_PX = -10;
const REVISION_BAR_WIDTH_PX = 2;

export type RevisionIndicatorKind = 'ins' | 'del';

export interface RevisionMetadata {
  revisionId?: number;
  author?: string;
  date?: string | null;
}

export interface RevisionBarSpan extends RevisionMetadata {
  top: number;
  height: number;
  kind: RevisionIndicatorKind;
}

export function applyRevisionMetadata(
  element: HTMLElement,
  scopeClass: string,
  kind: RevisionIndicatorKind,
  metadata: RevisionMetadata
): void {
  element.classList.add(scopeClass, `layout-revision-${kind}`);

  if (metadata.revisionId != null) {
    element.dataset.revisionId = String(metadata.revisionId);
  }
  if (metadata.author) {
    element.dataset.revisionAuthor = metadata.author;
    element.dataset.changeAuthor = metadata.author;
  }
  if (metadata.date != null) {
    element.dataset.revisionDate = metadata.date;
    element.dataset.changeDate = metadata.date;
  }
}

export class RevisionBarCollector {
  private spans: RevisionBarSpan[] = [];

  register(span: RevisionBarSpan): void {
    if (!Number.isFinite(span.top) || !Number.isFinite(span.height) || span.height <= 0) {
      return;
    }

    this.spans.push({ ...span });
  }

  getMergedSpans(): RevisionBarSpan[] {
    if (this.spans.length === 0) {
      return [];
    }

    const sorted = [...this.spans].sort((left, right) => {
      if (left.top !== right.top) {
        return left.top - right.top;
      }
      return left.height - right.height;
    });

    const merged: RevisionBarSpan[] = [];
    for (const span of sorted) {
      const previous = merged[merged.length - 1];
      if (!previous || !canMerge(previous, span)) {
        merged.push({ ...span });
        continue;
      }

      const previousBottom = previous.top + previous.height;
      const spanBottom = span.top + span.height;
      previous.height = Math.max(previousBottom, spanBottom) - previous.top;
      previous.author ??= span.author;
      previous.date ??= span.date;
    }

    return merged;
  }

  paint(doc: Document): HTMLElement | null {
    const spans = this.getMergedSpans();
    if (spans.length === 0) {
      return null;
    }

    const overlay = doc.createElement('div');
    overlay.className = 'layout-revision-bars';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.pointerEvents = 'none';

    for (const span of spans) {
      const bar = doc.createElement('div');
      applyRevisionMetadata(bar, 'layout-revision-change-bar', span.kind, span);
      bar.style.position = 'absolute';
      bar.style.left = `${REVISION_BAR_LEFT_PX}px`;
      bar.style.top = `${span.top}px`;
      bar.style.width = `${REVISION_BAR_WIDTH_PX}px`;
      bar.style.height = `${span.height}px`;
      bar.style.pointerEvents = 'none';
      overlay.appendChild(bar);
    }

    return overlay;
  }
}

function canMerge(left: RevisionBarSpan, right: RevisionBarSpan): boolean {
  return (
    left.kind === right.kind &&
    left.revisionId != null &&
    left.revisionId === right.revisionId &&
    right.top <= left.top + left.height
  );
}
