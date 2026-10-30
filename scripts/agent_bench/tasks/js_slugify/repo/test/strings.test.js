import test from 'node:test';
import assert from 'node:assert/strict';

import { capitalize, slugify } from '../src/strings.js';

test('capitalize upper-cases the first letter', () => {
  assert.equal(capitalize('opala'), 'Opala');
});

test('slugify makes a URL-safe slug', () => {
  assert.equal(slugify('Introdução à Atenção!'), 'introducao-a-atencao');
  assert.equal(slugify('  Hello,   World  '), 'hello-world');
});
