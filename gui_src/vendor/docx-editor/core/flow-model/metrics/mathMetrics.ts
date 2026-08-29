/**
 * Equation box measurement.
 *
 * The layout engine needs an equation's width, height, and baseline before the
 * painter runs, and the only thing that knows how tall a piece of MathML is,
 * is the browser laying it out. So an equation is measured once in a hidden
 * host and the result is memoized: the same MathML at the same font size costs
 * one layout for the whole document, however many times it appears.
 *
 * Off-DOM (unit tests, a worker) the measurement falls back to an estimate
 * derived from the plain-text form. It is wrong by design, but it is finite,
 * deterministic, and keeps pagination from dividing by zero.
 */

import { sanitizeMathml } from '../../utils/sanitizeMathml';

/** Px box of a rendered equation, relative to the text baseline. */
export interface MathBox {
  width: number;
  height: number;
  /** Px from the box top down to the baseline. */
  ascent: number;
  /** Px from the baseline down to the box bottom. */
  descent: number;
}

/**
 * The face that gives MathML its stretchy braces and correct metrics. It is
 * loaded by the host application with `font-display: swap`, so a document
 * opened before it arrives would otherwise be measured against a fallback.
 */
const MATH_FONT_PROBE = '16px "STIX Two Math"';

const MEASURE_CACHE = new Map<string, MathBox>();
/** Bounded so a document that regenerates equations cannot grow it forever. */
const MAX_CACHE_ENTRIES = 4000;

let host: HTMLElement | null = null;

/** Notified once the math font arrives and the memoized boxes are dropped. */
const fontReadyListeners = new Set<() => void>();
let fontLoadStarted = false;

/**
 * Subscribe to "the math font just arrived, re-lay-out". Returns an
 * unsubscribe function.
 *
 * The editor cannot simply await the font on mount: the font only starts
 * loading when something asks for it, and the layout that measured against a
 * fallback face may happen before or after that. Driving the signal from the
 * measurement itself means whoever measured badly is exactly who gets told to
 * measure again.
 */
export function onMathFontReady(listener: () => void): () => void {
  fontReadyListeners.add(listener);
  return () => fontReadyListeners.delete(listener);
}

/** Start loading the math font once, then invalidate and announce. */
function ensureMathFontLoading(): void {
  if (fontLoadStarted) return;
  fontLoadStarted = true;

  void whenMathFontReady().then(() => {
    clearMathMeasureCache();
    for (const listener of fontReadyListeners) listener();
  });
}

function measuringHost(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (host && host.isConnected) return host;

  host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  // `contain: size` is deliberately absent: it makes the host's size independent
  // of its content, and the equation inside it then measures as zero-wide.
  host.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
    'white-space:nowrap;line-height:normal;contain:layout style;';
  document.body.appendChild(host);
  return host;
}

/**
 * Estimate a box from the equation's plain text. Used when there is no DOM and
 * when the browser reports a zero-sized box (fonts still loading).
 */
function estimateBox(
  plainText: string,
  fontSizePx: number,
  display: 'inline' | 'block' = 'inline'
): MathBox {
  const chars = Math.max(1, plainText.length);
  // Ratios taken from measuring real equations in the browser: a displayed
  // equation runs about 2.4x the font size tall (large operators with limits
  // above and below), an inline one about 1.4x.
  const heightRatio = display === 'block' ? 2.4 : 1.4;
  const ascentRatio = display === 'block' ? 1.7 : 1.05;
  return {
    width: chars * fontSizePx * 0.55,
    height: fontSizePx * heightRatio,
    ascent: fontSizePx * ascentRatio,
    descent: fontSizePx * (heightRatio - ascentRatio),
  };
}

/**
 * Measure a MathML fragment as it will be painted at `fontSizePx`.
 *
 * `plainText` is only consulted for the fallback estimate.
 */
export function measureMathBox(
  mathml: string,
  fontSizePx: number,
  plainText = '',
  display: 'inline' | 'block' = 'inline'
): MathBox {
  const size = fontSizePx > 0 ? fontSizePx : 14.67;
  if (!mathml) return estimateBox(plainText, size, display);

  // `display` is part of the key: the same MathML is laid out differently in
  // displaystyle (larger operators, limits above and below).
  const key = `${display}|${Math.round(size * 100)}|${mathml}`;
  const cached = MEASURE_CACHE.get(key);
  if (cached) return cached;

  const box = measureInDom(mathml, size, display) ?? estimateBox(plainText, size, display);

  // A box measured against a fallback face is wrong; don't let it stick, and
  // make sure the real font is on its way so this can be measured again.
  if (!isMathFontReady()) {
    ensureMathFontLoading();
    return box;
  }

  if (MEASURE_CACHE.size >= MAX_CACHE_ENTRIES) MEASURE_CACHE.clear();
  MEASURE_CACHE.set(key, box);
  return box;
}

function measureInDom(
  mathml: string,
  fontSizePx: number,
  display: 'inline' | 'block'
): MathBox | null {
  const container = measuringHost();
  if (!container) return null;

  container.style.fontSize = `${fontSizePx}px`;
  // Measured inside the very markup the painter emits — same class, same
  // `data-math-display` — so every stylesheet rule that shapes the painted
  // equation shapes the measured one too. Measuring bare MathML instead is how
  // the box and the paint drift apart.
  //
  // The zero-sized strut sits on the baseline of the line box, which is the
  // only way to recover where the baseline runs through the equation.
  container.innerHTML =
    '<span style="display:inline-block;width:0;height:0"></span>' +
    `<span class="layout-run layout-run-math" data-math-display="${display}">` +
    `${sanitizeMathml(mathml)}</span>`;

  const strut = container.firstElementChild as HTMLElement | null;
  const mathEl = container.querySelector('math');
  if (!strut || !mathEl) {
    container.innerHTML = '';
    return null;
  }

  const mathRect = mathEl.getBoundingClientRect();
  const baseline = strut.getBoundingClientRect().bottom;
  container.innerHTML = '';

  if (!Number.isFinite(mathRect.width) || mathRect.width <= 0 || mathRect.height <= 0) {
    return null;
  }

  return {
    width: mathRect.width,
    height: mathRect.height,
    ascent: Math.max(0, baseline - mathRect.top),
    descent: Math.max(0, mathRect.bottom - baseline),
  };
}

/** Whether the math font is loaded and measurements can be trusted. */
export function isMathFontReady(): boolean {
  if (typeof document === 'undefined' || !document.fonts) return true;
  try {
    return document.fonts.check(MATH_FONT_PROBE);
  } catch {
    return true;
  }
}

/**
 * Resolve once the math font is usable. Never rejects: a missing font file is
 * a degraded rendering, not an error the editor should surface.
 */
export function whenMathFontReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  if (isMathFontReady()) return Promise.resolve();
  return document.fonts
    .load(MATH_FONT_PROBE)
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Drop every memoized box. Call after the math font finishes loading: boxes
 * measured against a fallback font are wrong by a few percent, which shows up
 * as equations overlapping the line above.
 */
export function clearMathMeasureCache(): void {
  MEASURE_CACHE.clear();
}
