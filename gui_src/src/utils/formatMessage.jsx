import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import katex from 'katex';
import i18n from '../i18n';
import Mermaid from '../components/Mermaid';
import GraphicPreview from '../components/GraphicPreview';

// ── Custom component map ────────────────────────────────────────────────────
// Maps HTML element names produced by react-markdown to custom React
// components, so that the IDE theme and existing CSS classes are preserved.
// Zoom is applied via CSS transform on the container for better performance.

const BASE_COMPONENTS = {
  // Headings
  h1: ({ children }) => (
    <h1 style={{ margin: '14px 0 6px 0', fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', fontSize: '16px' }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ margin: '12px 0 6px 0', fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', fontSize: '15px' }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h4 style={{ margin: '14px 0 6px 0', fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', fontSize: '13px' }}>
      {children}
    </h4>
  ),

  // Paragraphs
  p: ({ children }) => (
    <p className="chat-text-primary" style={{ margin: '4px 0', fontSize: '13px', lineHeight: '1.5' }}>
      {children}
    </p>
  ),

  // Inline code
  code: ({ inline, className, children }) => {
    if (inline) {
      return (
        <code
          className="chat-inline-code"
          style={{ padding: '2px 4px', borderRadius: '3px', fontFamily: 'monospace', fontSize: '11px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)' }}
        >
          {children}
        </code>
      );
    }
    // Block code
    const lang = (className || '').replace('language-', '');
    if (lang === 'mermaid') {
      return <Mermaid chart={String(children)} />;
    }
    if (lang === 'tikzgraphic') {
      // LaTeX graphic preview: compile the snippet via the backend and
      // render the resulting SVG inline. The body is the raw tikzpicture
      // source produced by `latexToMarkdown` (no Markdown escaping needed).
      const raw = String(children);
      return (
        <GraphicPreview
          source={raw}
          projectPath={activeProjectPath || ''}
          label="TikZ / PGFPlots"
        />
      );
    }
    if (lang === 'thought') {
      return (
        <details style={{ margin: '8px 0', border: '1px solid var(--vscode-widget-border, #3c3c3c)', borderRadius: '4px', background: 'var(--titlebar-bg, #252526)' }}>
          <summary style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', userSelect: 'none', color: 'var(--vscode-descriptionForeground, #717171)' }}>
            {i18n.t('chatPanel.aiThoughts', 'Pensamentos da IA')}
          </summary>
          <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', overflowX: 'auto', fontSize: '11px', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', borderTop: '1px solid var(--vscode-widget-border, #3c3c3c)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {children}
          </pre>
        </details>
      );
    }
    return (
      <div style={{ margin: '8px 0', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-color, #3c3c3c)' }}>
        {lang && (
          <div style={{ background: 'var(--titlebar-bg, #1a1a1a)', padding: '2px 10px', fontSize: '10px', color: 'var(--vscode-descriptionForeground, #888)', borderBottom: '1px solid var(--border-color, #3c3c3c)' }}>
            {lang}
          </div>
        )}
        <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', overflowX: 'auto', fontSize: '12px', lineHeight: '1.5', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <code>{children}</code>
        </pre>
      </div>
    );
  },

  // Pre (wrap for block code)
  pre: ({ children }) => <>{children}</>,

  // Lists
  ul: ({ children }) => (
    <ul style={{ margin: '4px 0', paddingLeft: '20px', fontSize: '13px', lineHeight: '1.5' }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: '4px 0', paddingLeft: '20px', fontSize: '13px', lineHeight: '1.5' }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="chat-text-primary" style={{ margin: '2px 0' }}>
      {children}
    </li>
  ),

  // Bold / italic
  strong: ({ children }) => (
    <strong style={{ fontWeight: 'bold', color: 'var(--vscode-text-fg)' }}>
      {children}
    </strong>
  ),
  em: ({ children }) => (
    <em style={{ fontStyle: 'italic', color: 'var(--chat-muted, #8a8a8a)' }}>
      {children}
    </em>
  ),

  // Horizontal rule
  hr: () => (
    <hr style={{ border: 'none', borderTop: '1px solid var(--border-color, #3c3c3c)', margin: '12px 0' }} />
  ),

  // Blockquote
  blockquote: ({ children }) => (
    <blockquote style={{
      margin: '8px 0',
      paddingLeft: '10px',
      borderLeft: '3px solid var(--vscode-accent, #007acc)',
      color: 'var(--chat-muted, #8a8a8a)',
      fontSize: '13px',
    }}>
      {children}
    </blockquote>
  ),

  // Links
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--vscode-accent, #007acc)', textDecoration: 'underline' }}>
      {children}
    </a>
  ),

  // Tables
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '10px 0' }}>
      <table style={{
        borderCollapse: 'collapse',
        width: '100%',
        fontSize: '12px',
        lineHeight: '1.5',
        border: '1px solid var(--border-color, #3c3c3c)',
      }}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead style={{ background: 'var(--titlebar-bg, #252526)' }}>
      {children}
    </thead>
  ),
  tbody: ({ children }) => (
    <tbody>{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr style={{ borderBottom: '1px solid var(--border-color, #3c3c3c)' }}>
      {children}
    </tr>
  ),
  th: ({ children }) => (
    <th style={{
      padding: '6px 12px',
      textAlign: 'left',
      fontWeight: 'bold',
      color: 'var(--vscode-text-light, #ffffff)',
      borderRight: '1px solid var(--border-color, #3c3c3c)',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{
      padding: '5px 12px',
      color: 'var(--chat-text, #cccccc)',
      borderRight: '1px solid var(--border-color, #3c3c3c)',
      verticalAlign: 'top',
    }}>
      {children}
    </td>
  ),
};

const FENCED_MATH_LANGUAGES = new Set(['latex', 'tex']);

const canRenderFencedMath = (source) => {
  try {
    katex.renderToString(source, {
      displayMode: true,
      maxExpand: 250,
      maxSize: 10,
      output: 'mathml',
      strict: 'ignore',
      throwOnError: true,
    });
    return true;
  } catch {
    return false;
  }
};

// Models commonly wrap display equations in fenced `latex` blocks. Convert
// only KaTeX-valid blocks to math nodes; unsupported LaTeX remains visible as
// source code instead of being silently altered or discarded.
const remarkFencedLatexMath = () => (tree) => {
  const walk = (node) => {
    const language = String(node?.lang || '').toLowerCase();
    const source = String(node?.value || '').trim();
    if (node?.type === 'code' && FENCED_MATH_LANGUAGES.has(language) && source && canRenderFencedMath(source)) {
      node.type = 'math';
      node.value = source;
      node.meta = null;
      delete node.lang;
      node.data = {
        hName: 'pre',
        hChildren: [{
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value: source }],
        }],
      };
      return;
    }
    for (const child of node?.children || []) walk(child);
  };
  walk(tree);
};

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkFencedLatexMath];
const REHYPE_PLUGINS = [[rehypeKatex, { strict: 'ignore', output: 'mathml' }]];

// ── Public API ──────────────────────────────────────────────────────────────
// Drop-in replacement for the old formatMessageContent(content) function.
// Returns a React element that renders Markdown + LaTeX (KaTeX).
export function formatMessageContent(content, activeProjectPath = null, zoomLevel = 1.0) {
  if (!content) return null;

  // Convert <think>...</think> tags to markdown ```thought blocks for rendering
  let processed = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => {
    return '\n```thought\n' + inner.trim() + '\n```\n';
  });
  // Handle unclosed <think> (streaming partial)
  processed = processed.replace(/<think>([\s\S]*)$/i, (_, inner) => {
    return '\n```thought\n' + inner.trim() + '\n```\n';
  });

  const localComponents = {
    ...BASE_COMPONENTS,
    img: ({ src, alt, ...props }) => {
      let finalSrc = src;
      if (activeProjectPath && src && !src.startsWith('http') && !src.startsWith('data:')) {
        finalSrc = `/api/file/raw?projectPath=${encodeURIComponent(activeProjectPath)}&filePath=${encodeURIComponent(src)}`;
      }
      return (
        <img 
          src={finalSrc} 
          alt={alt} 
          style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', marginTop: '8px', marginBottom: '8px' }} 
          {...props} 
        />
      );
    }
  };

  return (
    <div style={{ 
      transform: `scale(${zoomLevel})`, 
      transformOrigin: 'top left', 
      width: `${100 / zoomLevel}%`,
      minHeight: `${100 / zoomLevel}%`
    }}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={localComponents}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
