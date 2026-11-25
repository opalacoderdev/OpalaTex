import { useEffect, useRef, useState } from 'react';
import {
  EXTERNAL_ACCESS_CHANGED_EVENT,
  EXTERNAL_ACCESS_SETTINGS_PATH,
  connectWindowCommandChannel,
  newWindowId,
} from '../utils/windowCommandChannel.js';

/**
 * Keep the window's command stream for external agents open while external
 * agent access is on and a project is open (docs/specs/external_agents.md).
 * With the access off -- the default -- it only reads the setting once and
 * opens nothing.
 *
 * `onCommand` is read through a ref: the stream is opened once per project,
 * and the callback changes on every render.
 */
export default function useWindowCommandChannel({ projectPath, onCommand, onEvent, onError }) {
  const [enabled, setEnabled] = useState(false);
  const callbacks = useRef({});
  callbacks.current = { onCommand, onEvent, onError };
  const windowIdRef = useRef('');
  if (!windowIdRef.current) windowIdRef.current = newWindowId();

  useEffect(() => {
    let cancelled = false;
    fetch(EXTERNAL_ACCESS_SETTINGS_PATH)
      .then((response) => (response.ok ? response.json() : null))
      .then((state) => { if (!cancelled && state) setEnabled(state.enabled === true); })
      .catch(() => {});
    const onChanged = (event) => setEnabled(event?.detail?.enabled === true);
    window.addEventListener(EXTERNAL_ACCESS_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(EXTERNAL_ACCESS_CHANGED_EVENT, onChanged);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !projectPath) return undefined;
    return connectWindowCommandChannel({
      windowId: windowIdRef.current,
      projectPath,
      onCommand: (command) => callbacks.current.onCommand?.(command),
      onEvent: (event) => callbacks.current.onEvent?.(event),
      onError: (err) => callbacks.current.onError?.(err),
    });
  }, [enabled, projectPath]);

  return enabled;
}
