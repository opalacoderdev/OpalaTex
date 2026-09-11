import test from 'node:test';
import assert from 'node:assert/strict';

import {
  askQuestionOptions,
  formatAskResponse,
  normalizeInputRequest,
} from '../askQuestion.js';

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
