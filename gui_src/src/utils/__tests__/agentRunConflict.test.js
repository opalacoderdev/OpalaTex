import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readRunConflict,
  RUN_CONFLICT_TURN_ACTIVE,
  RUN_CONFLICT_TURN_STOPPING,
} from '../agentRunConflict.js';

const response = (status, body) => ({
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

test('a 409 from /run reports why the turn was not started', async () => {
  assert.deepEqual(
    await readRunConflict(response(409, { reason: RUN_CONFLICT_TURN_ACTIVE, error: 'Another agent turn is still running.' })),
    { reason: RUN_CONFLICT_TURN_ACTIVE, error: 'Another agent turn is still running.' },
  );
  assert.equal((await readRunConflict(response(409, { reason: RUN_CONFLICT_TURN_STOPPING }))).reason, RUN_CONFLICT_TURN_STOPPING);
});

test('a started stream is not a conflict', async () => {
  assert.equal(await readRunConflict(response(200, {})), null);
  assert.equal(await readRunConflict(null), null);
});

test('a 409 whose body cannot be read is still a conflict', async () => {
  assert.deepEqual(await readRunConflict(response(409, new Error('bad json'))), { reason: '', error: '' });
});
