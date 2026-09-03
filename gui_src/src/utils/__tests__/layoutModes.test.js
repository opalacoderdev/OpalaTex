import test from 'node:test';
import assert from 'node:assert/strict';

import { EDITOR_LAYOUTS, layoutAfterOpeningFile, layoutShowsEditor } from '../layoutModes.js';

test('the layouts that show the editor are the ones that dock a sidebar', () => {
  assert.deepEqual(EDITOR_LAYOUTS, ['ide', 'studio', 'document', 'plan']);
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

test('opening a file keeps the plan layout, which exists to allow exactly that', () => {
  // The plan panel replaced a modal that blocked the workbench: checking a
  // proposed plan against the files it names is the reason the layout exists,
  // so an explorer click must not close the plan being reviewed.
  assert.equal(layoutShowsEditor('plan'), true);
  assert.equal(layoutAfterOpeningFile('plan'), 'plan');
});

test('opening a file leaves a layout that hides the editor', () => {
  for (const mode of ['chat', 'chat-bottom', 'review', undefined]) {
    assert.equal(layoutAfterOpeningFile(mode), 'ide');
  }
});
