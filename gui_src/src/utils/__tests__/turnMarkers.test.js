import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERRUPTED_MARKER,
  TURN_CUT_SHORT_MARKER,
  TURN_FAILED_MARKER,
  TURN_NO_ANSWER_MARKER,
  interruptedTurnContent,
  turnEndFromContent,
} from '../turnMarkers.js';

test('an interruption that caught the agent mid-sentence is still an interruption', () => {
  // The defect this file exists for: the backend stores the partial answer
  // above the marker, and matching the marker by equality recognised only a
  // turn that had produced nothing — so stopping a talking agent left the raw
  // marker in the bubble and no continue button anywhere.
  const stored = `Let me verify the on-disk state first:\n\n${INTERRUPTED_MARKER}`;
  const end = turnEndFromContent(stored);

  assert.equal(end.interrupted, true);
  assert.equal(end.interruptedByMarker, true);
  assert.equal(end.text, 'Let me verify the on-disk state first:');
});

test('a turn interrupted before it said anything still offers the continue action', () => {
  const end = turnEndFromContent(INTERRUPTED_MARKER);

  assert.equal(end.interrupted, true);
  assert.equal(end.interruptedByMarker, true);
  assert.equal(end.text, '');
});

test('the marker never reaches the reader', () => {
  for (const marker of [INTERRUPTED_MARKER, TURN_CUT_SHORT_MARKER, TURN_FAILED_MARKER, TURN_NO_ANSWER_MARKER]) {
    const { text } = turnEndFromContent(`work in progress\n\n${marker}`);
    assert.equal(text.includes(marker), false);
    assert.equal(text, 'work in progress');
  }
});

test('the cut-short and failed turns keep their own flags', () => {
  const cutShort = turnEndFromContent(`half an answer\n\n${TURN_CUT_SHORT_MARKER}`);
  assert.deepEqual(
    [cutShort.cutShort, cutShort.failed, cutShort.interrupted],
    [true, false, false],
  );

  const failed = turnEndFromContent(`half an answer\n\n${TURN_FAILED_MARKER}`);
  assert.deepEqual(
    [failed.cutShort, failed.failed, failed.interrupted],
    [false, true, false],
  );
});

test('a turn that stopped with steps left is not reported as cut short', () => {
  // Its notice must not send the user after a larger budget, so it cannot share
  // the cut-short flag even though both offer the same continue action.
  const end = turnEndFromContent(`Reading the file.\n\n${TURN_NO_ANSWER_MARKER}`);
  assert.deepEqual(
    [end.noAnswer, end.cutShort, end.failed, end.interrupted],
    [true, false, false, false],
  );
  assert.equal(end.text, 'Reading the file.');
});

test('turns recorded before the marker existed are still recognised', () => {
  const legacy = turnEndFromContent('Interrompido: o usuário parou o agente.');

  assert.equal(legacy.interrupted, true);
  assert.equal(legacy.legacyInterruption, true);
  // Nothing to strip: the prose is the notice, and the caller replaces it.
  assert.equal(legacy.interruptedByMarker, false);
});

test('a reasoning block does not hide a legacy interruption', () => {
  const raw = '<think>weighing options</think>Interrupted: stopped by the user.';
  const probe = 'Interrupted: stopped by the user.';

  assert.equal(turnEndFromContent(raw, probe).interrupted, true);
});

test('an ordinary answer is left exactly as written', () => {
  const answer = 'Here is the table you asked for.\n\n    indented code\n';
  const end = turnEndFromContent(answer);

  assert.deepEqual(
    [end.interrupted, end.cutShort, end.failed],
    [false, false, false],
  );
  assert.equal(end.text, answer.trimEnd());
});

test('the live bubble is written in the shape the backend persists', () => {
  assert.equal(
    interruptedTurnContent('Let me verify the on-disk state first:'),
    `Let me verify the on-disk state first:\n\n${INTERRUPTED_MARKER}`,
  );
  assert.equal(interruptedTurnContent(''), INTERRUPTED_MARKER);
  assert.equal(interruptedTurnContent('   '), INTERRUPTED_MARKER);

  // Round trip: what the live path writes is what the reader parses back.
  const end = turnEndFromContent(interruptedTurnContent('partial'));
  assert.equal(end.interruptedByMarker, true);
  assert.equal(end.text, 'partial');
});

test('empty and missing content are not turn endings', () => {
  for (const value of [undefined, null, '']) {
    const end = turnEndFromContent(value);
    assert.equal(end.interrupted, false);
    assert.equal(end.text, '');
  }
});
