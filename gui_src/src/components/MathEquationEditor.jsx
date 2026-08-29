import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';

/**
 * Equation editor overlay for the DOCX editor.
 *
 * The editing surface is MathLive (MIT): it gives the structured editing Word
 * and OnlyOffice have — slots you tab between, templates that build a fraction
 * or an integral around the selection, and LaTeX input that converts as you
 * type. The overlay anchors over the equation being edited so the edit reads
 * as in-place even though the document's own caret stays where it was.
 *
 * The panel talks LaTeX to MathLive and MathML to the document; the OMML the
 * .docx actually stores is produced by the caller from the MathML this returns.
 */

/**
 * The template gallery, grouped the way Word's equation ribbon groups it.
 * `#0` is the current selection and `#?` is a slot the user tabs into, which is
 * what makes a template wrap what is already selected.
 */
const TEMPLATE_GROUPS = [
  {
    id: 'fraction',
    items: [
      { label: 'a/b', latex: '\\frac{#0}{#?}', titleKey: 'fraction' },
      { label: '(n k)', latex: '\\binom{#0}{#?}', titleKey: 'binomial' },
    ],
  },
  {
    id: 'script',
    items: [
      { label: 'x²', latex: '#0^{#?}', titleKey: 'superscript' },
      { label: 'xᵢ', latex: '#0_{#?}', titleKey: 'subscript' },
      { label: 'xᵢ²', latex: '#0_{#?}^{#?}', titleKey: 'subsuperscript' },
    ],
  },
  {
    id: 'radical',
    items: [
      { label: '√x', latex: '\\sqrt{#0}', titleKey: 'squareRoot' },
      { label: 'ⁿ√x', latex: '\\sqrt[#?]{#0}', titleKey: 'nthRoot' },
    ],
  },
  {
    id: 'operator',
    items: [
      { label: '∫', latex: '\\int_{#?}^{#?}#0', titleKey: 'integral' },
      { label: '∮', latex: '\\oint_{#?}#0', titleKey: 'contourIntegral' },
      { label: '∑', latex: '\\sum_{#?}^{#?}#0', titleKey: 'summation' },
      { label: '∏', latex: '\\prod_{#?}^{#?}#0', titleKey: 'product' },
      { label: '⋃', latex: '\\bigcup_{#?}^{#?}#0', titleKey: 'union' },
    ],
  },
  {
    id: 'bracket',
    items: [
      { label: '( )', latex: '\\left(#0\\right)', titleKey: 'parentheses' },
      { label: '[ ]', latex: '\\left[#0\\right]', titleKey: 'brackets' },
      { label: '{ }', latex: '\\left\\{#0\\right\\}', titleKey: 'braces' },
      { label: '| |', latex: '\\left|#0\\right|', titleKey: 'absoluteValue' },
    ],
  },
  {
    id: 'function',
    items: [
      { label: 'sin', latex: '\\sin\\left(#0\\right)', titleKey: 'sine' },
      { label: 'log', latex: '\\log\\left(#0\\right)', titleKey: 'logarithm' },
      { label: 'lim', latex: '\\lim_{#?}#0', titleKey: 'limit' },
    ],
  },
  {
    id: 'accent',
    items: [
      { label: 'x̂', latex: '\\hat{#0}', titleKey: 'hat' },
      { label: 'x̄', latex: '\\bar{#0}', titleKey: 'bar' },
      { label: 'x⃗', latex: '\\vec{#0}', titleKey: 'vector' },
      { label: 'x̃', latex: '\\tilde{#0}', titleKey: 'tilde' },
    ],
  },
  {
    id: 'matrix',
    items: [
      { label: '2×2', latex: '\\begin{pmatrix}#0 & #? \\\\ #? & #?\\end{pmatrix}', titleKey: 'matrix2x2' },
      { label: '{…', latex: '\\begin{cases}#0 & #? \\\\ #? & #?\\end{cases}', titleKey: 'cases' },
    ],
  },
];

/** Where the panel sits, clamped so it never hangs outside the editor. */
function panelPosition(anchorRect, hostSize) {
  const PANEL_WIDTH = 460;
  const GAP = 8;
  if (!anchorRect) {
    return { left: Math.max(GAP, (hostSize.width - PANEL_WIDTH) / 2), top: 72 };
  }

  const left = Math.min(
    Math.max(GAP, anchorRect.left),
    Math.max(GAP, hostSize.width - PANEL_WIDTH - GAP)
  );
  const below = anchorRect.top + anchorRect.height + GAP;
  return { left, top: Math.max(GAP, below) };
}

