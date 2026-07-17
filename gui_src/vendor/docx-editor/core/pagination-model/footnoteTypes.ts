/**
 * A content-node slice inside one page's footnote area.
 *
 * The source node index points into the owning FootnoteContent.
 *
 * @public
 */
export type FootnoteNodeFragment =
  | {
      kind: 'paragraph';
      nodeIndex: number;
      y: number;
      height: number;
      fromLine: number;
      toLine: number;
      /**
       * Exact half-open content range painted by this slice. These addresses
       * remain stable when the same footnote is remeasured at another width,
       * while `fromLine`/`toLine` are local to that page's measurement.
       */
      fromRun?: number;
      fromChar?: number;
      toRun?: number;
      toChar?: number;
    }
  | {
      kind: 'table';
      nodeIndex: number;
      y: number;
      height: number;
      fromRow: number;
      toRow: number;
      topClip?: number;
      bottomClip?: number;
    }
  | {
      kind: 'image' | 'textBox';
      nodeIndex: number;
      y: number;
      height: number;
    };

/**
 * The part of one footnote body painted on one page.
 *
 * @public
 */
export interface FootnoteFragment {
  footnoteId: number;
  displayNumber: number;
  nodes: FootnoteNodeFragment[];
  height: number;
  /** The page starts with content carried from an earlier page. */
  continuesFromPrev?: boolean;
  /** More of this footnote is carried to the next page. */
  continuesOnNext?: boolean;
  /** Footnote-column index, when the page uses `w15:footnoteColumns`. */
  columnIndex?: number;
}
