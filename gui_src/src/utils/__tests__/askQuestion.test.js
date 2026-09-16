import test from 'node:test';
import assert from 'node:assert/strict';

import {
  askQuestionOptions,
  clearAnsweredRequest,
  confirmRequestDialog,
  dialogRequestKey,
  formatAskResponse,
  normalizeInputRequest,
} from '../askQuestion.js';

test('each local prompt gets its own dialog key so typed text cannot leak between prompts', () => {
  const newFile = { type: 'ask', prompt: 'New file name:', default: 'src/', callback: () => {} };
  const newDir = { type: 'ask', prompt: 'New directory name:', default: 'src/', callback: () => {} };
  assert.equal(dialogRequestKey(newFile), dialogRequestKey(newFile));
  assert.notEqual(dialogRequestKey(newFile), dialogRequestKey(newDir));
  assert.equal(dialogRequestKey({ id: 'abc', type: 'ask' }), 'id:abc');
  assert.equal(dialogRequestKey(null), null);
});

test('local ask prompts render as an input dialog, not a Yes/No confirmation', () => {
  const newDirRequest = { type: 'ask', rows: 1, prompt: 'New directory name:', default: 'src/', callback: () => {} };
  assert.equal(confirmRequestDialog(newDirRequest), 'ask');
});

test('an accepted answer closes its own window but not the next question that already replaced it', () => {
  const first = { id: 'q1', type: 'ask', prompt: 'Include an answer key?' };
  const second = { id: 'q2', type: 'ask', prompt: 'Which algorithms?' };
  assert.equal(clearAnsweredRequest('q1')(first), null);
  assert.equal(clearAnsweredRequest('q1')(second), second);
  assert.equal(clearAnsweredRequest('q1')(null), null);
});

test('confirm request routing covers terminal, confirmation and empty requests', () => {
  assert.equal(confirmRequestDialog({ type: 'interactive_terminal' }), 'interactive_terminal');
  assert.equal(confirmRequestDialog({ prompt: 'Delete?', options: ['yes', 'no'] }), 'confirm');
  assert.equal(confirmRequestDialog(normalizeInputRequest({ id: 'c', prompt: 'Run?' })), 'confirm');
  assert.equal(confirmRequestDialog(null), null);
});

test('ask requests do not inherit confirmation defaults', () => {
  assert.deepEqual(
    normalizeInputRequest({ id: 'ask-1', prompt: 'What should change?', type: 'ask' }),
    { id: 'ask-1', prompt: 'What should change?', type: 'ask' }
  );
});

test('confirmation requests retain their yes/no defaults', () => {
  assert.deepEqual(
    normalizeInputRequest({ id: 'confirm-1', prompt: 'Continue?' }),
    {
      id: 'confirm-1',
      prompt: 'Continue?',
      type: 'confirm',
      options: ['yes', 'no'],
      default: 'yes',
    }
  );
});

test('multi-select metadata and explicit ask values survive normalization', () => {
  const request = {
    id: 'ask-2',
    prompt: 'Choose fields',
    type: 'ask',
    options: ['Date', 'Author'],
    default: '',
    is_multi_select: true,
  };
  assert.deepEqual(normalizeInputRequest(request), request);
});

test('automatic Other removes model-provided duplicates', () => {
  assert.deepEqual(
    askQuestionOptions(['Summary', 'Other (please specify)', 'Outro']),
    ['Summary']
  );
  assert.equal(askQuestionOptions(['Other']), null);
});

test('single-select responses return one option or the custom text', () => {
  const options = ['PDF', 'DOCX'];
  assert.equal(formatAskResponse({ options, selectedIndexes: new Set([1]) }), 'DOCX');
  assert.equal(formatAskResponse({ options, isOtherSelected: true, inputValue: 'Markdown' }), 'Markdown');
});

test('multi-select responses are ordered JSON arrays with optional custom text', () => {
  assert.equal(
    formatAskResponse({
      options: ['Title', 'Date', 'Author'],
      selectedIndexes: new Set([2, 0]),
      isMultiSelect: true,
      isOtherSelected: true,
      inputValue: '  Abstract  ',
    }),
    JSON.stringify(['Title', 'Author', 'Abstract'])
  );
});