export default function MathEquationEditor({
  initialLatex = '',
  display = 'inline',
  anchorRect = null,
  hostSize = { width: 800, height: 600 },
  onCommit,
  onCancel,
}) {
  const { t } = useTranslation();
  const fieldHostRef = useRef(null);
  const fieldRef = useRef(null);
  const latexInputFocusedRef = useRef(false);
  const [latex, setLatex] = useState(initialLatex);
  const [equationDisplay, setEquationDisplay] = useState(display);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let field = null;

    (async () => {
      try {
        // Loaded on demand: MathLive is a large dependency and only a user who
        // opens an equation ever needs it.
        const { MathfieldElement } = await import('mathlive');
        if (cancelled) return;

        MathfieldElement.fontsDirectory = '/mathlive-fonts';
        MathfieldElement.soundsDirectory = null;

        field = new MathfieldElement();
        // Set as properties rather than constructor options: these two live on
        // the element, and assigning them directly is the documented path.
        // The virtual keyboard is a touch affordance; on the desktop it steals
        // the bottom of the window on first focus.
        field.mathVirtualKeyboardPolicy = 'manual';
        field.smartMode = true;
        field.style.width = '100%';
        field.style.minHeight = '52px';
        field.value = initialLatex;

        field.addEventListener('input', () => {
          if (latexInputFocusedRef.current) return;
          setLatex(field.getValue('latex'));
        });

        if (cancelled || !fieldHostRef.current) return;
        fieldHostRef.current.appendChild(field);
        fieldRef.current = field;
        field.focus();
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      fieldRef.current = null;
      field?.remove();
    };
    // Mount-only: re-running would discard what the user has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(() => {
    const field = fieldRef.current;
    if (!field) return;
    onCommit?.({
      mathml: field.getValue('math-ml'),
      latex: field.getValue('latex'),
      display: equationDisplay,
    });
  }, [equationDisplay, onCommit]);

  const insertTemplate = useCallback((template) => {
    const field = fieldRef.current;
    if (!field) return;
    field.insert(template, { focus: true, selectionMode: 'placeholder' });
    setLatex(field.getValue('latex'));
  }, []);

  const applyLatex = useCallback((value) => {
    setLatex(value);
    const field = fieldRef.current;
    if (field) field.value = value;
  }, []);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel?.();
        return;
      }
      // Enter belongs to the mathfield (it adds a row to a matrix), so the
      // commit shortcut is the modified one.
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        commit();
      }
    },
    [commit, onCancel]
  );

  const position = panelPosition(anchorRect, hostSize);

  return (
    <div
      className="math-equation-editor"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label={t('docxEditor.equation.title', 'Equation')}
    >
      <div className="math-equation-editor__header">
        <span className="math-equation-editor__title">
          {t('docxEditor.equation.title', 'Equation')}
        </span>
        <div className="math-equation-editor__display-toggle">
          <button
            type="button"
            className={equationDisplay === 'inline' ? 'is-active' : ''}
            onClick={() => setEquationDisplay('inline')}
            title={t('docxEditor.equation.inlineHint', 'Equation inside the text line')}
          >
            {t('docxEditor.equation.inline', 'Inline')}
          </button>
          <button
            type="button"
            className={equationDisplay === 'block' ? 'is-active' : ''}
            onClick={() => setEquationDisplay('block')}
            title={t('docxEditor.equation.blockHint', 'Equation on its own line')}
          >
            {t('docxEditor.equation.block', 'Display')}
          </button>
        </div>
        <button
          type="button"
          className="math-equation-editor__close"
          onClick={() => onCancel?.()}
          title={t('common.cancel', 'Cancel')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="math-equation-editor__templates">
        {TEMPLATE_GROUPS.map((group) => (
          <div className="math-equation-editor__group" key={group.id}>
            {group.items.map((item) => (
              <button
                type="button"
                key={item.titleKey}
                onClick={() => insertTemplate(item.latex)}
                title={t(`docxEditor.equation.templates.${item.titleKey}`, item.titleKey)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {loadError ? (
        <p className="math-equation-editor__error">
          {t('docxEditor.equation.loadFailed', 'Could not load the equation editor: {{error}}', {
            error: loadError,
          })}
        </p>
      ) : (
        <div className="math-equation-editor__field" ref={fieldHostRef} />
      )}

      <label className="math-equation-editor__latex">
        <span>{t('docxEditor.equation.latex', 'LaTeX')}</span>
        <input
          type="text"
          value={latex}
          spellCheck={false}
          onFocus={() => {
            latexInputFocusedRef.current = true;
          }}
          onBlur={() => {
            latexInputFocusedRef.current = false;
          }}
          onChange={(event) => applyLatex(event.target.value)}
        />
      </label>

      <div className="math-equation-editor__footer">
        <span className="math-equation-editor__hint">
          {t('docxEditor.equation.hint', 'Tab moves between slots · Ctrl+Enter inserts · Esc cancels')}
        </span>
        <button type="button" className="vscode-button" onClick={() => onCancel?.()}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button type="button" className="vscode-button primary" onClick={commit} disabled={!!loadError}>
          <Check size={12} />
          {t('docxEditor.equation.apply', 'Apply')}
        </button>
      </div>
    </div>
  );
}
