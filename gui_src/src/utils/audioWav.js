/**
 * Turning a browser recording into the WAV the transcriber expects.
 *
 * `MediaRecorder` produces WebM/Opus, and Whisper wants 16 kHz mono PCM. The
 * conversion happens here rather than on the server because decoding Opus in
 * Python would mean depending on ffmpeg, which the host may not have — while
 * the browser already ships `decodeAudioData` and `OfflineAudioContext` and
 * resamples without help. Verified available in the app's QtWebEngine shell.
 *
 * The encoder is a pure function over a Float32Array so it can be tested
 * without a DOM; only `blobToWav16k` needs real browser audio APIs.
 */

// What Whisper was trained on. Sending anything else means the engine resamples
// internally, which is the same work done less predictably.
export const TARGET_SAMPLE_RATE = 16000;

const clampSample = (value) => (value < -1 ? -1 : value > 1 ? 1 : value);

/**
 * Encode mono float samples in [-1, 1] as a 16-bit PCM WAV.
 *
 * Returns an ArrayBuffer. Samples outside the range are clamped rather than
 * wrapped: wrapping turns a loud syllable into a burst of noise, which the
 * transcriber then tries to interpret as speech.
 */
export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const count = samples?.length ?? 0;
  const dataBytes = count * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header size
  view.setUint16(20, 1, true);           // format: PCM
  view.setUint16(22, 1, true);           // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < count; i += 1) {
    const sample = clampSample(samples[i] ?? 0);
    // Asymmetric on purpose: int16 holds -32768..32767, and scaling both signs
    // by 32768 would clip the positive peak.
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

/**
 * Average an AudioBuffer's channels into one Float32Array.
 *
 * Downmixing rather than taking channel 0: a device that records one side of a
 * stereo pair would otherwise come through silent.
 */
export function mixToMono(channels) {
  if (!channels?.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];

  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels.length; c += 1) sum += channels[c][i] ?? 0;
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * Whether a recording carries any signal at all.
 *
 * A muted microphone yields a perfectly valid, perfectly silent WAV, and
 * Whisper answers silence with confident hallucinated text — so the caller
 * checks here and says "nothing was recorded" instead of pasting an invented
 * sentence into the composer.
 */
export function isEffectivelySilent(samples, threshold = 0.0025) {
  const count = samples?.length ?? 0;
  if (!count) return true;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / count) < threshold;
}

/**
 * Decode a recorded Blob and re-encode it as a 16 kHz mono WAV.
 *
 * Returns `{ wav, samples, sampleRate }`. Needs real browser audio APIs.
 */
export async function blobToWav16k(blob) {
  const bytes = await blob.arrayBuffer();

  const Context = window.AudioContext || window.webkitAudioContext;
  const decoder = new Context();
  let decoded;
  try {
    decoded = await decoder.decodeAudioData(bytes);
  } finally {
    // Each context holds a hardware handle; leaking one per recording
    // eventually exhausts them.
    decoder.close?.();
  }

  const frames = Math.max(
    1,
    Math.ceil((decoded.duration || 0) * TARGET_SAMPLE_RATE),
  );
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const resampled = await offline.startRendering();

  const samples = resampled.getChannelData(0);
  return { wav: encodeWav(samples, TARGET_SAMPLE_RATE), samples, sampleRate: TARGET_SAMPLE_RATE };
}
