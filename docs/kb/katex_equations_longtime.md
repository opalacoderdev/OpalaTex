# KaTeX Equation Rendering Freeze in Rich Text Editor

## Problem

When opening a LaTeX document containing complex equations (e.g., `\begin{equation}` with `\begin{cases}`, `\sum`, `\mathbf`, `\mathbb`, `\left/\right` delimiters) in the Rich Text editor mode (the "T" button), the editor would freeze and block the entire IDE UI. Equations would stay stuck in the "Rendering..." state indefinitely.

The issue was particularly severe with documents containing multiple display equations with nested structures such as:

```latex
\begin{equation}
w^t_{v_i} = \begin{cases}
  \text{ReLU}\left(\sum_{j=1}^{n} \mathbf{1}_{(I^t_j > \xi)} \cdot \kappa_{i,j}\right)
    & \text{if } \left|\sum_{j=1}^{n} I^t_j\right| > 0 \\
  1 & \text{otherwise}
\end{cases}
\label{eq:weight}
\end{equation}
```

## Root Causes

### 1. New Worker per Equation (Primary Cause)

The `renderMathInWorker` function in `RichTextEditor.jsx` created a **new `Worker` instance for every single equation**. Each Worker had to:

1. Parse the worker module JavaScript
2. Import and initialize KaTeX (~260 KB minified)
3. Spin up a new V8 isolate

For a document with 10–20 complex equations, this meant 10–20 simultaneous Worker instantiations, each loading KaTeX from scratch. This saturated the main thread with module compilation and isolate creation overhead.

### 2. All Blocks Rendered at Mount Time

The `RichTextEditor` component rendered **all blocks at once** on mount. Every `MathBlock` and every `AsyncInlineMath` component immediately enqueued a render task. There was no lazy loading or viewport-based deferral, so the math render queue was flooded with dozens of tasks simultaneously.

### 3. Pause/Cancel/Requeue Cycle

The `markMathUiActivity()` function was attached to `onWheel`, `onKeyDownCapture`, and `onMouseDownCapture` on the editor container. Any user interaction (scroll, click, keypress) would:

1. Call `markMathUiActivity()` → set `lastMathUiActivityAt = now`
2. Call `pauseActiveMathRender()` → cancel the active task's worker

Since the worker was terminated on cancel, the next pump cycle had to create a **new** Worker from scratch. This created an infinite loop:

- User interacts → task cancelled → worker destroyed
- Pump reschedules → new worker created → task starts
- User interacts again → task cancelled → worker destroyed
- ...

The equation would never finish rendering.

### 4. O(n²) `sourceLineFromOffset`

The `sourceLineFromOffset(source, offset)` function performed `source.slice(0, offset).split('\n').length` — an O(n) string operation — called **for every block** during render. With N blocks, the total cost was O(n²), adding significant overhead on large documents.

### 5. Unthrottled Scroll Handler

The `handleScroll` callback called `querySelectorAll('[data-source-line]')` and read `offsetTop`/`offsetHeight` (forcing layout reflow) on **every scroll event** without throttling.

## Solution

### 1. Persistent Worker Pool

Replaced the per-equation Worker creation with a **pool of 2 persistent Workers** (`MATH_WORKER_POOL_SIZE = 2`). Workers are created once and reused via `postMessage` with unique request IDs. A `pendingMathRequests` map tracks which response belongs to which call.

**File:** `gui_src/src/components/RichTextEditor.jsx` — `getMathWorker()`, `renderMathInWorker()`

### 2. LazyBlock with IntersectionObserver

Created a `LazyBlock` wrapper component that uses `IntersectionObserver` to only mount the `BlockRenderer` (which triggers math rendering) when a block is **visible or near-visible** (`rootMargin: '800px 0px 800px 0px'`). Off-screen blocks render a lightweight placeholder `<div>` with `minHeight: 24px`.

Once a block becomes visible, it stays mounted to preserve editing state (cursor position, edited text).

**File:** `gui_src/src/components/RichTextEditor.jsx` — `LazyBlock` component

### 3. Removed Aggressive Activity Marking

Removed the `markMathUiActivity()` handlers from `onWheel`, `onKeyDownCapture`, and `onMouseDownCapture` on the editor container. These handlers fired on every user interaction and paused/cancelled the active render task, creating the infinite pause/requeue cycle.

The `markMathUiActivity()` call remains only inside the throttled `handleScroll`, which is sufficient to pause rendering during active scrolling without creating a tight loop.

