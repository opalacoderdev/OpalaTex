import { saveAutosaveSnapshot } from 'pptx-viewer-shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
	computeAutosaveIntervalMs,
	DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
} from './useAutosave-helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutosaveStatus =
	| { state: 'idle' }
	| { state: 'disabled'; reason: string }
	| { state: 'saving' }
	| { state: 'saved'; timestamp: number }
	| { state: 'error'; message: string };

export interface UseAutosaveInput {
	/** Whether the document has unsaved changes. */
	isDirty: boolean;
	/** File path or name of the currently-open PPTX. Required for autosave to work. */
	filePath: string | undefined;
	/** Serialise current editor state to a Uint8Array. */
	serializeSlides: () => Promise<Uint8Array | null>;
	/** Autosave interval in seconds (default 120). */
	intervalSeconds?: number;
	/** Whether autosave is enabled. */
	enabled?: boolean;
	/** Optional host callback for persisting serialized autosave bytes. */
	onAutosaveContent?: (content: Uint8Array) => void | Promise<void>;
	/**
	 * Reads the owner's monotonic change counter. Captured before
	 * serialisation so `markClean` can tell whether an edit landed while the
	 * save was in flight.
	 */
	readChangeToken?: () => number;
	/**
	 * Invoked after the content was persisted, with the change token captured
	 * before serialisation. Owners clear their dirty flag from here; without
	 * it the document stays dirty and is written again on every tick.
	 */
	markClean?: (savedChangeToken: number | undefined) => void;
}

export interface UseAutosaveResult {
	/** Current autosave status for display in the StatusBar. */
	autosaveStatus: AutosaveStatus;
	/** Manually trigger an autosave right now. */
	triggerAutosave: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook (the IndexedDB store itself lives in pptx-viewer-shared)
// ---------------------------------------------------------------------------

export function useAutosave(input: UseAutosaveInput): UseAutosaveResult {
	const {
		isDirty,
		filePath,
		serializeSlides,
		intervalSeconds = DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
		enabled = true,
		onAutosaveContent,
		readChangeToken,
		markClean,
	} = input;

	const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>({
		state: 'idle',
	});

	// Refs to avoid stale closures in the interval callback.
	const isDirtyRef = useRef(isDirty);
	const filePathRef = useRef(filePath);
	const serializeRef = useRef(serializeSlides);
	const isSavingRef = useRef(false);
	// Host callbacks live in refs too: a host that re-creates them on every
	// render (an inline prop is the norm) must not restart the countdown.
	const onAutosaveContentRef = useRef(onAutosaveContent);
	const readChangeTokenRef = useRef(readChangeToken);
	const markCleanRef = useRef(markClean);

	useEffect(() => {
		isDirtyRef.current = isDirty;
	}, [isDirty]);
	useEffect(() => {
		filePathRef.current = filePath;
	}, [filePath]);
	useEffect(() => {
		serializeRef.current = serializeSlides;
	}, [serializeSlides]);
	useEffect(() => {
		onAutosaveContentRef.current = onAutosaveContent;
	}, [onAutosaveContent]);
	useEffect(() => {
		readChangeTokenRef.current = readChangeToken;
	}, [readChangeToken]);
	useEffect(() => {
		markCleanRef.current = markClean;
	}, [markClean]);

	// ── Core save logic ─────────────────────────────────────────────
	const doAutosave = useCallback(async () => {
		if (!filePathRef.current) {
			return;
		}
		if (!isDirtyRef.current) {
			return;
		}
		if (isSavingRef.current) {
			return;
		}

		isSavingRef.current = true;
		setAutosaveStatus({ state: 'saving' });

		try {
			const changeToken = readChangeTokenRef.current?.();
			const data = await serializeRef.current();
			if (!data) {
				setAutosaveStatus({ state: 'idle' });
				isSavingRef.current = false;
				return;
			}

			const persistContent = onAutosaveContentRef.current;
			// The IndexedDB snapshot is a crash-recovery cache. When the host
			// persists the bytes itself, a cache write that fails (quota, a
			// runtime with IndexedDB disabled) must not take the real save down
			// with it; with no host callback it *is* the save, so there its
			// failure is the autosave's failure.
			try {
				await saveAutosaveSnapshot(filePathRef.current, data);
			} catch (err) {
				if (!persistContent) {
					throw err;
				}
				console.warn('[pptx-viewer] autosave recovery snapshot failed:', err);
			}
			if (persistContent) {
				await persistContent(data);
			}
			markCleanRef.current?.(changeToken);
			setAutosaveStatus({ state: 'saved', timestamp: Date.now() });
		} catch (err) {
			setAutosaveStatus({
				state: 'error',
				message: err instanceof Error ? err.message : 'Autosave failed',
			});
		} finally {
			isSavingRef.current = false;
		}
	}, []);

	// ── Interval timer ──────────────────────────────────────────────
	useEffect(() => {
		if (!enabled) {
			setAutosaveStatus({ state: 'disabled', reason: 'autosave_toggle_off' });
			return;
		}
		if (!filePath) {
			setAutosaveStatus({
				state: 'disabled',
				reason: 'no_file_path',
			});
			return;
		}

		// Requirements met; reset to idle if currently disabled.
		setAutosaveStatus((prev) => (prev.state === 'disabled' ? { state: 'idle' } : prev));

		const ms = computeAutosaveIntervalMs(intervalSeconds);
		const id = setInterval(() => {
			void doAutosave();
		}, ms);

		return () => clearInterval(id);
	}, [enabled, filePath, intervalSeconds, doAutosave]);

	return {
		autosaveStatus,
		triggerAutosave: doAutosave,
	};
}
