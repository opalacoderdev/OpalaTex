import test from 'node:test';
import assert from 'node:assert/strict';

import {
  childNamesAt,
  inlineCreateKeyAction,
  isSameTreePath,
  resolveInlineCreatePath,
  suggestUniqueName,
  treePathContains,
} from '../inlineCreate.js';

const tree = [
  { name: 'deck.jpt', path: 'deck.jpt', isDirectory: false },
  {
    name: 'slides', path: 'slides', isDirectory: true, children: [
      { name: 'presentation.jpt', path: 'slides/presentation.jpt', isDirectory: false },
      { name: 'nested', path: 'slides/nested', isDirectory: true, children: [] },
    ],
  },
];

test('child names are read from the target directory of the tree', () => {
  assert.deepEqual(childNamesAt(tree, ''), ['deck.jpt', 'slides']);
  assert.deepEqual(childNamesAt(tree, 'slides'), ['presentation.jpt', 'nested']);
  assert.deepEqual(childNamesAt(tree, 'slides\\nested'), []);
  assert.deepEqual(childNamesAt(tree, 'missing'), []);
});

test('suggested presentation names end with .jpt and avoid existing entries', () => {
  assert.equal(suggestUniqueName('presentation', '.jpt', childNamesAt(tree, '')), 'presentation.jpt');
  assert.equal(suggestUniqueName('presentation', '.jpt', childNamesAt(tree, 'slides')), 'presentation-2.jpt');
  assert.equal(suggestUniqueName('presentation', '.jpt', ['PRESENTATION.JPT', 'presentation-2.jpt']), 'presentation-3.jpt');
});

test('typed names resolve inside the target directory', () => {
  assert.deepEqual(resolveInlineCreatePath({ kind: 'dir', parentPath: 'src', name: 'components' }), { path: 'src/components' });
  assert.deepEqual(resolveInlineCreatePath({ kind: 'file', parentPath: '', name: '  main.tex ' }), { path: 'main.tex' });
  assert.deepEqual(resolveInlineCreatePath({ kind: 'file', parentPath: 'a\\b\\', name: 'c/d.txt' }), { path: 'a/b/c/d.txt' });
  assert.deepEqual(resolveInlineCreatePath({ kind: 'dir', parentPath: 'src', name: 'nested/' }), { path: 'src/nested' });
});

test('an empty name cancels instead of creating anything', () => {
  assert.deepEqual(resolveInlineCreatePath({ kind: 'dir', parentPath: 'src', name: '   ' }), { cancelled: true });
  assert.deepEqual(resolveInlineCreatePath({ kind: 'file', parentPath: '', name: '' }), { cancelled: true });
});

test('absolute paths and empty or dot segments are rejected', () => {
  for (const name of ['/etc', 'C:\\temp', '../up', 'a/./b', 'a//b', '..', '/']) {
    assert.deepEqual(resolveInlineCreatePath({ kind: 'file', parentPath: 'src', name }), { error: 'invalid' }, name);
  }
});

test('presentations always get the .jpt extension', () => {
  assert.deepEqual(resolveInlineCreatePath({ kind: 'presentation', parentPath: 'slides', name: 'deck' }), { path: 'slides/deck.jpt' });
  assert.deepEqual(resolveInlineCreatePath({ kind: 'presentation', parentPath: '', name: 'deck.JPT' }), { path: 'deck.JPT' });
  assert.deepEqual(resolveInlineCreatePath({ kind: 'presentation', parentPath: '', name: 'deck.json' }), { path: 'deck.jpt' });
  assert.deepEqual(resolveInlineCreatePath({ kind: 'file', parentPath: '', name: 'notes' }), { path: 'notes' });
});

test('Enter, Tab and Shift+Tab confirm the name; Escape cancels', () => {
  assert.equal(inlineCreateKeyAction({ key: 'Enter' }), 'submit');
  assert.equal(inlineCreateKeyAction({ key: 'Tab' }), 'submit');
  assert.equal(inlineCreateKeyAction({ key: 'Tab', shiftKey: true }), 'submit');
  assert.equal(inlineCreateKeyAction({ key: 'Escape' }), 'cancel');
});

test('other keys and modified Tab chords leave the field alone', () => {
  for (const event of [{ key: 'a' }, { key: 'ArrowDown' }, { key: 'Shift' }, { key: 'Tab', ctrlKey: true }, { key: 'Tab', altKey: true }, { key: 'Tab', metaKey: true }]) {
    assert.equal(inlineCreateKeyAction(event), null, JSON.stringify(event));
  }
});

test('tree path helpers expand ancestors of the target directory only', () => {
  assert.equal(treePathContains('src', 'src/components'), true);
  assert.equal(treePathContains('src', 'src'), true);
  assert.equal(treePathContains('src', 'srcx'), false);
  assert.equal(treePathContains('', 'src'), false);
  assert.equal(treePathContains('a\\b', 'a/b/c'), true);
  assert.equal(isSameTreePath('a\\b', 'a/b/'), true);
  assert.equal(isSameTreePath('a/b', 'a/bc'), false);
});
