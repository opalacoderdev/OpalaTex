interface PaintTicket {
  documentEpoch: number;
  paintEpoch: number;
}

/** @internal */
export function readCurrentPaintedPages<T>(
  pagesAreCurrent: () => boolean,
  read: () => T
): T | null {
  return pagesAreCurrent() ? read() : null;
}

/** @internal */
export function transactionNeedsDirectOverlayRequest(transaction: {
  docChanged: boolean;
  selectionSet: boolean;
}): boolean {
  return !transaction.docChanged && !transaction.selectionSet;
}

/** @internal */
export interface PaintedPagesGuard {
  noteDocumentChange: () => void;
  startPaint: () => PaintTicket;
  finishPaint: (ticket: PaintTicket) => boolean;
  abandonPaint: (ticket: PaintTicket) => void;
  requestOverlayRefresh: () => void;
  pagesAreCurrent: () => boolean;
  isDisposed: () => boolean;
  revive: () => void;
  dispose: () => void;
}

/**
 * Prevents overlay geometry reads while the visible page DOM trails the PM
 * document. Paint tickets also stop an overtaken pass from releasing work.
 *
 * @internal
 */
export function createPaintedPagesGuard(refreshOverlays: () => void): PaintedPagesGuard {
  let documentEpoch = 0;
  let newestPaintEpoch = 0;
  let paintedDocumentEpoch: number | null = null;
  let refreshPending = false;
  let disposed = false;

  const pagesAreCurrent = () => !disposed && paintedDocumentEpoch === documentEpoch;

  return {
    noteDocumentChange() {
      if (disposed) return;
      documentEpoch++;
      paintedDocumentEpoch = null;
    },

    startPaint() {
      newestPaintEpoch++;
      paintedDocumentEpoch = null;
      return { documentEpoch, paintEpoch: newestPaintEpoch };
    },

    finishPaint(ticket) {
      if (
        disposed ||
        ticket.paintEpoch !== newestPaintEpoch ||
        ticket.documentEpoch !== documentEpoch
      ) {
        return false;
      }

      paintedDocumentEpoch = documentEpoch;
      if (refreshPending) {
        refreshPending = false;
        refreshOverlays();
      }
      return pagesAreCurrent();
    },

    abandonPaint(_ticket) {
      // A failed pass must leave pages stale and retained work untouched.
    },

    requestOverlayRefresh() {
      if (disposed) return;
      if (pagesAreCurrent()) {
        refreshOverlays();
      } else {
        refreshPending = true;
      }
    },

    pagesAreCurrent,
    isDisposed: () => disposed,
    revive() {
      disposed = false;
    },

    dispose() {
      disposed = true;
      refreshPending = false;
    },
  };
}
