import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extraModelParamsToRows,
  parseExtraModelParamRows,
} from '../modelExtraParams.js';

test('additional model parameters preserve JSON value types', () => {
  const result = parseExtraModelParamRows([
    { name: 'penalty_decay', value: '0.2' },
    { name: 'feature_enabled', value: 'true' },
    { name: 'label', value: '"fast"' },
    { name: 'provider_options', value: '{"mode":"strict","stops":[1,2]}' },
  ]);

  assert.deepEqual(result, {
    params: {
      penalty_decay: 0.2,
      feature_enabled: true,
      label: 'fast',
      provider_options: { mode: 'strict', stops: [1, 2] },
    },
  });
  assert.deepEqual(extraModelParamsToRows(result.params), [
    { name: 'penalty_decay', value: '0.2' },
    { name: 'feature_enabled', value: 'true' },
    { name: 'label', value: '"fast"' },
    { name: 'provider_options', value: '{"mode":"strict","stops":[1,2]}' },
  ]);
});

test('reserved, duplicate, malformed, and partial rows are rejected', () => {
  assert.equal(parseExtraModelParamRows([{ name: 'api_key', value: '"secret"' }]).error.code, 'reserved');
  assert.equal(parseExtraModelParamRows([{ name: 'temperature', value: '0.7' }]).error.code, 'reserved');
  assert.equal(parseExtraModelParamRows([{ name: 'max_tokens', value: '1000' }]).error.code, 'reserved');
  assert.equal(parseExtraModelParamRows([
    { name: 'custom_param', value: '0.2' },
    { name: 'custom_param', value: '0.3' },
  ]).error.code, 'duplicate');
  assert.equal(parseExtraModelParamRows([{ name: 'bad-name', value: '1' }]).error.code, 'invalidName');
  assert.equal(parseExtraModelParamRows([{ name: 'custom', value: 'plain text' }]).error.code, 'invalidJson');
  assert.equal(parseExtraModelParamRows([{ name: 'custom', value: '' }]).error.code, 'incomplete');
  assert.deepEqual(parseExtraModelParamRows([{ name: '', value: '' }]), { params: {} });
  assert.equal(parseExtraModelParamRows(
    Array.from({ length: 101 }, (_, index) => ({ name: `param_${index}`, value: '1' })),
  ).error.code, 'tooMany');
});
