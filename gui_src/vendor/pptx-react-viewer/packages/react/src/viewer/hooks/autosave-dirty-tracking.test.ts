// @vitest-environment jsdom
/**
 * Autosave is only useful when the whole chain holds together: an edit has to
 * mark the document dirty, the timer has to survive a host that re-creates its
 * callbacks on every render, and a completed save has to mark the document
 * clean again. These render the real hooks to exercise that chain.
 */
import type { PptxSlide } from 'pptx-viewer-core';
import { act, createElement, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutosave } from './useAutosave';
import { useEditorHistory } from './useEditorHistory';

vi.mock('pptx-viewer-shared', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, saveAutosaveSnapshot: vi.fn(async () => true) };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeSlide(id: string, elementCount: number): PptxSlide {
	return {
		id,
		rId: `rId-${id}`,
		slideNumber: 1,
		elements: Array.from({ length: elementCount }, (_, i) => ({
			id: `${id}-el-${i}`,
			type: 'shape',
			x: i,
			y: 0,
			width: 10,
			height: 10,
		})),
	} as unknown as PptxSlide;
}

interface HarnessHandle {
	/** Structural edit: changes the slide's element count. */
	editSlide: () => void;
	/** Property-style edit: what every editing path in the viewer calls. */
	markDirty: () => void;
	isDirty: boolean;
}

let handle: HarnessHandle;

interface HarnessProps {
	onAutosaveContent: (content: Uint8Array) => void | Promise<void>;
	/** Pass an inline callback, re-created on every render, as hosts do. */
	unstableCallback?: boolean;
}

function Harness(props: HarnessProps) {
	const [slides, setSlides] = useState<PptxSlide[]>(() => [makeSlide('s1', 1)]);
	const [isDirty, setIsDirty] = useState(false);
	const [canvasSize, setCanvasSize] = useState({ width: 960, height: 540 });
	const [activeSlideIndex, setActiveSlideIndex] = useState(0);
	const [templateElementsBySlideId, setTemplateElementsBySlideId] = useState<
		Record<string, never>
	>({});

	const history = useEditorHistory({
		slides,
		canvasSize,
		activeSlideIndex,
		templateElementsBySlideId,
		selectedElementId: null,
		selectedElementIds: [],
		editTemplateMode: false,
		headerFooter: {} as never,
		loading: false,
		error: null,
		hasActivePointerInteraction: () => false,
		pointerCommitNonce: 0,
		setSlides,
		setCanvasSize,
		setActiveSlideIndex,
		setTemplateElementsBySlideId,
		setSelectedElementId: () => {},
		setSelectedElementIds: () => {},
		setEditTemplateMode: () => {},
		setHeaderFooter: () => {},
		setIsDirty,
	});

	const serializeSlides = useCallback(
		async () => new Uint8Array([slides[0]?.elements.length ?? 0]),
		[slides],
	);

	const stableAutosaveContent = useCallback(
		(content: Uint8Array) => props.onAutosaveContent(content),
		[props],
	);

	useAutosave({
		isDirty,
		filePath: 'deck.pptx',
		serializeSlides,
		intervalSeconds: 10,
		enabled: true,
		onAutosaveContent: props.unstableCallback
			? (content: Uint8Array) => props.onAutosaveContent(content)
			: stableAutosaveContent,
		readChangeToken: history.getChangeToken,
		markClean: (savedChangeToken) => {
			if (history.getChangeToken() === savedChangeToken) {
				setIsDirty(false);
			}
		},
	});

	handle = {
		isDirty,
		markDirty: history.markDirty,
		editSlide: () => setSlides((prev) => [makeSlide('s1', (prev[0]?.elements.length ?? 0) + 1)]),
	};

	return null;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function render(props: HarnessProps) {
	await act(async () => {
		root.render(createElement(Harness, props));
	});
}

beforeEach(() => {
	// Tells React that `act` brackets the renders below.
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autosave dirty tracking', () => {
	it('marks the document dirty when an edit changes the slides', async () => {
		await render({ onAutosaveContent: () => {} });
		expect(handle.isDirty).toBe(false);

		await act(async () => {
			handle.editSlide();
		});

		expect(handle.isDirty).toBe(true);
	});

	it('marks the document dirty when an editing path calls markDirty', async () => {
		await render({ onAutosaveContent: () => {} });
		expect(handle.isDirty).toBe(false);

		await act(async () => {
			handle.markDirty();
		});

		expect(handle.isDirty).toBe(true);
	});

	it('leaves a freshly loaded deck clean and unsaved', async () => {
		const onAutosaveContent = vi.fn();
		await render({ onAutosaveContent });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});

		expect(handle.isDirty).toBe(false);
		expect(onAutosaveContent).not.toHaveBeenCalled();
	});

	it('autosaves an edited deck once the interval elapses', async () => {
		const onAutosaveContent = vi.fn();
		await render({ onAutosaveContent });

		await act(async () => {
			handle.editSlide();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		expect(onAutosaveContent).toHaveBeenCalledTimes(1);
		expect(onAutosaveContent.mock.calls[0]![0]).toEqual(new Uint8Array([2]));
	});

	it('keeps the timer running when the host re-creates its autosave callback', async () => {
		const onAutosaveContent = vi.fn();
		await render({ onAutosaveContent, unstableCallback: true });

		await act(async () => {
			handle.editSlide();
		});

		// A host re-render every 4 s (shorter than the 10 s interval) must not
		// keep restarting the countdown.
		for (let i = 0; i < 6; i += 1) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(4_000);
			});
			await render({ onAutosaveContent, unstableCallback: true });
		}

		expect(onAutosaveContent).toHaveBeenCalled();
	});

	it('marks the document clean after a successful autosave', async () => {
		const onAutosaveContent = vi.fn();
		await render({ onAutosaveContent });

		await act(async () => {
			handle.editSlide();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		expect(handle.isDirty).toBe(false);

		// A clean document is not written again on every tick.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(onAutosaveContent).toHaveBeenCalledTimes(1);
	});
});
