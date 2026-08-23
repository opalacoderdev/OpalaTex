import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clipboardHasText,
  extensionForImageMime,
  extractClipboardFiles,
  isGenericImageName,
  pastedImageName,
} from '../clipboardAttachments.js';

const renameFile = (file, name) => ({ ...file, name });

function fakeClipboard({ items = [], files = [], types = [] } = {}) {
  return {
    types,
    files,
    items: items.map((file) => ({ kind: 'file', getAsFile: () => file })),
  };
}

test('maps image mime types to file extensions', () => {
  assert.equal(extensionForImageMime('image/png'), 'png');
  assert.equal(extensionForImageMime('image/jpeg'), 'jpg');
  assert.equal(extensionForImageMime('image/svg+xml'), 'svg');
  assert.equal(extensionForImageMime(''), 'png');
});

test('recognises the generic names the clipboard produces', () => {
  assert.ok(isGenericImageName('image.png'));
  assert.ok(isGenericImageName('Screenshot.png'));
  assert.ok(isGenericImageName('image (2).png'));
  assert.ok(isGenericImageName(''));
  assert.ok(!isGenericImageName('diagram-final.png'));
});

test('pasted images get unique names', () => {
  const first = pastedImageName('image/png', 0, 1000);
  const second = pastedImageName('image/png', 1, 1000);
  assert.notEqual(first, second);
  assert.ok(first.endsWith('.png'));
});

test('renames every generic image of a multi-image paste', () => {
  const clipboard = fakeClipboard({
    items: [
      { name: 'image.png', type: 'image/png' },
      { name: 'image.png', type: 'image/png' },
    ],
  });

  const files = extractClipboardFiles(clipboard, { timestamp: 7, renameFile });

  assert.equal(files.length, 2);
  assert.notEqual(files[0].name, files[1].name);
});

test('keeps the real name of files copied from a file manager', () => {
  const clipboard = fakeClipboard({
    items: [
      { name: 'chapter.pdf', type: 'application/pdf' },
      { name: 'diagram.png', type: 'image/png' },
    ],
  });

  const files = extractClipboardFiles(clipboard, { timestamp: 7, renameFile });

  assert.deepEqual(files.map((f) => f.name), ['chapter.pdf', 'diagram.png']);
});

test('falls back to clipboardData.files when items carry no file', () => {
  const clipboard = fakeClipboard({ files: [{ name: 'notes.pdf', type: 'application/pdf' }] });

  const files = extractClipboardFiles(clipboard, { timestamp: 7, renameFile });

  assert.deepEqual(files.map((f) => f.name), ['notes.pdf']);
});

test('a text-only paste yields no files', () => {
  const clipboard = fakeClipboard({ types: ['text/plain'] });

  assert.deepEqual(extractClipboardFiles(clipboard, { renameFile }), []);
  assert.ok(clipboardHasText(clipboard));
});

test('an image paste carrying html markup is not treated as text', () => {
  const clipboard = fakeClipboard({ types: ['text/html'], items: [{ name: 'image.png', type: 'image/png' }] });

  assert.ok(!clipboardHasText(clipboard));
  assert.equal(extractClipboardFiles(clipboard, { renameFile }).length, 1);
});

test('a missing clipboard payload is handled', () => {
  assert.deepEqual(extractClipboardFiles(null), []);
  assert.ok(!clipboardHasText(null));
});
