import { describe, expect, test } from 'bun:test';
import { EditorState } from 'prosemirror-state';
import type { PageLayout } from '../../pagination-model/types';
import {
  findStaleTableOfContentsBlocks,
  findTableOfContentsBlocks,
  hasTableOfContentsNeedingUpdate,
  updateTableOfContents,
} from '../toc';
import { paragraph, rawTocBlock, schema, tocBlock, TOC_TAB } from './tocTestHelpers';

describe('TOC core correctness', () => {
  test('findTableOfContentsBlocks returns only the inner owner in nested SDTs', () => {
    const innerToc = tocBlock();
    const outer = schema.node(
      'blockSdt',
      {
        sdtType: 'richText',
        tag: 'outer',
        rawPropertiesXml: '<w:sdtPr><w:tag w:val="outer"/></w:sdtPr>',
      },
      [paragraph('Sibling before'), innerToc, paragraph('Sibling after')]
    );
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [outer, paragraph('Heading', { styleId: 'Heading1' })]),
    });

    const blocks = findTableOfContentsBlocks(state.doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].node.attrs.alias).toBe('Table of Contents');

    const updated = updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });
    expect(updated).toBe(true);

    const outerAfter = state.doc.child(0);
    expect(outerAfter.type.name).toBe('blockSdt');
    expect(outerAfter.attrs.tag).toBe('outer');
    expect(outerAfter.child(0).textContent).toBe('Sibling before');
    expect(outerAfter.child(2).textContent).toBe('Sibling after');
    expect(outerAfter.child(1).textContent).toContain('Heading');
  });

  test('updateTableOfContents returns false for a current non-hyperlinked TOC', () => {
    const raw = [
      '<w:sdt><w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr><w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3"</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>',
      '<w:r><w:t>Heading</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent></w:sdt>',
    ].join('');
    const currentEntry = schema.node(
      'paragraph',
      { styleId: 'TOC1', tabs: [TOC_TAB], lineSpacing: 276, lineSpacingRule: 'auto' },
      [
        schema.text('Heading'),
        schema.node('tab', {
          positional: { alignment: 'right', relativeTo: 'margin', leader: 'dot' },
        }),
        schema.text('1'),
      ]
    );
    const currentToc = schema.node(
      'blockSdt',
      {
        sdtType: 'richText',
        alias: 'Table of Contents',
        rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
        rawPreserveXml: raw,
        rawPreserveText: 'Heading\t1',
      },
      [currentEntry]
    );
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [currentToc, paragraph('Heading', { styleId: 'Heading1' })]),
    });

    const layout: PageLayout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 1,
          fragments: [
            {
              kind: 'paragraph',
              nodeId: 1,
              x: 0,
              y: 0,
              width: 500,
              height: 24,
              fromLine: 0,
              toLine: 1,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
      ],
    };

    let dispatched = false;
    const changed = updateTableOfContents(
      state,
      (tr) => {
        dispatched = true;
        state = state.apply(tr);
      },
      { layout }
    );
    expect(changed).toBe(false);
    expect(dispatched).toBe(false);
    expect(state.doc.child(1).attrs.bookmarks ?? []).toHaveLength(0);
    expect(findStaleTableOfContentsBlocks(state.doc, layout)).toHaveLength(0);
  });

  test('allocates collision-free bookmark IDs against block-level bookmark markers', () => {
    const hashString = (input: string): number => {
      let hash = 0;
      for (let i = 0; i < input.length; i++) {
        hash = (hash * 31 + input.charCodeAt(i)) | 0;
      }
      return hash;
    };

    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        schema.node(
          'table',
          { leadingBlockMarkers: [{ type: 'bookmarkStart', id: 1, name: '_Reserved' }] },
          [schema.node('tableRow', null, [schema.node('tableCell', null, [paragraph('Cell')])])]
        ),
        paragraph('Heading', { styleId: 'Heading1' }),
      ]),
    });

    let headingPos = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Heading') {
        headingPos = pos;
        return false;
      }
      return true;
    });
    const bookmarkName = `_Toc${Math.abs(hashString(`${headingPos}:Heading`))}`;
    const collidingId = Math.abs(hashString(bookmarkName)) % 2147483647 || 1;

    state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        schema.node(
          'table',
          { leadingBlockMarkers: [{ type: 'bookmarkStart', id: collidingId, name: '_Reserved' }] },
          [schema.node('tableRow', null, [schema.node('tableCell', null, [paragraph('Cell')])])]
        ),
        paragraph('Heading', { styleId: 'Heading1' }),
      ]),
    });

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const headingBookmark = (
      state.doc.child(2).attrs.bookmarks as Array<{ id: number; name: string }>
    ).find((bookmark) => bookmark.name.startsWith('_Toc'));
    expect(headingBookmark?.id).not.toBe(collidingId);
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
  });

  test('resolves heading page numbers inside split tables by row fragment', () => {
    const tableCell = (text: string, attrs: Record<string, unknown> = {}) =>
      schema.node('tableCell', null, [paragraph(text, attrs)]);
    const table = schema.node('table', null, [
      schema.node('tableRow', null, [tableCell('Row 0')]),
      schema.node('tableRow', null, [tableCell('Table Heading', { styleId: 'Heading1' })]),
    ]);

    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), table]),
    });

    const tablePos = state.doc.child(0).nodeSize;
    let headingPos = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Table Heading') {
        headingPos = pos;
        return false;
      }
      return true;
    });
    expect(headingPos).toBeGreaterThan(0);

    const layout: PageLayout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 1,
          fragments: [
            {
              kind: 'table',
              nodeId: 'block-1',
              x: 0,
              y: 0,
              width: 500,
              height: 120,
              fromRow: 0,
              toRow: 1,
              docFrom: tablePos,
              docTo: tablePos + table.nodeSize,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
        {
          number: 2,
          fragments: [
            {
              kind: 'table',
              nodeId: 'block-1',
              x: 0,
              y: 0,
              width: 500,
              height: 120,
              fromRow: 1,
              toRow: 2,
              docFrom: tablePos,
              docTo: tablePos + table.nodeSize,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
      ],
    };

    updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      { layout }
    );

    const updatedToc = state.doc.child(0);
    expect(updatedToc.textContent).toContain('Table Heading');
    expect(updatedToc.textContent).toContain('2');
    expect(updatedToc.textContent).not.toContain('Table Heading1');
  });

  test('findStaleTableOfContentsBlocks concatenates split page-number text after the tab', () => {
    const entry = schema.node(
      'paragraph',
      { styleId: 'TOC1', tabs: [TOC_TAB], lineSpacing: 276, lineSpacingRule: 'auto' },
      [
        schema.text('Heading', [schema.marks.hyperlink.create({ href: '#_Toc1' })]),
        schema.node(
          'tab',
          { positional: { alignment: 'right', relativeTo: 'margin', leader: 'dot' } },
          undefined,
          [schema.marks.hyperlink.create({ href: '#_Toc1' })]
        ),
        schema.text('1', [schema.marks.hyperlink.create({ href: '#_Toc1' })]),
        schema.text('2', [schema.marks.hyperlink.create({ href: '#_Toc1' })]),
      ]
    );
    const currentToc = schema.node(
      'blockSdt',
      {
        sdtType: 'richText',
        alias: 'Table of Contents',
        rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
        rawPreserveXml: [
          '<w:sdt><w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr><w:sdtContent>',
          '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
          '<w:r><w:instrText>TOC \\h \\o "1-5"</w:instrText></w:r>',
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
          '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
          '</w:sdtContent></w:sdt>',
        ].join(''),
        rawPreserveText: 'Heading\t12',
      },
      [entry]
    );
    const doc = schema.node('doc', null, [
      currentToc,
      paragraph('Heading', { styleId: 'Heading1', bookmarks: [{ id: 1, name: '_Toc1' }] }),
    ]);

    const layout: PageLayout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 12,
          fragments: [
            {
              kind: 'paragraph',
              nodeId: 1,
              x: 0,
              y: 0,
              width: 500,
              height: 24,
              fromLine: 0,
              toLine: 1,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
      ],
    };

    expect(findStaleTableOfContentsBlocks(doc, layout)).toHaveLength(0);
  });

  test('findStaleTableOfContentsBlocks treats partially hyperlinked entries as stale', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Heading', { styleId: 'Heading1' })]),
    });
    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const currentToc = state.doc.child(0);
    const currentEntry = currentToc.child(0);
    const expectedHref = String(currentEntry.child(0).marks[0]?.attrs.href);
    const changedChildren: Array<typeof currentEntry> = [];
    currentEntry.forEach((child, _offset, index) => {
      changedChildren.push(index === 1 ? child.mark([]) : child);
    });
    const changedEntry = currentEntry.type.create(currentEntry.attrs, changedChildren);
    const changedToc = currentToc.type.create(currentToc.attrs, [changedEntry]);
    const changedDoc = schema.node('doc', null, [changedToc, state.doc.child(1)]);

    expect(changedEntry.child(0).marks[0]?.attrs.href).toBe(expectedHref);
    expect(changedEntry.child(1).marks).toHaveLength(0);
    expect(findStaleTableOfContentsBlocks(changedDoc)).toHaveLength(1);
  });

  test('findStaleTableOfContentsBlocks treats hyperlinked content with a non-hyperlink instruction as stale', () => {
    const raw = [
      '<w:sdt><w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr><w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3"</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>',
      '<w:hyperlink w:anchor="_Toc1"><w:r><w:t>Heading</w:t></w:r></w:hyperlink>',
      '<w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent></w:sdt>',
    ].join('');
    const linkedEntry = schema.node(
      'paragraph',
      { styleId: 'TOC1', tabs: [TOC_TAB], lineSpacing: 276, lineSpacingRule: 'auto' },
      [
        schema.text('Heading', [schema.marks.hyperlink.create({ href: '#_Toc1' })]),
        schema.node('tab', {
          positional: { alignment: 'right', relativeTo: 'margin', leader: 'dot' },
        }),
        schema.text('1'),
      ]
    );
    const tocWithLinked = schema.node(
      'blockSdt',
      {
        sdtType: 'richText',
        alias: 'Table of Contents',
        rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
        rawPreserveXml: raw,
        rawPreserveText: 'Heading\t1',
      },
      [linkedEntry]
    );
    const linkedDoc = schema.node('doc', null, [
      tocWithLinked,
      paragraph('Heading', { styleId: 'Heading1' }),
    ]);

    expect(findStaleTableOfContentsBlocks(linkedDoc)).toHaveLength(1);
  });

  test('regenerated empty TOC uses TOC1 styled result and is current', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Body copy only')]),
    });

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const updatedToc = state.doc.child(0);
    expect(updatedToc.childCount).toBe(1);
    expect(updatedToc.child(0).attrs.styleId).toBe('TOC1');
    expect(updatedToc.child(0).textContent.trim()).toBe('');
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
    expect(findTableOfContentsBlocks(state.doc)[0].needsUpdate).toBe(false);
    expect(hasTableOfContentsNeedingUpdate(state.doc)).toBe(false);
  });

  test('imported empty TOC without TOC1 result remains stale until regenerated', () => {
    const raw = [
      '<w:sdt><w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr><w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3" \\h</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent></w:sdt>',
    ].join('');
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        rawTocBlock(raw, ''),
        paragraph('Heading', { styleId: 'Heading1' }),
      ]),
    });
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(1);

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
  });
});
