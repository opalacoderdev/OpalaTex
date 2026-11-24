// Guards the Copy action across every document/text context menu in the IDE:
// PDF viewer (`PdfContextMenu`), Markdown preview (`MarkdownContextMenu`),
// Monaco code/diff editor (`EditorContextMenuOverlay`), and text surfaces
// (`TextContextMenu`, shared by Chat, BottomPanel, RichTextEditor and
// LatexWysiwygEditor). Every surface must offer Copy, and Copy must be disabled
// whenever nothing is selected.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const GUI_SRC = fileURLToPath(new URL('../../..', import.meta.url));

let server;
let PdfContextMenu;
let MarkdownContextMenu;
let EditorContextMenuOverlay;
let TextContextMenu;
let i18n;

before(async () => {
  server = await createServer({
    configFile: false,
    root: GUI_SRC,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  });
  ({ default: i18n } = await server.ssrLoadModule('/src/i18n/index.js'));
  await i18n.changeLanguage('en');
  ({ default: PdfContextMenu } = await server.ssrLoadModule('/src/components/PdfContextMenu.jsx'));
  ({ default: MarkdownContextMenu } = await server.ssrLoadModule('/src/components/MarkdownContextMenu.jsx'));
  ({ default: EditorContextMenuOverlay } = await server.ssrLoadModule('/src/components/EditorContextMenuOverlay.jsx'));
  ({ default: TextContextMenu } = await server.ssrLoadModule('/src/components/TextContextMenu.jsx'));
});

after(async () => {
  await server?.close();
});

const noop = () => {};
const tIdentity = (_key, fallback) => fallback || _key;

// Extracts the opening tag of the menuitem whose body contains `label`.
function menuItemOpeningTag(html, label) {
  const re = /<(div|button)\b([^>]*role="menuitem"[^>]*)>([\s\S]*?)<\/\1>/g;
  for (const match of html.matchAll(re)) {
    const [, tag, attrs, body] = match;
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text === label || text.startsWith(`${label} `)) {
      return { tag, attrs, text };
    }
  }
  return null;
}

test('PdfContextMenu offers Copy and disables it when nothing is selected', () => {
  const emptyHtml = renderToStaticMarkup(React.createElement(PdfContextMenu, {
    menu: { x: 10, y: 20, selectedText: '', page: 1, annotation: null },
    onClose: noop,
    onCopy: noop,
    onAskAbout: noop,
    onTranslate: noop,
  }));
  const emptyCopy = menuItemOpeningTag(emptyHtml, 'Copy');
  assert.ok(emptyCopy, 'Copy item must render in PdfContextMenu');
  assert.match(emptyCopy.attrs, /aria-disabled="true"/);
  assert.match(emptyCopy.attrs, /vscode-context-menu-item-disabled/);

  const selectedHtml = renderToStaticMarkup(React.createElement(PdfContextMenu, {
    menu: { x: 10, y: 20, selectedText: 'selected PDF passage', page: 1, annotation: null },
    onClose: noop,
    onCopy: noop,
    onAskAbout: noop,
    onTranslate: noop,
  }));
  const selectedCopy = menuItemOpeningTag(selectedHtml, 'Copy');
  assert.ok(selectedCopy, 'Copy item must render in PdfContextMenu with a selection');
  assert.match(selectedCopy.attrs, /aria-disabled="false"/);
  assert.doesNotMatch(selectedCopy.attrs, /vscode-context-menu-item-disabled/);
});

test('MarkdownContextMenu offers Copy and disables it when nothing is selected', () => {
  const emptyHtml = renderToStaticMarkup(React.createElement(MarkdownContextMenu, {
    menu: { x: 10, y: 20, selectedText: '', heading: '' },
    onClose: noop,
    onCopy: noop,
    onAskAbout: noop,
    onTranslate: noop,
  }));
  const emptyCopy = menuItemOpeningTag(emptyHtml, 'Copy');
  assert.ok(emptyCopy, 'Copy item must render in MarkdownContextMenu');
  assert.match(emptyCopy.attrs, /aria-disabled="true"/);
  assert.match(emptyCopy.attrs, /vscode-context-menu-item-disabled/);

  const selectedHtml = renderToStaticMarkup(React.createElement(MarkdownContextMenu, {
    menu: { x: 10, y: 20, selectedText: 'selected markdown text', heading: 'Intro' },
    onClose: noop,
    onCopy: noop,
    onAskAbout: noop,
    onTranslate: noop,
  }));
  const selectedCopy = menuItemOpeningTag(selectedHtml, 'Copy');
  assert.ok(selectedCopy, 'Copy item must render in MarkdownContextMenu with a selection');
  assert.match(selectedCopy.attrs, /aria-disabled="false"/);
  assert.doesNotMatch(selectedCopy.attrs, /vscode-context-menu-item-disabled/);
});

