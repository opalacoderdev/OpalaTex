import React, { useMemo } from 'react';
import { formatMessageContent } from '../utils/formatMessage';
import { latexToMarkdown } from '../utils/latexToMarkdown';

// ─────────────────────────────────────────────────────────────────────────────
// LatexPreview
//
// Live preview for a *subset* of LaTeX. Converts the source to Markdown+KaTeX
// via `latexToMarkdown`, then reuses the existing `formatMessageContent`
// pipeline (react-markdown + remark-math + rehype-katex) to render.
//
// Unsupported constructs are shown as fenced ````latex blocks so the user can
// see exactly what wasn't rendered — transparent fallback, no silent loss.
//
// This is NOT a WYSIWYG editor: it is read-only preview that updates as the
// user types in Monaco. The source remains the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export default function LatexPreview({ source, activeProjectPath, zoomLevel = 1.0 }) {
  const rendered = useMemo(() => {
    const md = latexToMarkdown(source);
    return formatMessageContent(md, activeProjectPath, zoomLevel);
  }, [source, activeProjectPath, zoomLevel]);

  return (
    <div
      className="latex-preview-container markdown-preview-container"
      style={{
        padding: '20px',
        overflowY: 'auto',
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        boxSizing: 'border-box',
      }}
    >
      {rendered}
    </div>
  );
}