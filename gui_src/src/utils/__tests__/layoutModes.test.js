import test from 'node:test';
import assert from 'node:assert/strict';

import { EDITOR_LAYOUTS, layoutAfterOpeningFile, layoutShowsEditor } from '../layoutModes.js';

test('the layouts that show the editor are the ones that dock a sidebar', () => {
  assert.deepEqual(EDITOR_LAYOUTS, ['ide', 'studio', 'document']);
  for (const mode of EDITOR_LAYOUTS) assert.equal(layoutShowsEditor(mode), true);
});

test('the chat-first and review layouts do not show the editor', () => {
  for (const mode of ['chat', 'chat-bottom', 'review']) {
    assert.equal(layoutShowsEditor(mode), false);
  }
});

test('an unknown or missing mode is treated as not showing the editor', () => {
  assert.equal(layoutShowsEditor(undefined), false);
  assert.equal(layoutShowsEditor('chat-compare'), false);
});

test('opening a file keeps a layout that already shows the editor', () => {
  // The document layout exists to show one file and its preview, so opening a
  // file from its explorer must not switch layouts.
  assert.equal(layoutAfterOpeningFile('document'), 'document');
  assert.equal(layoutAfterOpeningFile('studio'), 'studio');
  assert.equal(layoutAfterOpeningFile('ide'), 'ide');
});

test('opening a file leaves a layout that hides the editor', () => {
  for (const mode of ['chat', 'chat-bottom', 'review', undefined]) {
    assert.equal(layoutAfterOpeningFile(mode), 'ide');
  }
});
