import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGET_SAMPLE_RATE,
  encodeWav,
  isEffectivelySilent,
  mixToMono,
} from '../audioWav.js';

const ascii = (view, offset, length) => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
};

test('the header is a WAV the decoder will accept', () => {
  const buffer = encodeWav(new Float32Array(8), 16000);
  const view = new DataView(buffer);

  assert.equal(ascii(view, 0, 4), 'RIFF');
  assert.equal(ascii(view, 8, 4), 'WAVE');
  assert.equal(ascii(view, 12, 4), 'fmt ');
  assert.equal(ascii(view, 36, 4), 'data');
  assert.equal(view.getUint16(20, true), 1);      // PCM
  assert.equal(view.getUint16(22, true), 1);      // mono
  assert.equal(view.getUint32(24, true), 16000);  // sample rate
  assert.equal(view.getUint16(34, true), 16);     // bits per sample
});

test('the declared sizes match the payload', () => {
  // A header that disagrees with the body is the classic way to produce audio
  // that "loads" and then decodes to garbage.
  const samples = new Float32Array(32);
  const buffer = encodeWav(samples, 16000);
  const view = new DataView(buffer);

  assert.equal(buffer.byteLength, 44 + samples.length * 2);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2);
  // Byte rate and block align are derived, and a decoder trusts them.
  assert.equal(view.getUint32(28, true), 16000 * 2);
  assert.equal(view.getUint16(32, true), 2);
});

test('full-scale samples reach the int16 limits without wrapping', () => {
  // Scaling both signs by 32768 overflows the positive peak, which turns a loud
  // syllable into a burst of noise the transcriber then tries to read.
  const buffer = encodeWav(Float32Array.from([1, -1, 0]), 16000);
  const view = new DataView(buffer);

  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 0);
});

test('out-of-range samples are clamped, not wrapped', () => {
  const buffer = encodeWav(Float32Array.from([4, -4]), 16000);
  const view = new DataView(buffer);

  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test('an empty recording still produces a valid, empty WAV', () => {
  const buffer = encodeWav(new Float32Array(0), 16000);
  const view = new DataView(buffer);

  assert.equal(buffer.byteLength, 44);
  assert.equal(view.getUint32(40, true), 0);
});

test('16 kHz is what the transcriber is trained on', () => {
  assert.equal(TARGET_SAMPLE_RATE, 16000);
  assert.equal(new DataView(encodeWav(new Float32Array(2))).getUint32(24, true), 16000);
});

// ── channel handling ───────────────────────────────────────────────────────

test('stereo is averaged rather than reduced to the first channel', () => {
  // A device that records on one side of a stereo pair would otherwise come
  // through silent.
  const left = Float32Array.from([0, 0, 0]);
  const right = Float32Array.from([1, 0.5, -1]);

  const mono = mixToMono([left, right]);

  assert.deepEqual([...mono], [0.5, 0.25, -0.5]);
});

test('a mono buffer is passed through untouched', () => {
  const only = Float32Array.from([0.1, 0.2]);
  assert.equal(mixToMono([only]), only);
  assert.equal(mixToMono([]).length, 0);
});

// ── silence detection ──────────────────────────────────────────────────────

test('a muted microphone is recognised as silence', () => {
  // Whisper answers silence with confident invented text, so this is what
  // stops a sentence the user never said from landing in the composer.
  assert.equal(isEffectivelySilent(new Float32Array(16000)), true);
  assert.equal(isEffectivelySilent(new Float32Array(0)), true);
});

test('speech-level audio is not mistaken for silence', () => {
  const speech = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 4) * 0.2);

  assert.equal(isEffectivelySilent(speech), false);
});

test('a faint but real signal is kept', () => {
  // The threshold has to sit below quiet speech, or dictating softly reports
  // "nothing was recorded" — which reads as a broken microphone.
  const faint = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 4) * 0.02);

  assert.equal(isEffectivelySilent(faint), false);
});
