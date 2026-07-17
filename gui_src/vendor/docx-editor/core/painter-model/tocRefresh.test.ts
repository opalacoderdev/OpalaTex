import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EditorState } from 'prosemirror-state';

import type { PageLayout } from '../pagination-model/types';
import { schema } from '../prosemirror/schema';
import {
  findStaleTableOfContentsBlocks,
  findTableOfContentsBlocks,
  updateTableOfContents,
} from '../prosemirror/toc';

import {
  syncTocRefreshButtons,
  createTocRefreshSyncCache,
  shouldSyncTocRefreshButtons,
  cleanupTocRefreshButtons,
  applyTocRefreshProxyFocus,
  getTocRefreshDescriptors,
  TOC_BOUNDARY_CLASS,
  TOC_REFRESH_PROXY_FOCUSED_CLASS,
} from './tocRefresh';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const TOC_RAW_EMPTY = [
  '<w:sdt>',
  '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
  '<w:sdtContent>',
  '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
  '<w:r><w:instrText>TOC \\h \\o "1-5"</w:instrText></w:r>',
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
  '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  '</w:sdtContent>',
  '</w:sdt>',
].join('');

const UPDATE_LABEL = 'Update table of contents';

function paragraph(text: string, attrs: Record<string, unknown> = {}) {
  return schema.node('paragraph', attrs, text ? [schema.text(text)] : []);
}

function tocBlock() {
  return schema.node(
    'blockSdt',
    {
      sdtType: 'richText',
      alias: 'Table of Contents',
      rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      rawPreserveXml: TOC_RAW_EMPTY,
      rawPreserveText: '',
    },
    [paragraph('')]
  );
}

function tocDocWithBoundary() {
  const doc = schema.node('doc', null, [
    paragraph(''),
    paragraph(''),
    tocBlock(),
    paragraph('Heading', { styleId: 'Heading1' }),
  ]);
  const blocks = findTableOfContentsBlocks(doc);
  expect(blocks).toHaveLength(1);
  const pos = blocks[0]!.pos;
  return { doc, pos, groupId: `sdt@${pos}` as const };
}

function createSdtBoundaryBox(groupId: string, labelText: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'layout-block-sdt-box';
  box.dataset.sdtGroupId = groupId;
  const label = document.createElement('span');
  label.className = 'layout-block-sdt-label';
  label.textContent = labelText;
  box.appendChild(label);
  return box;
}