**File:** `gui_src/src/components/RichTextEditor.jsx` — container `<div>` props

### 4. KaTeX `output: 'mathml'` with Font Wrapper

Switched KaTeX from `output: 'html'` to `output: 'mathml'`. The HTML output mode generates **thousands of nested `<span>` elements** with absolute CSS positioning for complex equations. When inserted via `dangerouslySetInnerHTML`, the browser must parse and lay out all these nodes synchronously, blocking the main thread.

MathML is rendered **natively** by the Chromium engine (used in VS Code's Electron webview), producing dramatically fewer DOM nodes. The browser handles MathML layout in native C++ code, not JavaScript.

**Critical detail:** KaTeX's `output: 'mathml'` mode skips the `displayWrap` step, so the result is NOT wrapped in `<span class="katex">` / `<span class="katex-display">`. Without these classes, the `katex.min.css` font rules (which apply `KaTeX_Main`, `KaTeX_Math`, `KaTeX_AMS`, etc.) are never applied, and the browser falls back to system fonts that lack math glyphs — producing broken rendering (missing symbols, random strokes).

**Fix:** The worker wraps the MathML output manually:

```javascript
const wrapperClass = displayMode
  ? '<span class="katex-display"><span class="katex">'
  : '<span class="katex">';
const wrapperClose = displayMode ? '</span></span>' : '</span>';
const html = wrapperClass + mathml + wrapperClose;
```

This ensures the `katex.min.css` font rules apply correctly to the MathML elements.

**File:** `gui_src/src/workers/katexRenderWorker.js`

### 5. Precomputed Line Offsets (O(log n) Binary Search)

Replaced the O(n) `sourceLineFromOffset` with a precomputed array of line-start offsets, built once per source change via `useMemo`. The function now uses **binary search** to find the line number, reducing per-call cost from O(n) to O(log n) and total render cost from O(n²) to O(n log n).

A module-level `currentLineOffsets` variable is set via `useEffect` so the standalone function can access it without prop drilling.

**File:** `gui_src/src/components/RichTextEditor.jsx` — `lineOffsets` memo, `sourceLineFromOffset()`

### 6. Throttled Scroll Handler with rAF

The `handleScroll` callback now uses `requestAnimationFrame` to batch scroll events. If a frame is already scheduled, subsequent scroll events are ignored until the frame executes. This prevents layout-thrashing `querySelectorAll` + `offsetTop` reads on every scroll event.

**File:** `gui_src/src/components/RichTextEditor.jsx` — `handleScroll()`

### 7. Fixed Pause/Requeue Logic in Pump

When a task was paused (by `markMathUiActivity`) and the worker promise resolved, the `.then()` handler previously returned without finalizing or re-enqueuing the task — the task was lost forever, stuck in "loading". Now, paused tasks that receive a result are re-enqueued for re-execution when the UI becomes idle.

**File:** `gui_src/src/components/RichTextEditor.jsx` — `pumpMathRenderQueue()`

### 8. Cache Versioning

Added a `MATH_CACHE_VERSION` prefix to all math cache keys. This ensures stale cached results from a previous output format (e.g., HTML) are not reused after switching to MathML.

**File:** `gui_src/src/components/RichTextEditor.jsx` — `MATH_CACHE_VERSION`, cache key construction

## Files Modified

| File | Change |
|------|--------|
| `gui_src/src/components/RichTextEditor.jsx` | Worker pool, LazyBlock, throttled scroll, precomputed offsets, pause/requeue fix, cache versioning |
| `gui_src/src/workers/katexRenderWorker.js` | Switched to `output: 'mathml'` with font wrapper |

## Key Lessons

1. **Never create Workers per-task** — Worker instantiation (module parse + isolate creation) is expensive. Use a persistent pool.
2. **IntersectionObserver for virtualization** — Only render heavy content (math, graphics) when it's actually visible.
3. **MathML > HTML for complex math** — KaTeX's HTML output creates thousands of CSS-positioned spans; MathML is rendered natively by Chromium with orders of magnitude fewer DOM nodes.
4. **Font wrapper is required for `output: 'mathml'`** — KaTeX skips `displayWrap` in mathml-only mode, so the `katex.min.css` font rules never apply unless you wrap manually.
5. **Avoid aggressive pause/cancel cycles** — Pausing and cancelling tasks on every user interaction creates an infinite loop if cancellation is expensive (e.g., worker termination + re-creation).