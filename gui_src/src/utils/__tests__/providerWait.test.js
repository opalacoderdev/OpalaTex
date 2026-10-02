import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatWaitDuration,
  providerWaitFromEvent,
  providerWaitSeconds,
} from '../providerWait.js';

test('a wait is dated from when the silence began, not from when the event arrived', () => {
  // The backend reports the silence once, after the threshold; the notice must
  // already read 60 s at that moment, not start counting from zero.
  const wait = providerWaitFromEvent(
    { waiting: true, phase: 'first_response', elapsed_seconds: 60, agent: 'chat_orchestrator' },
    100_000,
  );
  assert.equal(wait.since, 40_000);
  assert.equal(providerWaitSeconds(wait, 100_000), 60);
  assert.equal(providerWaitSeconds(wait, 105_400), 65);
  assert.equal(wait.agent, 'chat_orchestrator');
});

test('the end of a wait clears the notice', () => {
  assert.equal(providerWaitFromEvent({ waiting: false, elapsed_seconds: 612 }), null);
  assert.equal(providerWaitFromEvent(null), null);
});

test('a stalled stream keeps its phase; anything else is a first response', () => {
  assert.equal(providerWaitFromEvent({ waiting: true, phase: 'stream', elapsed_seconds: 61 }, 0).phase, 'stream');
  assert.equal(providerWaitFromEvent({ waiting: true, phase: 'odd', elapsed_seconds: 61 }, 0).phase, 'first_response');
});

test('a malformed elapsed time does not produce a negative or NaN counter', () => {
  const wait = providerWaitFromEvent({ waiting: true, elapsed_seconds: 'x' }, 1_000);
  assert.equal(wait.since, 1_000);
  assert.equal(providerWaitSeconds(wait, 500), 0);
  assert.equal(providerWaitSeconds(null), 0);
});

test('durations read as seconds, then minutes and zero-padded seconds', () => {
  assert.equal(formatWaitDuration(0), '0 s');
  assert.equal(formatWaitDuration(59.9), '59 s');
  assert.equal(formatWaitDuration(65), '1 min 05 s');
  assert.equal(formatWaitDuration(600), '10 min 00 s');
  assert.equal(formatWaitDuration(-3), '0 s');
});
