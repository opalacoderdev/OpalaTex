import { describe, expect, test } from 'bun:test';
import { EditorState, TextSelection } from 'prosemirror-state';
import { parseDocumentBody } from '../../docx/documentParser';
import { serializeDocumentBody } from '../../docx/serializer/documentSerializer';
import type { PageLayout } from '../../pagination-model/types';
import type { BlockSdt } from '../../types/document';
import { fromProseDoc } from '../conversion/fromProseDoc';
import {
  findStaleTableOfContentsBlocks,
  findTableOfContentsBlocks,
  hasTableOfContentsNeedingUpdate,
  insertTableOfContents,
  parseTocInstruction,
  updateTableOfContents,
} from '../toc';
import { paragraph, rawTocBlock, schema, tocBlock } from './tocTestHelpers';

describe('TOC field support', () => {
  test('parses common TOC field instructions and preserves unknown switches', () => {
    const parsed = parseTocInstruction(' TOC \\h \\o "1-5" \\z ');
    expect(parsed).toEqual({
      type: 'TOC',
      hyperlink: true,
      outlineStart: 1,
      outlineEnd: 5,
      raw: 'TOC \\h \\o "1-5" \\z',
      unknownSwitches: ['\\z'],
    });
  });

  test('detects dirty or empty block SDT TOCs', () => {
    const doc = schema.node('doc', null, [
      tocBlock(),
      paragraph('Heading', { styleId: 'Heading1' }),
    ]);
    const blocks = findTableOfContentsBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].needsUpdate).toBe(true);
    expect(hasTableOfContentsNeedingUpdate(doc)).toBe(true);
  });

  test('detects Word numeric dirty TOC fields in raw SDT XML', () => {
    const raw = [
      '<w:sdt><w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr><w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="1"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3" \\h</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:r><w:t>Heading</w:t></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent></w:sdt>',
    ].join('');
    const doc = schema.node('doc', null, [rawTocBlock(raw)]);

    expect(findTableOfContentsBlocks(doc)[0].needsUpdate).toBe(true);
    expect(hasTableOfContentsNeedingUpdate(doc)).toBe(true);
  });

  test('updates cached TOC result while preserving the field envelope', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('First Heading', { styleId: 'Heading1' }),
        paragraph('Second Heading', { outlineLevel: 1 }),
      ]),
    });

    let firstHeadingPos = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'First Heading') {
        firstHeadingPos = pos;
        return false;
      }
      return true;
    });

    const layout: PageLayout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 3,
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
              docFrom: firstHeadingPos,
              docTo: firstHeadingPos + 20,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
      ],
    };

    const updated = updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      { layout }
    );

    expect(updated).toBe(true);
    const updatedToc = state.doc.child(0);
    expect(updatedToc.textContent).toContain('First Heading');
    expect(updatedToc.textContent).toContain('3');
    expect(updatedToc.child(0).attrs.styleId).toBe('TOC1');
    expect(updatedToc.child(1).attrs.styleId).toBe('TOC2');
    expect(updatedToc.child(0).attrs.indentLeft).toBeNull();
    expect(updatedToc.child(1).attrs.indentLeft).toBe(240);
    expect(updatedToc.child(0).attrs.lineSpacing).toBe(276);

    const raw = updatedToc.attrs.rawPreserveXml as string;
    expect(raw).toContain('w:fldCharType="begin"');
    expect(raw).toContain('TOC \\h \\o &quot;1-5&quot;');
    expect(raw).toContain('w:fldCharType="separate"');
    expect(raw).toContain('w:fldCharType="end"');
    expect(raw).toContain('w:pStyle w:val="TOC1"');
    expect(raw).toContain('w:anchor="_Toc');
    expect(raw).not.toContain('w:dirty="true"');

    const heading = state.doc.child(1);
    expect(heading.attrs.bookmarks?.[0]?.name).toMatch(/^_Toc/);

    // The regenerated TOC must save via its raw XML: the stored fingerprint
    // has to match the tab-aware fingerprint the preservation guard computes,
    // even though the generated entries contain tab leader nodes.
    const saved = fromProseDoc(state.doc);
    const savedSdt = saved.package.document.content[0] as BlockSdt;
    expect(savedSdt.rawPreserveXml).toBe(raw);

    // And the saved XML must reopen cleanly: the parser re-captures raw
    // preservation for the regenerated field and the entries stay intact.
    const savedXml = serializeDocumentBody(saved.package.document);
    const bodyXml = savedXml.replace(/^<w:body>/, '').replace(/<\/w:body>$/, '');
    const reopened = parseDocumentBody(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`
    );
    const reopenedSdt = reopened.content[0] as BlockSdt;
    expect(reopenedSdt.type).toBe('blockSdt');
    expect(reopenedSdt.rawPreserveXml).toBeTruthy();
    expect(reopenedSdt.rawPreserveText).toContain('First Heading\t3');
    expect(reopenedSdt.rawPreserveText).toContain('Second Heading\t');

    const updatedAgain = updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      {
        layout: {
          ...layout,
          pages: layout.pages.map((page) => ({
            ...page,
            number: 4,
          })),
        },
      }
    );
    expect(updatedAgain).toBe(true);
    expect(state.doc.child(0).attrs.rawPreserveText).toContain('First Heading\t4');
  });

  test('resolves a page-break-before TOC title to the page after the break', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        paragraph('Table of Contents', { styleId: 'Heading1', pageBreakBefore: true }),
        tocBlock(),
        paragraph('First Heading', { styleId: 'Heading1' }),
      ]),
    });

    const layout: PageLayout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 1,
          fragments: [
            {
              kind: 'paragraph',
              nodeId: 0,
              x: 0,
              y: 1000,
              width: 500,
              height: 0,
              fromLine: 0,
              toLine: 0,
            },
          ],
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          size: { w: 816, h: 1056 },
        },
        {
          number: 2,
          fragments: [
            {
              kind: 'paragraph',
              nodeId: 0,
              x: 0,
              y: 100,
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

    const updated = updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      { layout }
    );

    expect(updated).toBe(true);
    const updatedToc = state.doc.child(1);
    expect(updatedToc.attrs.rawPreserveText).toContain('Table of Contents\t2');
  });

  test('ignores nested PAGEREF instructions in Word cached TOC results', () => {
    const raw = [
      '<w:sdt>',
      '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      '<w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3" \\h \\z \\u</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:r><w:t>Heading</w:t></w:r><w:r><w:tab/></w:r>',
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>PAGEREF _Toc1 \\h</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r>',
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent>',
      '</w:sdt>',
    ].join('');
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        rawTocBlock(raw),
        paragraph('Heading', { styleId: 'Heading1' }),
      ]),
    });

    const block = findTableOfContentsBlocks(state.doc)[0];
    expect(block.instruction.raw).toBe('TOC \\o "1-3" \\h \\z \\u');

    const updated = updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    expect(updated).toBe(true);
    const regeneratedRaw = findTableOfContentsBlocks(state.doc)[0].node.attrs
      .rawPreserveXml as string;
    expect(regeneratedRaw).toContain('TOC \\o &quot;1-3&quot; \\h \\z \\u');
    expect(regeneratedRaw).not.toContain('PAGEREF');
  });

  test('findStaleTableOfContentsBlocks reports dirty imported fields as stale', () => {
    const doc = schema.node('doc', null, [
      tocBlock(),
      paragraph('Heading', { styleId: 'Heading1' }),
    ]);
    expect(findStaleTableOfContentsBlocks(doc)).toHaveLength(1);
  });

  test('findStaleTableOfContentsBlocks reports a clean empty imported field as stale', () => {
    const raw = [
      '<w:sdt><w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr><w:sdtContent>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-3" \\h</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent></w:sdt>',
    ].join('');
    const emptyDoc = schema.node('doc', null, [
      rawTocBlock(raw, ''),
      paragraph('Heading', { styleId: 'Heading1' }),
    ]);
    expect(findStaleTableOfContentsBlocks(emptyDoc)).toHaveLength(1);
  });

  test('findStaleTableOfContentsBlocks detects a link-only mismatch', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Heading', { styleId: 'Heading1' })]),
    });
    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const currentToc = state.doc.child(0);
    const currentEntry = currentToc.child(0);
    const wrongLink = schema.marks.hyperlink.create({ href: '#_TocWrong' });
    const changedChildren: Array<typeof currentEntry> = [];
    currentEntry.forEach((child) => {
      changedChildren.push(child.mark([wrongLink]));
    });
    const changedEntry = currentEntry.type.create(currentEntry.attrs, changedChildren);
    const changedToc = currentToc.type.create(currentToc.attrs, [changedEntry]);
    const changedDoc = schema.node('doc', null, [changedToc, state.doc.child(1)]);

    expect(changedToc.textContent).toBe(currentToc.textContent);
    expect(findStaleTableOfContentsBlocks(changedDoc)).toHaveLength(1);
  });

  test('allocates unique links for headings with duplicate imported TOC bookmarks', () => {
    const duplicateBookmark = [{ id: 7, name: '_TocDuplicate' }];
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('First Heading', {
          styleId: 'Heading1',
          bookmarks: duplicateBookmark,
        }),
        paragraph('Copied Heading', {
          styleId: 'Heading1',
          bookmarks: duplicateBookmark,
        }),
      ]),
    });

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const updatedToc = state.doc.child(0);
    const hrefs: string[] = [];
    updatedToc.forEach((entry) => {
      const text = entry.child(0);
      const link = text.marks.find((mark) => mark.type.name === 'hyperlink');
      hrefs.push(String(link?.attrs.href));
    });
    expect(new Set(hrefs).size).toBe(2);

    const headingBookmarks = [state.doc.child(1), state.doc.child(2)].map(
      (heading) =>
        (heading.attrs.bookmarks as Array<{ id: number; name: string }>).find((bookmark) =>
          bookmark.name.startsWith('_Toc')
        )?.name
    );
    expect(new Set(headingBookmarks).size).toBe(2);
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
  });

  test('findStaleTableOfContentsBlocks compares normalized TOC results', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('First Heading', { styleId: 'Heading1' }),
        paragraph('Second Heading', { outlineLevel: 1 }),
        paragraph('Body copy'),
      ]),
    });

    const layout: PageLayout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 3,
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
            {
              kind: 'paragraph',
              nodeId: 2,
              x: 0,
              y: 24,
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

    updateTableOfContents(
      state,
      (tr) => {
        state = state.apply(tr);
      },
      { layout }
    );

    const currentDoc = state.doc;
    expect(findStaleTableOfContentsBlocks(currentDoc, layout)).toHaveLength(0);

    const renamedHeadingDoc = schema.node('doc', null, [
      currentDoc.child(0),
      paragraph('Renamed Heading', { styleId: 'Heading1' }),
      currentDoc.child(2),
      currentDoc.child(3),
    ]);
    expect(findStaleTableOfContentsBlocks(renamedHeadingDoc, layout)).toHaveLength(1);

    const changedLevelDoc = schema.node('doc', null, [
      currentDoc.child(0),
      currentDoc.child(1),
      paragraph('Second Heading', { styleId: 'Heading3' }),
      currentDoc.child(3),
    ]);
    expect(findStaleTableOfContentsBlocks(changedLevelDoc, layout)).toHaveLength(1);

    const addedHeadingDoc = schema.node('doc', null, [
      currentDoc.child(0),
      currentDoc.child(1),
      currentDoc.child(2),
      paragraph('Third Heading', { styleId: 'Heading1' }),
      currentDoc.child(3),
    ]);
    expect(findStaleTableOfContentsBlocks(addedHeadingDoc, layout)).toHaveLength(1);

    const removedHeadingDoc = schema.node('doc', null, [
      currentDoc.child(0),
      currentDoc.child(1),
      currentDoc.child(3),
    ]);
    expect(findStaleTableOfContentsBlocks(removedHeadingDoc, layout)).toHaveLength(1);

    const changedLayout: PageLayout = {
      ...layout,
      pages: layout.pages.map((page) => ({ ...page, number: 4 })),
    };
    expect(findStaleTableOfContentsBlocks(currentDoc, changedLayout)).toHaveLength(1);

    const unrelatedBodyEditDoc = schema.node('doc', null, [
      currentDoc.child(0),
      currentDoc.child(1),
      currentDoc.child(2),
      paragraph('Edited body copy'),
    ]);
    expect(findStaleTableOfContentsBlocks(unrelatedBodyEditDoc, layout)).toHaveLength(0);
  });

  test('findStaleTableOfContentsBlocks ignores page numbers when layout is absent', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('First Heading', { styleId: 'Heading1' }),
      ]),
    });

    let firstHeadingPos = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'First Heading') {
        firstHeadingPos = pos;
        return false;
      }
      return true;
    });

    const layout: PageLayout = {
      pageSize: { w: 816, h: 1056 },
      pages: [
        {
          number: 3,
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
              docFrom: firstHeadingPos,
              docTo: firstHeadingPos + 20,
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

    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
  });

  test('regenerates to an empty result when no headings match', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Body copy only')]),
    });

    const updated = updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    expect(updated).toBe(true);
    const updatedToc = state.doc.child(0);
    expect(updatedToc.textContent.trim()).toBe('');
    expect(updatedToc.childCount).toBe(1);
    expect(updatedToc.child(0).attrs.styleId).toBe('TOC1');
    expect(updatedToc.child(0).textContent.trim()).toBe('');

    const raw = updatedToc.attrs.rawPreserveXml as string;
    expect(raw).toContain('w:fldCharType="begin"');
    expect(raw).toContain('w:fldCharType="separate"');
    expect(raw).toContain('w:fldCharType="end"');
    expect(raw).not.toContain('w:dirty="true"');
    expect(raw).not.toMatch(/<w:t\b[^>]*>[\s\S]+<\/w:t>/);
    expect(updatedToc.attrs.rawPreserveText).toBe('');
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
  });

  test('regenerating to empty clears stale state after removing the last heading', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('Only Heading', { styleId: 'Heading1' }),
      ]),
    });

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);

    state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [state.doc.child(0), paragraph('Body without headings')]),
    });
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(1);

    const updated = updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });
    expect(updated).toBe(true);
    expect(state.doc.child(0).textContent.trim()).toBe('');
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
  });

  test('findStaleTableOfContentsBlocks treats unexpected visible TOC paragraphs as stale', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Heading', { styleId: 'Heading1' })]),
    });
    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const currentToc = state.doc.child(0);
    const stray = paragraph('Stray visible line');
    const changedToc = currentToc.type.create(currentToc.attrs, [
      ...Array.from({ length: currentToc.childCount }, (_, i) => currentToc.child(i)),
      stray,
    ]);
    const changedDoc = schema.node('doc', null, [changedToc, state.doc.child(1)]);
    expect(findStaleTableOfContentsBlocks(changedDoc)).toHaveLength(1);
  });

  test('findStaleTableOfContentsBlocks tolerates structural empty field-boundary paragraphs', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Heading', { styleId: 'Heading1' })]),
    });
    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const currentToc = state.doc.child(0);
    const boundary = paragraph('');
    const withBoundary = currentToc.type.create(currentToc.attrs, [
      boundary,
      ...Array.from({ length: currentToc.childCount }, (_, i) => currentToc.child(i)),
    ]);
    const doc = schema.node('doc', null, [withBoundary, state.doc.child(1)]);
    expect(findStaleTableOfContentsBlocks(doc)).toHaveLength(0);
  });

  test('avoids reusing a heading _Toc bookmark that is duplicated elsewhere in the document', () => {
    const shared = [{ id: 42, name: '_TocShared' }];
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('First', { styleId: 'Heading1', bookmarks: shared }),
        paragraph('Second', { styleId: 'Heading1', bookmarks: shared }),
        paragraph('Anchor', { bookmarks: [{ id: 99, name: '_TocExternal' }] }),
      ]),
    });

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const tocBookmarks = [state.doc.child(1), state.doc.child(2)].map(
      (heading) =>
        (heading.attrs.bookmarks as Array<{ id: number; name: string }>).find((bookmark) =>
          bookmark.name.startsWith('_Toc')
        )?.name
    );
    expect(new Set(tocBookmarks).size).toBe(2);
    expect(tocBookmarks).not.toContain('_TocShared');
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);
  });

  test('allocates collision-free bookmark IDs against existing document bookmarks', () => {
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
        paragraph('Reserved', { bookmarks: [{ id: 1, name: '_Reserved' }] }),
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
        paragraph('Reserved', { bookmarks: [{ id: collidingId, name: '_Reserved' }] }),
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

  test('preserves a unique heading bookmark name and ID across repeated updates', () => {
    const reusableBookmark = { id: 41, name: '_TocStable' };
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('Stable Heading', {
          styleId: 'Heading1',
          bookmarks: [reusableBookmark],
        }),
      ]),
    });

    const update = () => {
      let dispatched = false;
      const changed = updateTableOfContents(state, (tr) => {
        dispatched = true;
        state = state.apply(tr);
      });
      return { changed, dispatched };
    };

    expect(update()).toEqual({ changed: true, dispatched: true });
    const firstBookmarks = state.doc.child(1).attrs.bookmarks;
    expect(firstBookmarks).toEqual([reusableBookmark]);

    expect(update()).toEqual({ changed: false, dispatched: false });
    expect(state.doc.child(1).attrs.bookmarks).toEqual(firstBookmarks);

    expect(update()).toEqual({ changed: false, dispatched: false });
    expect(state.doc.child(1).attrs.bookmarks).toEqual(firstBookmarks);
  });

  test('reserves bookmark IDs retained by empty styled headings', () => {
    const hashString = (input: string): number => {
      let hash = 0;
      for (let i = 0; i < input.length; i++) {
        hash = (hash * 31 + input.charCodeAt(i)) | 0;
      }
      return hash;
    };
    const emptyBookmarkName = '_TocEmptyHeading';
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('', {
          styleId: 'Heading1',
          bookmarks: [{ id: 1, name: emptyBookmarkName }],
        }),
        paragraph('Generated Heading', { styleId: 'Heading1' }),
      ]),
    });

    let generatedHeadingPos = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Generated Heading') {
        generatedHeadingPos = pos;
        return false;
      }
      return true;
    });
    const generatedName = `_Toc${Math.abs(hashString(`${generatedHeadingPos}:Generated Heading`))}`;
    const collidingId = Math.abs(hashString(generatedName)) % 2147483647 || 1;
    state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('', {
          styleId: 'Heading1',
          bookmarks: [{ id: collidingId, name: emptyBookmarkName }],
        }),
        paragraph('Generated Heading', { styleId: 'Heading1' }),
      ]),
    });

    const update = () =>
      updateTableOfContents(state, (tr) => {
        state = state.apply(tr);
      });

    expect(update()).toBe(true);
    const firstIds = [state.doc.child(1), state.doc.child(2)].flatMap((heading) =>
      (heading.attrs.bookmarks as Array<{ id: number; name: string }>).map(
        (bookmark) => bookmark.id
      )
    );
    expect(firstIds).toHaveLength(2);
    expect(new Set(firstIds).size).toBe(2);
    expect(state.doc.child(1).attrs.bookmarks).toEqual([
      { id: collidingId, name: emptyBookmarkName },
    ]);

    expect(update()).toBe(false);
    expect(
      [state.doc.child(1), state.doc.child(2)].flatMap((heading) =>
        (heading.attrs.bookmarks as Array<{ id: number; name: string }>).map(
          (bookmark) => bookmark.id
        )
      )
    ).toEqual(firstIds);
  });

  test('findStaleTableOfContentsBlocks treats an image-only result paragraph as visible', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Heading', { styleId: 'Heading1' })]),
    });
    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    const currentToc = state.doc.child(0);
    const imageParagraph = schema.node('paragraph', {}, [
      schema.node('image', { src: 'data:image/png;base64,AA==' }),
    ]);
    const changedToc = currentToc.type.create(currentToc.attrs, [
      ...Array.from({ length: currentToc.childCount }, (_, i) => currentToc.child(i)),
      imageParagraph,
    ]);
    const changedDoc = schema.node('doc', null, [changedToc, state.doc.child(1)]);

    expect(imageParagraph.textContent).toBe('');
    expect(findStaleTableOfContentsBlocks(changedDoc)).toHaveLength(1);
  });

  test('findStaleTableOfContentsBlocks treats rendering inline atoms as visible', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [tocBlock(), paragraph('Heading', { styleId: 'Heading1' })]),
    });
    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    for (const atom of [
      schema.node('hardBreak'),
      schema.node('tab'),
      schema.node('math', { plainText: '', ommlXml: '<m:oMath/>' }),
      schema.node('symbol', { font: 'Wingdings', char: 'F0A7', text: '' }),
    ]) {
      const currentToc = state.doc.child(0);
      const atomParagraph = schema.node('paragraph', {}, [atom]);
      const changedToc = currentToc.type.create(currentToc.attrs, [
        ...Array.from({ length: currentToc.childCount }, (_, i) => currentToc.child(i)),
        atomParagraph,
      ]);
      const changedDoc = schema.node('doc', null, [changedToc, state.doc.child(1)]);

      expect(findStaleTableOfContentsBlocks(changedDoc)).toHaveLength(1);
    }
  });

  test('inserts a real dirty TOC field block at the current selection', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        paragraph('Intro'),
        paragraph('First Heading', { styleId: 'Heading1' }),
      ]),
    });
    const insertPos = state.doc.child(0).nodeSize;
    state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(insertPos))));

    const inserted = insertTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    expect(inserted).toBe(true);
    const insertedToc = findTableOfContentsBlocks(state.doc)[0];
    expect(insertedToc.node.type.name).toBe('blockSdt');
    expect(hasTableOfContentsNeedingUpdate(state.doc)).toBe(true);

    const updated = updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });

    expect(updated).toBe(true);
    expect(findTableOfContentsBlocks(state.doc)[0].node.attrs.rawPreserveText).toContain(
      'First Heading'
    );
  });

  test('force update regenerates a current TOC at the given position', () => {
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        tocBlock(),
        paragraph('Stable Heading', { styleId: 'Heading1' }),
      ]),
    });

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });
    expect(findStaleTableOfContentsBlocks(state.doc)).toHaveLength(0);

    const tocPos = findTableOfContentsBlocks(state.doc)[0]!.pos;
    expect(updateTableOfContents(state, undefined, { position: tocPos })).toBe(false);

    expect(updateTableOfContents(state, undefined, { position: tocPos, force: true })).toBe(true);
  });

  test('forced non-hyperlinked update dispatches without adding _Toc bookmarks', () => {
    const raw = [
      '<w:sdt><w:sdtPr><w:id w:val="77"/><w:alias w:val="Table of Contents"/></w:sdtPr>',
      '<w:sdtContent><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>',
      '<w:r><w:instrText>TOC \\o "1-5"</w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      '</w:sdtContent></w:sdt>',
    ].join('');
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        rawTocBlock(raw, ''),
        paragraph('Stable Heading', { styleId: 'Heading1' }),
      ]),
    });

    updateTableOfContents(state, (tr) => {
      state = state.apply(tr);
    });
    const tocPos = findTableOfContentsBlocks(state.doc)[0]!.pos;
    let dispatched = 0;

    expect(
      updateTableOfContents(
        state,
        (tr) => {
          dispatched++;
          state = state.apply(tr);
        },
        { position: tocPos, force: true }
      )
    ).toBe(true);
    expect(dispatched).toBe(1);
    expect(state.doc.child(1).attrs.bookmarks ?? []).toEqual([]);
    expect(state.doc.child(0).textContent).toContain('Stable Heading');
  });
});
