import { describe, expect, test } from 'bun:test';
import { layOutPages } from './pageComposer';
import type {
  ParagraphBlock,
  ParagraphMetrics,
  TableBlock,
  TableFragment,
  TableMetrics,
} from './types';

const LINE = 20;

function paragraph(id: string): ParagraphBlock {
  return { kind: 'paragraph', id, runs: [{ kind: 'text', text: id }] };
}

function paragraphMetrics(lines: number): ParagraphMetrics {
  return {
    kind: 'paragraph',
    totalHeight: lines * LINE,
    lines: Array.from({ length: lines }, (_, index) => ({
      fromRun: 0,
      fromChar: index,
      toRun: 0,
      toChar: index + 1,
      width: 20,
      ascent: 15,
      descent: 5,
      lineHeight: LINE,
    })),
  };
}

describe('table pagination', () => {
  test('moves a short row whole when it fits on a fresh page', () => {
    const first = paragraph('first');
    const second = paragraph('second');
    const block: TableBlock = {
      kind: 'table',
      id: 'table',
      columnWidths: [100],
      rows: [
        { id: 'row-1', cells: [{ id: 'cell-1', nodes: [first] }] },
        { id: 'row-2', cells: [{ id: 'cell-2', nodes: [second] }] },
      ],
    };
    const firstMetrics = paragraphMetrics(4);
    const secondMetrics = paragraphMetrics(2);
    const metrics: TableMetrics = {
      kind: 'table',
      columnWidths: [100],
      totalWidth: 100,
      totalHeight: 6 * LINE,
      rows: [
        {
          height: 4 * LINE,
          cells: [{ metrics: [firstMetrics], width: 100, height: 4 * LINE }],
        },
        {
          height: 2 * LINE,
          cells: [{ metrics: [secondMetrics], width: 100, height: 2 * LINE }],
        },
      ],
    };

    const layout = layOutPages([block], [metrics], {
      pageSize: { w: 816, h: 200 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    });
    const fragments = layout.pages
      .flatMap((page) => page.fragments)
      .filter((fragment): fragment is TableFragment => fragment.kind === 'table');

    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toMatchObject({ fromRow: 0, toRow: 1 });
    expect(fragments[0].bottomClip).toBeUndefined();
    expect(fragments[1]).toMatchObject({ fromRow: 1, toRow: 2 });
    expect(fragments[1].topClip).toBeUndefined();
  });
});

describe('positioned table placement (w:tblpPr)', () => {
  const CONTENT = 624;
  const TABLE = 333;
  const CONFIG = {
    pageSize: { w: CONTENT + 192, h: 1056 },
    margins: { top: 96, right: 96, bottom: 96, left: 96 },
  };

  function floatingTable(floating: TableBlock['floating']): {
    block: TableBlock;
    metrics: TableMetrics;
  } {
    const block: TableBlock = {
      kind: 'table',
      id: 'float',
      columnWidths: [TABLE],
      rows: [{ id: 'r', cells: [{ id: 'c', nodes: [paragraph('cell')] }] }],
      floating,
    };
    const metrics: TableMetrics = {
      kind: 'table',
      columnWidths: [TABLE],
      totalWidth: TABLE,
      totalHeight: LINE,
      rows: [
        { height: LINE, cells: [{ metrics: [paragraphMetrics(1)], width: TABLE, height: LINE }] },
      ],
    };
    return { block, metrics };
  }

  function placedTable(floating: TableBlock['floating']): TableFragment {
    const { block, metrics } = floatingTable(floating);
    const layout = layOutPages([paragraph('intro'), block], [paragraphMetrics(2), metrics], CONFIG);
    return layout.pages[0].fragments.find(
      (f): f is TableFragment => f.kind === 'table'
    ) as TableFragment;
  }

  test('tblpXSpec="center" centers the fragment in the content box', () => {
    const frag = placedTable({
      horzAnchor: 'margin',
      vertAnchor: 'text',
      tblpXSpec: 'center',
      tblpY: 13,
    });
    // region.left (96) + centered offset within the 624px content box
    expect(frag.x).toBe(96 + (CONTENT - TABLE) / 2);
  });

  test('vertAnchor="text" measures tblpY from the table\'s flow position, not the page top', () => {
    const frag = placedTable({
      horzAnchor: 'margin',
      vertAnchor: 'text',
      tblpXSpec: 'center',
      tblpY: 13,
    });
    // Below the 2-line intro paragraph (top margin 96 + 40) plus the 13px offset.
    expect(frag.y).toBe(96 + 2 * LINE + 13);
  });

  test('vertAnchor="margin" keeps tblpY relative to the content-box top', () => {
    const frag = placedTable({
      horzAnchor: 'margin',
      vertAnchor: 'margin',
      tblpXSpec: 'right',
      tblpY: 50,
    });
    expect(frag.y).toBe(96 + 50);
    expect(frag.x).toBe(96 + CONTENT - TABLE);
  });
});
