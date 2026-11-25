import test from 'node:test';
import assert from 'node:assert/strict';

import { groupAgentTurns } from '../gitReviewGrouping.js';

const commit = (hash, message) => ({ hash, message });

test('a turn carries the label of its checkpoints; the built-in agent has none', () => {
  const items = groupAgentTurns([
    commit('e2', 'Agent turn end checkpoint: Claude Code'),
    commit('e1', 'Agent turn end checkpoint'),
    commit('s1', 'Agent turn start checkpoint'),
    commit('s2', 'Agent turn start checkpoint: Claude Code'),
    commit('u1', 'My own commit'),
  ]);
  assert.deepEqual(items.map((item) => [item.type, item.label, item.start?.hash, item.end?.hash]), [
    ['agent_turn', 'Claude Code', 's2', 'e2'],
    ['agent_turn', '', 's1', 'e1'],
    ['commit', undefined, undefined, undefined],
  ]);
});

test('an external turn still open (no end yet) is not shown', () => {
  const items = groupAgentTurns([commit('s2', 'Agent turn start checkpoint: Claude Code'), commit('u1', 'Mine')]);
  assert.deepEqual(items.map((item) => item.commit?.hash), ['u1']);
});
