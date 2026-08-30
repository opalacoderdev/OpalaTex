import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import katex from 'katex';
import i18n from '../i18n';
import Mermaid from '../components/Mermaid';
import GraphicPreview from '../components/GraphicPreview';
import { orphanReasoningPrefix, stripOrphanReasoningPrefix, thoughtBlock } from './thinkTags';

// ── Custom component map ────────────────────────────────────────────────────
// Maps HTML element names produced by react-markdown to custom React
// components, so that the IDE theme and existing CSS classes are preserved.
// Zoom uses the CSS `zoom` property — the same mechanism ChatPanel applies to
// the chat history — rather than `transform: scale()`. A transform would take
// the content out of the normal layout flow of its scroll container, which
// leaves scaled content unreachable and breaks `position: sticky` for the
// table scrollbar below.

// Wide tables are common in agent answers, and their rows are usually tall
// enough that the table is far longer than the chat viewport. A plain
// `overflow-x: auto` wrapper places its horizontal scrollbar at the *bottom of
// the table*, which in that case sits well below the visible area — the table
// simply looks clipped, with no reachable way to pan it.
//
// So the wrapper keeps owning the scrolling, but its own scrollbar is hidden
// and driven by a proxy scrollbar pinned with `position: sticky` to the bottom
// edge of the chat viewport. The control stays visible and draggable the whole
// time any part of the table is on screen, and parks at the table's bottom
// edge once the end of the table scrolls into view.
function ChatTable({ children }) {
  const scrollRef = useRef(null);
  const barRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [needsBar, setNeedsBar] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;

    const measure = () => {
      setContentWidth(el.scrollWidth);
      // Sub-pixel layout rounding can leave a fraction of overflow on tables
      // that actually fit; require a whole pixel before showing the bar.
      setNeedsBar(el.scrollWidth - el.clientWidth >= 1);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [children]);

  // Mirror either element's scroll offset onto the other. Assigning an
  // unchanged scrollLeft fires no scroll event, so the two handlers settle
  // after one hop instead of feeding back into each other.
  const syncBarToContent = useCallback(() => {
    if (barRef.current && scrollRef.current) {
      barRef.current.scrollLeft = scrollRef.current.scrollLeft;
    }
  }, []);

  const syncContentToBar = useCallback(() => {
    if (barRef.current && scrollRef.current) {
      scrollRef.current.scrollLeft = barRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="chat-table-block">
      <div
        ref={scrollRef}
        className={`chat-table-scroll${needsBar ? ' chat-table-scroll-hidden-bar' : ''}`}
        onScroll={needsBar ? syncBarToContent : undefined}
      >
        <table className="chat-table">
          {children}
        </table>
      </div>
      {needsBar && (
        <div
          ref={barRef}
          className="chat-table-hbar"
          onScroll={syncContentToBar}
          aria-hidden="true"
        >
          <div style={{ width: `${contentWidth}px`, height: '1px' }} />
        </div>
      )}
    </div>
  );
}

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
      // source (no Markdown escaping needed).
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
  table: ({ children }) => <ChatTable>{children}</ChatTable>,
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
// This runs only for completed assistant messages. Live stream chunks remain
// raw text so partial Markdown and LaTex never delay or distort the output.
function normalizeFinalMathDelimiters(content) {
  const normalizeProse = (prose) => prose
    .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (_, math) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, (_, math) => {
      const trimmed = math.trim();
      return trimmed.includes('\n') ? `\n$$\n${trimmed}\n$$\n` : `$${trimmed}$`;
    });

  const normalizeNonCode = (segment) => segment
    .split(/(`[^`]*`)/g)
    .map((part) => (part.startsWith('`') && part.endsWith('`') ? part : normalizeProse(part)))
    .join('');

  return String(content || '')
    .replace(/(?<!\\)\\\(\s*(```(?:latex|tex)[^\n]*\n[\s\S]*?```)\s*(?<!\\)\\\)/gi, '$1')
    .replace(/(?<!\\)\\\[\s*(```(?:latex|tex)[^\n]*\n[\s\S]*?```)\s*(?<!\\)\\\]/gi, '$1')
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part) => (part.startsWith('```') || part.startsWith('~~~') ? part : normalizeNonCode(part)))
    .join('');
}

// Drop-in replacement for the old formatMessageContent(content) function.
// Returns a React element that renders Markdown + LaTeX (KaTeX).
export function formatMessageContent(content, activeProjectPath = null, zoomLevel = 1.0) {
  return formatMessageContentImpl(content, activeProjectPath, zoomLevel);
}

// Memoized component wrapper around formatMessageContent. Markdown/KaTeX
// parsing is expensive and must run only when a message is first rendered
// (or its content actually changes) — not on every parent re-render, which
// happens at token frequency while another turn is still streaming.
export const FormattedMessage = React.memo(function FormattedMessage({ content, projectPath = null, zoomLevel = 1.0 }) {
  return formatMessageContentImpl(content, projectPath, zoomLevel);
});

function formatMessageContentImpl(content, activeProjectPath = null, zoomLevel = 1.0) {
  if (!content) return null;

  // Reasoning closed by an orphan </think>: the chat template seeded the opening
  // tag in the prompt, so the model only emitted the closing one.
  let processed = content;
  const orphanReasoning = orphanReasoningPrefix(processed);
  if (orphanReasoning) {
    processed = thoughtBlock(orphanReasoning) + stripOrphanReasoningPrefix(processed);
  }
  // Convert <think>...</think> tags to markdown ```thought blocks for rendering
  processed = processed.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => thoughtBlock(inner));
  // Handle unclosed <think> (streaming partial)
  processed = processed.replace(/<think>([\s\S]*)$/i, (_, inner) => thoughtBlock(inner));
  processed = normalizeFinalMathDelimiters(processed);

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
    <div style={zoomLevel === 1 ? undefined : { zoom: zoomLevel }}>
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