const HAS_DISABLED_ATTR = /(?:^|\s)disabled(?:=""|(?=\s|$))/;

test('EditorContextMenuOverlay disables Copy and Cut when nothing is selected', () => {
  const baseMenu = {
    x: 10,
    y: 20,
    editor: { focus: noop },
    monaco: {},
    pos: { lineNumber: 1, column: 1 },
    sel: null,
  };

  const emptyHtml = renderToStaticMarkup(React.createElement(EditorContextMenuOverlay, {
    menu: { ...baseMenu, hasSelection: false, selectedText: '' },
    onClose: noop,
    setInlinePrompt: noop,
    t: tIdentity,
  }));
  const emptyCopy = menuItemOpeningTag(emptyHtml, 'Copy');
  const emptyCut = menuItemOpeningTag(emptyHtml, 'Cut');
  const emptyPaste = menuItemOpeningTag(emptyHtml, 'Paste');
  assert.ok(emptyCopy && emptyCut && emptyPaste);
  assert.match(emptyCopy.attrs, HAS_DISABLED_ATTR);
  assert.match(emptyCopy.attrs, /aria-disabled="true"/);
  assert.match(emptyCut.attrs, HAS_DISABLED_ATTR);
  assert.doesNotMatch(emptyPaste.attrs, HAS_DISABLED_ATTR);

  const selectedHtml = renderToStaticMarkup(React.createElement(EditorContextMenuOverlay, {
    menu: { ...baseMenu, hasSelection: true, selectedText: 'const x = 1;' },
    onClose: noop,
    setInlinePrompt: noop,
    t: tIdentity,
  }));
  const selectedCopy = menuItemOpeningTag(selectedHtml, 'Copy');
  const selectedCut = menuItemOpeningTag(selectedHtml, 'Cut');
  assert.ok(selectedCopy && selectedCut);
  assert.doesNotMatch(selectedCopy.attrs, HAS_DISABLED_ATTR);
  assert.match(selectedCopy.attrs, /aria-disabled="false"/);
  assert.doesNotMatch(selectedCut.attrs, HAS_DISABLED_ATTR);

  // Original (read-only) side of DiffEditor still lets the user copy a selection,
  // while keeping Cut and Paste disabled.
  const readOnlyHtml = renderToStaticMarkup(React.createElement(EditorContextMenuOverlay, {
    menu: { ...baseMenu, hasSelection: true, selectedText: 'old line', isReadOnly: true },
    onClose: noop,
    setInlinePrompt: noop,
    t: tIdentity,
  }));
  const roCopy = menuItemOpeningTag(readOnlyHtml, 'Copy');
  const roCut = menuItemOpeningTag(readOnlyHtml, 'Cut');
  const roPaste = menuItemOpeningTag(readOnlyHtml, 'Paste');
  assert.ok(roCopy && roCut && roPaste);
  assert.doesNotMatch(roCopy.attrs, HAS_DISABLED_ATTR);
  assert.match(roCut.attrs, HAS_DISABLED_ATTR);
  assert.match(roPaste.attrs, HAS_DISABLED_ATTR);
});

test('TextContextMenu disables Copy and Cut when nothing is selected', () => {
  const emptyHtml = renderToStaticMarkup(React.createElement(TextContextMenu, {
    menu: { x: 10, y: 20, selectedText: '' },
    onClose: noop,
    onCopy: noop,
    onCut: noop,
    onPaste: noop,
  }));
  const emptyCopy = menuItemOpeningTag(emptyHtml, 'Copy');
  const emptyCut = menuItemOpeningTag(emptyHtml, 'Cut');
  const emptyPaste = menuItemOpeningTag(emptyHtml, 'Paste');
  assert.ok(emptyCopy && emptyCut && emptyPaste);
  assert.match(emptyCopy.attrs, /aria-disabled="true"/);
  assert.match(emptyCopy.attrs, /vscode-context-menu-item-disabled/);
  assert.match(emptyCut.attrs, /aria-disabled="true"/);
  assert.match(emptyCut.attrs, /vscode-context-menu-item-disabled/);
  assert.match(emptyPaste.attrs, /aria-disabled="false"/);

  const selectedHtml = renderToStaticMarkup(React.createElement(TextContextMenu, {
    menu: { x: 10, y: 20, selectedText: 'copied excerpt' },
    onClose: noop,
    onCopy: noop,
    onCut: noop,
    onPaste: noop,
    canCut: false,
  }));
  const selectedCopy = menuItemOpeningTag(selectedHtml, 'Copy');
  const selectedCut = menuItemOpeningTag(selectedHtml, 'Cut');
  assert.ok(selectedCopy && selectedCut);
  assert.match(selectedCopy.attrs, /aria-disabled="false"/);
  assert.doesNotMatch(selectedCopy.attrs, /vscode-context-menu-item-disabled/);
  assert.match(selectedCut.attrs, /aria-disabled="true"/);
});
