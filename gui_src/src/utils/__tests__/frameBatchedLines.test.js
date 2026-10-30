import test from 'node:test';
import assert from 'node:assert/strict';

import { consumeLinesByFrame } from '../frameBatchedLines.js';

const encoder = new TextEncoder();

// A reader over fixed chunks; `fail` makes the read after the last chunk throw.
const readerOf = (chunks, { fail = null } = {}) => {
  let index = 0;
  return {
    read: async () => {
      if (index < chunks.length) return { done: false, value: encoder.encode(chunks[index++]) };
      if (fail) throw fail;
      return { done: true, value: undefined };
    },
  };
};

// A scheduler that runs nothing until the test says a frame has passed.
const manualFrames = () => {
  const queued = [];
  return {
    schedule: (callback) => {
      const entry = { callback, cancelled: false };
      queued.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    frame: () => {
      for (const entry of queued.splice(0)) if (!entry.cancelled) entry.callback();
    },
  };
};

test('every line reaches the callback once, in order, across chunk boundaries', async () => {
  const seen = [];
  await consumeLinesByFrame(readerOf(['{"a":1}\n{"b"', ':2}\n\n{"c":3}\n', '{"d":4}']), line => seen.push(line));
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
});

test('lines read before a frame are handled together in that frame', async () => {
  const frames = manualFrames();
  const batches = [];
  let current = null;
  const reader = readerOf(['1\n', '2\n', '3\n']);
  const originalRead = reader.read;
  let reads = 0;
  reader.read = async () => {
    reads += 1;
    if (reads === 3) {
      // A frame passes after the first two lines were read.
      current = [];
      batches.push(current);
      frames.frame();
      current = null;
    }
    return originalRead();
  };
  const seen = [];
  await consumeLinesByFrame(reader, line => { seen.push(line); if (current) current.push(line); }, { schedule: frames.schedule });
  assert.deepEqual(batches, [['1', '2']]);
  assert.deepEqual(seen, ['1', '2', '3']);
});

test('lines still waiting for a frame are handled before a failed stream throws', async () => {
  const frames = manualFrames();
  const seen = [];
  const failure = new Error('connection lost');
  await assert.rejects(
    consumeLinesByFrame(readerOf(['1\n2\n', 'partial'], { fail: failure }), line => seen.push(line), { schedule: frames.schedule }),
    failure,
  );
  // The unterminated tail of a failed stream is not an event, as before.
  assert.deepEqual(seen, ['1', '2']);
});
