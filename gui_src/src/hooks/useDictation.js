import { useCallback, useEffect, useRef, useState } from 'react';
import { UNAVAILABLE, availabilityFromSettings } from '../utils/featureAvailability.js';
import { blobToWav16k, isEffectivelySilent } from '../utils/audioWav.js';

/**
 * Recording the microphone and turning it into text for the chat composer.
 *
 * Record, stop, insert: the transcript lands in the composer for the user to
 * read and send, and never starts a turn on its own. Transcription makes
 * mistakes, and sending an unreviewed one to the agent would be the same
 * mistake "Ask about" avoids by staging rather than asking.
 *
 * The microphone genuinely works in the desktop shell — unlike the browser's
 * speech synthesis (§2.13.1). Measured: served from http://127.0.0.1 the page
 * is a secure context, so `mediaDevices` and `MediaRecorder` are present, and
 * the Qt backend already grants MediaAudioCapture.
 *
 * `state` is 'idle' | 'recording' | 'transcribing' | 'error'.
 */

// The one container QtWebEngine's MediaRecorder offers that Chromium also
// decodes back. Left to choose for itself it may pick something decodeAudioData
// then refuses.
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

const pickMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of PREFERRED_TYPES) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
};

export function useDictation({ onText, language, settingsSignal = 0 } = {}) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  // `offered` is what the user ticked in Settings; `ready` is whether it can
  // actually run. The button is shown whenever it is *offered* and disabled
  // with its reason when it is not ready: hiding it made an incomplete setup
  // indistinguishable from a broken build.
  const [availability, setAvailability] = useState({ ...UNAVAILABLE });

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const cancelledRef = useRef(false);

  const stopTracks = useCallback(() => {
    // The microphone indicator stays lit until every track is stopped, which
    // looks like the app is still listening.
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => {
    cancelledRef.current = true;
    try { recorderRef.current?.stop?.(); } catch { /* already stopped */ }
    stopTracks();
  }, [stopTracks]);

  const refreshAvailability = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/transcription');
      if (!res.ok) throw new Error('unavailable');
      const next = availabilityFromSettings(await res.json());
      setAvailability(next);
      return next;
    } catch {
      const next = { ...UNAVAILABLE };
      setAvailability(next);
      return next;
    }
  }, []);

  // Re-read on mount *and* whenever the settings change. Reading it only on
  // mount was the defect: the microphone button's own presence is what this
  // gates, so unlike the context menus there is no "on open" moment to refresh
  // at, and ticking the box in Settings did nothing until the panel remounted.
  useEffect(() => { refreshAvailability(); }, [refreshAvailability, settingsSignal]);

  const transcribe = useCallback(async (blob) => {
    setState('transcribing');
    try {
      const { wav, samples } = await blobToWav16k(blob);

      // Whisper answers silence with confident invented text, so a muted
      // microphone must be reported as such rather than pasted into the
      // composer as a sentence the user never said.
      if (isEffectivelySilent(samples)) {
        setState('error');
        setError('silent');
        return;
      }

      const res = await fetch(`/api/transcribe${language ? `?lang=${encodeURIComponent(language)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const failure = new Error(data.error || res.statusText || 'request failed');
        failure.kind = data.kind || '';
        throw failure;
      }

      const text = String(data.text || '').trim();
      if (!text) {
        setState('error');
        setError('silent');
        return;
      }
      onText?.(text);
      setState('idle');
      setError('');
    } catch (err) {
      setState('error');
      setError(err.message || String(err));
    }
  }, [onText, language]);

  const start = useCallback(async () => {
    setError('');
    cancelledRef.current = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setError('unsupported');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setState('error');
      // A refused permission is not a failure to report as a bug: it is a
      // choice the user made and can change.
      setError(err?.name === 'NotAllowedError' ? 'denied' : (err?.message || 'denied'));
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    const mimeType = pickMimeType();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      stopTracks();
      setState('error');
      setError(err.message || 'unsupported');
      return;
    }

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      stopTracks();
      const chunks = chunksRef.current;
      chunksRef.current = [];
      if (cancelledRef.current) {
        setState('idle');
        return;
      }
      if (!chunks.length) {
        setState('error');
        setError('silent');
        return;
      }
      transcribe(new Blob(chunks, { type: mimeType || 'audio/webm' }));
    };

    recorderRef.current = recorder;
    recorder.start();
    setState('recording');
  }, [stopTracks, transcribe]);

  const stop = useCallback(() => {
    cancelledRef.current = false;
    try { recorderRef.current?.stop?.(); } catch { setState('idle'); }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    try { recorderRef.current?.stop?.(); } catch { /* already stopped */ }
    stopTracks();
    setState('idle');
    setError('');
  }, [stopTracks]);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state !== 'transcribing') start();
  }, [state, start, stop]);

  const dismissError = useCallback(() => {
    setState('idle');
    setError('');
  }, []);

  return {
    state, error, availability, refreshAvailability,
    start, stop, cancel, toggle, dismissError,
  };
}

export default useDictation;
