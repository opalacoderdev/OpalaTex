import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import i18n from '../i18n';

// ── Custom component map ────────────────────────────────────────────────────
// Maps HTML element names produced by react-markdown to custom React
// components, so that the IDE theme and existing CSS classes are preserved.

const components = {
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
        <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', overflowX: 'auto', fontSize: '12px', lineHeight: '1.5', fontFamily: 'monospace' }}>
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

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [[rehypeKatex, { strict: "ignore" }]];

// ── Public API ──────────────────────────────────────────────────────────────
// Drop-in replacement for the old formatMessageContent(content) function.
// Returns a React element that renders Markdown + LaTeX (KaTeX).
export function formatMessageContent(content, activeProjectPath = null) {
  if (!content) return null;

  const localComponents = {
    ...components,
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
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={localComponents}
    >
      {content}
    </ReactMarkdown>
  );
}