function createPaintedContainer(...boxes: HTMLElement[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'layout-page-content';
  for (const box of boxes) {
    container.appendChild(box);
  }
  return container;
}

function currentTocDocWithLayout(): { doc: EditorState['doc']; layout: PageLayout; pos: number } {
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      tocBlock(),
      paragraph('First Heading', { styleId: 'Heading1' }),
      paragraph('Body copy'),
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

  updateTableOfContents(
    state,
    (tr) => {
      state = state.apply(tr);
    },
    { layout }
  );

  const pos = findTableOfContentsBlocks(state.doc)[0]!.pos;
  return { doc: state.doc, layout, pos };
}

describe('syncTocRefreshButtons', () => {
  test('appends a pointer-only refresh button directly to the SDT boundary box', () => {
    const { doc, pos, groupId } = tocDocWithBoundary();

    const container = createPaintedContainer(
      createSdtBoundaryBox(groupId, 'Table of Contents'),
      createSdtBoundaryBox('sdt@99', 'Other control')
    );

    syncTocRefreshButtons(container, { doc, label: UPDATE_LABEL });

    const button = container.querySelector<HTMLButtonElement>('[data-toc-refresh]');
    expect(button?.dataset.tocPosition).toBe(String(pos));
    expect(button?.getAttribute('aria-hidden')).toBe('true');
    expect(button?.tabIndex).toBe(-1);
    expect(button?.getAttribute('aria-label')).toBeNull();
    expect(button?.title).toBe(UPDATE_LABEL);
    expect(button?.querySelector('svg')).not.toBeNull();
    expect(button?.classList.contains('layout-toc-refresh')).toBe(true);
    expect(button?.parentElement?.classList.contains('layout-block-sdt-box')).toBe(true);
    expect(button?.closest('.layout-block-sdt-label')).toBeNull();
    expect(
      container
        .querySelector(`.layout-block-sdt-box[data-sdt-group-id="${groupId}"]`)
        ?.classList.contains(TOC_BOUNDARY_CLASS)
    ).toBe(true);
  });

  test('syncs every painted boundary for one TOC and keeps buttons when current', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const firstBox = createSdtBoundaryBox(groupId, 'Table of Contents');
    const secondBox = createSdtBoundaryBox(groupId, 'Table of Contents');
    const container = createPaintedContainer(firstBox, secondBox);

    syncTocRefreshButtons(container, { doc, label: UPDATE_LABEL });
    syncTocRefreshButtons(container, { doc, label: UPDATE_LABEL });

    expect(firstBox.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
    expect(secondBox.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
    expect(firstBox.classList.contains(TOC_BOUNDARY_CLASS)).toBe(true);
    expect(secondBox.classList.contains(TOC_BOUNDARY_CLASS)).toBe(true);

    const { doc: currentDoc, layout } = currentTocDocWithLayout();
    expect(findStaleTableOfContentsBlocks(currentDoc, layout)).toHaveLength(0);

    const currentGroupId = `sdt@${findTableOfContentsBlocks(currentDoc)[0]!.pos}`;
    const currentFirst = createSdtBoundaryBox(currentGroupId, 'Table of Contents');
    const currentSecond = createSdtBoundaryBox(currentGroupId, 'Table of Contents');
    const currentContainer = createPaintedContainer(currentFirst, currentSecond);
    syncTocRefreshButtons(currentContainer, { doc: currentDoc, label: UPDATE_LABEL });

    expect(currentFirst.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
    expect(currentSecond.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
    expect(currentFirst.classList.contains(TOC_BOUNDARY_CLASS)).toBe(true);
    expect(currentSecond.classList.contains(TOC_BOUNDARY_CLASS)).toBe(true);
  });

  test('decorates a boundary fragment added after a partial cached sync', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const firstBox = createSdtBoundaryBox(groupId, 'Table of Contents');
    const container = createPaintedContainer(firstBox);
    const cache = createTocRefreshSyncCache();
    const options = {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 1,
    };

    syncTocRefreshButtons(container, options, cache);
    const secondBox = createSdtBoundaryBox(groupId, 'Table of Contents');
    container.appendChild(secondBox);

    expect(shouldSyncTocRefreshButtons(container, options, cache)).toBe(true);
    syncTocRefreshButtons(container, options, cache);

    expect(firstBox.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
    expect(secondBox.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
  });

  test('restores proxy focus after rebuilding painted buttons', () => {
    const { doc, pos, groupId } = tocDocWithBoundary();
    const box = createSdtBoundaryBox(groupId, 'Table of Contents');
    const container = createPaintedContainer(box);
    const descriptor = getTocRefreshDescriptors(doc)[0]!;

    syncTocRefreshButtons(container, {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 1,
      focusedTocKey: descriptor.key,
    });
    const firstButton = box.querySelector<HTMLElement>('[data-toc-refresh]')!;
    expect(firstButton.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(true);

    syncTocRefreshButtons(container, {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 2,
      focusedTocKey: descriptor.key,
    });

    const rebuiltButton = box.querySelector<HTMLElement>('[data-toc-refresh]')!;
    expect(rebuiltButton).not.toBe(firstButton);
    expect(rebuiltButton.dataset.tocPosition).toBe(String(pos));
    expect(rebuiltButton.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(true);
    expect(box.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(true);
  });

  test('removes obsolete refresh buttons when the TOC disappears from the document', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const container = createPaintedContainer(createSdtBoundaryBox(groupId, 'Table of Contents'));

    syncTocRefreshButtons(container, { doc, label: UPDATE_LABEL });
    expect(container.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);

    const docWithoutToc = schema.node('doc', null, [paragraph('Body only')]);
    syncTocRefreshButtons(container, { doc: docWithoutToc, label: UPDATE_LABEL });

    expect(container.querySelectorAll('[data-toc-refresh]')).toHaveLength(0);
    expect(
      container
        .querySelector(`.layout-block-sdt-box[data-sdt-group-id="${groupId}"]`)
        ?.classList.contains(TOC_BOUNDARY_CLASS)
    ).toBe(false);
  });

  test('leaves non-TOC SDT boundaries unchanged', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const otherBox = createSdtBoundaryBox('sdt@99', 'Date picker');
    const otherLabel = otherBox.querySelector('.layout-block-sdt-label');
    const otherLabelHtml = otherLabel?.innerHTML ?? '';

    const container = createPaintedContainer(
      createSdtBoundaryBox(groupId, 'Table of Contents'),
      otherBox
    );

    syncTocRefreshButtons(container, { doc, label: UPDATE_LABEL });

    expect(otherBox.classList.contains(TOC_BOUNDARY_CLASS)).toBe(false);
    expect(otherBox.querySelector('[data-toc-refresh]')).toBeNull();
    expect(otherLabel?.innerHTML).toBe(otherLabelHtml);
    expect(otherLabel?.textContent).toBe('Date picker');
  });
});

describe('TocRefreshSyncCache', () => {
  test('shouldSyncTocRefreshButtons returns false when doc, paint root, and generation are unchanged', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const container = createPaintedContainer(createSdtBoundaryBox(groupId, 'Table of Contents'));
    container.dataset.paintGeneration = '1';
    const cache = createTocRefreshSyncCache();
    const options = {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 1,
    };

    syncTocRefreshButtons(container, options, cache);
    expect(shouldSyncTocRefreshButtons(container, options, cache)).toBe(false);
  });

  test('preserves buttons across duplicate same-generation paint events', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const container = createPaintedContainer(createSdtBoundaryBox(groupId, 'Table of Contents'));
    container.dataset.paintGeneration = '1';
    const cache = createTocRefreshSyncCache();
    const options = {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 1,
    };

    syncTocRefreshButtons(container, options, cache);
    const button = container.querySelector('[data-toc-refresh]');
    const descriptors = cache.descriptors;
    expect(button).not.toBeNull();
    const marker = document.createComment('marker');
    button!.appendChild(marker);

    syncTocRefreshButtons(container, options, cache);
    expect(button!.contains(marker)).toBe(true);
    expect(cache.descriptors).toBe(descriptors);
  });

  test('updates the translated label when cached paint inputs are unchanged', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const container = createPaintedContainer(createSdtBoundaryBox(groupId, 'Table of Contents'));
    const cache = createTocRefreshSyncCache();
    const options = {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 1,
    };

    syncTocRefreshButtons(container, options, cache);
    const button = container.querySelector<HTMLButtonElement>('[data-toc-refresh]');
    expect(button?.title).toBe(UPDATE_LABEL);

    syncTocRefreshButtons(container, { ...options, label: 'Mettre à jour la table' }, cache);

    expect(button?.getAttribute('aria-label')).toBeNull();
    expect(button?.title).toBe('Mettre à jour la table');
  });

  test('shouldSyncTocRefreshButtons returns true after paint generation changes', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const firstContainer = createPaintedContainer(
      createSdtBoundaryBox(groupId, 'Table of Contents')
    );
    firstContainer.dataset.paintGeneration = '1';
    const cache = createTocRefreshSyncCache();
    syncTocRefreshButtons(firstContainer, { doc, label: UPDATE_LABEL, paintGeneration: 1 }, cache);

    const repaintedContainer = createPaintedContainer(
      createSdtBoundaryBox(groupId, 'Table of Contents')
    );
    repaintedContainer.dataset.paintGeneration = '2';
    expect(
      shouldSyncTocRefreshButtons(
        repaintedContainer,
        { doc, label: UPDATE_LABEL, paintGeneration: 2 },
        cache
      )
    ).toBe(true);
  });

  test('shouldSyncTocRefreshButtons returns true when TOCs exist but buttons are missing', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const emptyContainer = createPaintedContainer();
    const paintedContainer = createPaintedContainer(
      createSdtBoundaryBox(groupId, 'Table of Contents')
    );
    const cache = createTocRefreshSyncCache();
    const options = {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 1,
    };

    syncTocRefreshButtons(emptyContainer, options, cache);
    expect(emptyContainer.querySelectorAll('[data-toc-refresh]')).toHaveLength(0);

    expect(shouldSyncTocRefreshButtons(paintedContainer, options, cache)).toBe(true);
  });

  test('does not cache a failed decoration when painted boundaries appear later', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const emptyContainer = createPaintedContainer();
    const paintedContainer = createPaintedContainer(
      createSdtBoundaryBox(groupId, 'Table of Contents')
    );
    const cache = createTocRefreshSyncCache();
    const options = {
      doc,
      label: UPDATE_LABEL,
      paintGeneration: 1,
    };

    syncTocRefreshButtons(emptyContainer, options, cache);
    expect(cache.doc).toBeNull();

    syncTocRefreshButtons(paintedContainer, options, cache);
    expect(paintedContainer.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
    expect(cache.doc).toBe(doc);
  });
});

describe('getTocRefreshDescriptors', () => {
  test('keeps a stable key when content before a TOC shifts its position', () => {
    const stableToc = tocBlock().type.create({ ...tocBlock().attrs, id: 77 }, tocBlock().content);
    const before = schema.node('doc', null, [
      stableToc,
      paragraph('Heading', { styleId: 'Heading1' }),
    ]);
    const after = schema.node('doc', null, [
      paragraph('Inserted before'),
      stableToc,
      paragraph('Heading', { styleId: 'Heading1' }),
    ]);

    const beforeDescriptor = getTocRefreshDescriptors(before)[0]!;
    const afterDescriptor = getTocRefreshDescriptors(after)[0]!;

    expect(afterDescriptor.position).not.toBe(beforeDescriptor.position);
    expect(afterDescriptor.key).toBe(beforeDescriptor.key);
  });

  test('uses logical TOC order when no stable SDT id exists', () => {
    const before = schema.node('doc', null, [tocBlock(), paragraph('Heading')]);
    const after = schema.node('doc', null, [
      paragraph('Inserted before'),
      tocBlock(),
      paragraph('Heading'),
    ]);

    expect(getTocRefreshDescriptors(after)[0]!.key).toBe(getTocRefreshDescriptors(before)[0]!.key);
  });
});

describe('cleanupTocRefreshButtons', () => {
  test('removes all painted refresh buttons and boundary classes', () => {
    const { doc, groupId } = tocDocWithBoundary();
    const box = createSdtBoundaryBox(groupId, 'Table of Contents');
    const container = createPaintedContainer(box);

    syncTocRefreshButtons(container, { doc, label: UPDATE_LABEL });
    expect(container.querySelectorAll('[data-toc-refresh]')).toHaveLength(1);
    expect(box.classList.contains(TOC_BOUNDARY_CLASS)).toBe(true);

    cleanupTocRefreshButtons(container);

    expect(container.querySelectorAll('[data-toc-refresh]')).toHaveLength(0);
    expect(box.classList.contains(TOC_BOUNDARY_CLASS)).toBe(false);
    expect(box.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(false);
  });

  test('is idempotent on an already clean container', () => {
    const container = createPaintedContainer(createSdtBoundaryBox('sdt@1', 'Table of Contents'));
    cleanupTocRefreshButtons(container);
    cleanupTocRefreshButtons(container);
    expect(container.querySelectorAll('[data-toc-refresh]')).toHaveLength(0);
  });
});

describe('applyTocRefreshProxyFocus', () => {
  test('marks every painted boundary for the target TOC and clears on blur', () => {
    const { doc, pos, groupId } = tocDocWithBoundary();
    const firstBox = createSdtBoundaryBox(groupId, 'Table of Contents');
    const secondBox = createSdtBoundaryBox(groupId, 'Table of Contents');
    const otherBox = createSdtBoundaryBox('sdt@99', 'Other control');
    const container = createPaintedContainer(firstBox, secondBox, otherBox);

    syncTocRefreshButtons(container, { doc, label: UPDATE_LABEL });

    applyTocRefreshProxyFocus(container, pos);

    expect(firstBox.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(true);
    expect(secondBox.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(true);
    expect(otherBox.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(false);
    expect(
      firstBox
        .querySelector('.layout-toc-refresh')
        ?.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)
    ).toBe(true);

    applyTocRefreshProxyFocus(container, null);

    expect(firstBox.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(false);
    expect(secondBox.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)).toBe(false);
    expect(
      firstBox
        .querySelector('.layout-toc-refresh')
        ?.classList.contains(TOC_REFRESH_PROXY_FOCUSED_CLASS)
    ).toBe(false);
  });
});
