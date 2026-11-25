import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalQueue, describeArguments } from '../externalApprovals.js';

// Timers the test fires by hand.
function manualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    fire: (id) => { const timer = timers.get(id); timers.delete(id); timer?.fn(); },
    pending: () => [...timers.keys()],
  };
}

test('requests are shown one at a time, in order, and answered by the user', async () => {
  const shown = [];
  const timers = manualTimers();
  const queue = createApprovalQueue((request) => shown.push(request?.prompt ?? null), timers);

  const first = queue.ask({ prompt: 'compile A' }, 1000);
  const second = queue.ask({ prompt: 'compile B' }, 1000);
  assert.deepEqual(shown, ['compile A']);
  assert.equal(queue.size, 2);

  queue.answer('yes');
  assert.equal(await first, 'yes');
  assert.deepEqual(shown, ['compile A', 'compile B']);

  queue.answer('always');
  assert.equal(await second, 'always');
  assert.deepEqual(shown, ['compile A', 'compile B', null]);
  assert.deepEqual(timers.pending(), []);
});

test('an unanswered request closes itself as a refusal; an unknown answer is a refusal', async () => {
  const shown = [];
  const timers = manualTimers();
  const queue = createApprovalQueue((request) => shown.push(request?.prompt ?? null), timers);

  const waiting = queue.ask({ prompt: 'compile' }, 300000);
  const [timer] = timers.pending();
  timers.fire(timer);
  assert.equal(await waiting, 'no');
  assert.deepEqual(shown, ['compile', null]);

  const odd = queue.ask({ prompt: 'again' }, 1000);
  queue.answer('cancel');
  assert.equal(await odd, 'no');
  queue.answer('yes'); // nothing on screen: ignored
  assert.equal(queue.size, 0);
});

test('a request that times out behind the one on screen leaves the screen alone', async () => {
  const shown = [];
  const timers = manualTimers();
  const queue = createApprovalQueue((request) => shown.push(request?.prompt ?? null), timers);
  const first = queue.ask({ prompt: 'A' }, 1000);
  const second = queue.ask({ prompt: 'B' }, 1000);
  const [, secondTimer] = timers.pending();
  timers.fire(secondTimer);
  assert.equal(await second, 'no');
  assert.deepEqual(shown, ['A']);
  queue.answer('no');
  assert.equal(await first, 'no');
  assert.deepEqual(shown, ['A', null]);
});

test('arguments are shown one per line', () => {
  assert.equal(describeArguments({ path: 'ch/1.tex', draft: true }), 'path: "ch/1.tex"\ndraft: true');
  assert.equal(describeArguments({}), '');
  assert.equal(describeArguments(undefined), '');
});
