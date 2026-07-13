import katex from 'katex';
import { validateRenderableMath } from '../utils/mathValidation';

self.onmessage = (event) => {
  const { id, math, displayMode } = event.data || {};
  try {
    const validation = validateRenderableMath(math, { displayMode: !!displayMode });
    if (!validation.ok) {
      self.postMessage({ id, errorKey: validation.reasonKey, errorParams: validation.reasonParams });
      return;
    }

    // Use 'mathml' output instead of 'html'. The HTML output mode generates
    // thousands of nested <span> elements with absolute positioning for complex
    // equations (cases, sums, matrices), which causes massive layout thrashing
    // when inserted into the DOM via dangerouslySetInnerHTML. MathML is rendered
    // natively by the Chromium engine (used in VS Code's webview) and produces
    // dramatically fewer DOM nodes.
    //
    // IMPORTANT: KaTeX's `output: 'mathml'` skips the displayWrap step, so the
    // result is NOT wrapped in `<span class="katex">` / `<span class="katex-
    // display">`. We wrap it here so the katex.min.css rules apply the KaTeX
    // fonts (KaTeX_Main, KaTeX_Math, etc.) to the MathML elements. Without this
    // wrapper, the browser falls back to system fonts that lack math glyphs,
    // producing broken rendering.
    const mathml = katex.renderToString(validation.math, {
      displayMode: !!displayMode,
      throwOnError: true,
      maxExpand: 250,
      maxSize: 10,
      output: 'mathml',
      strict: 'ignore',
    });

    const wrapperClass = displayMode
      ? '<span class="katex-display"><span class="katex">'
      : '<span class="katex">';
    const wrapperClose = displayMode ? '</span></span>' : '</span>';
    const html = wrapperClass + mathml + wrapperClose;
    self.postMessage({ id, html });
  } catch (error) {
    self.postMessage({ id, errorKey: 'richTextEditor.math.renderFailed', errorParams: { message: String(error) } });
  }
};
