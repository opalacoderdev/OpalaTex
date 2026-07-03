import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import katex from 'katex';
import { parseLatexBlocks } from '../utils/latexBlockParser';
import { serializeDocument } from '../utils/latexBlockSerializer';
import { formatMessageContent } from '../utils/formatMessage';

// ── Module-level cache: keyed by (projectPath, graphic-source-hash) ────────
// This avoids re-compiling identical TikZ snippets on every keystroke. The
// backend also caches by the same content-hash so we hit an O(1) dict lookup
// after the first render. Both caches are bounded in size to avoid memory
// growth on long editing sessions.
const graphicSvgCache = new Map();
const GRAPHIC_CACHE_MAX = 64;

// Lightweight 32-bit FNV-1a hash of a string, fast and good-enough for an
// in-memory cache key. We avoid shipping crypto-js for this small concern.
function hashSource(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// RichTextEditor
//
// Overleaf-style Rich Text editor for LaTeX. Parses the source into blocks;
// editable prose blocks (headings, paragraphs, lists, quotes) are rendered as
// contentEditable elements whose changes are serialized back to LaTeX and
// spliced into the source via `onChange`. Non-editable blocks (math, figures,
// tables, code, unrecognized environments) are rendered as read-only previews
// with a "jump to source" action on click.
//
// Strategy:
//   - Source LaTeX remains the single source of truth.
//   - Only editable blocks are modified; complex blocks are preserved as-is.
//   - Inline math is rendered while blocks are idle and shown as raw LaTeX
//     while the block is focused for editing.
// ─────────────────────────────────────────────────────────────────────────────

export default function RichTextEditor({
  source,
  activeProjectPath,
  sourceTex,
  zoomLevel = 1.0,
  initialSourceLine,
  onChange,
  onJumpToSource,
  onActiveSourceLineChange,
}) {
  const { t } = useTranslation();
  const blocks = useMemo(() => parseLatexBlocks(source), [source]);
  const containerRef = useRef(null);
  const activeLineRef = useRef(1);
  const lastInitialLineRef = useRef(null);

  // ── Handle edit in a contentEditable block ───────────────────────────────
  const handleBlockEdit = useCallback((blockId, newText) => {
    if (!onChange) return;
    // Find the block and update its text
    const updatedBlocks = blocks.map(b =>
      b.id === blockId ? { ...b, text: newText } : b
    );
    const newSource = serializeDocument(source, updatedBlocks);
    onChange(newSource);
  }, [blocks, source, onChange]);

  // ── Handle list item edit ────────────────────────────────────────────────
  const handleListItemEdit = useCallback((blockId, itemIndex, field, newValue) => {
    if (!onChange) return;
    const updatedBlocks = blocks.map(b => {
      if (b.id !== blockId) return b;
      const items = b.items.map((it, i) =>
        i === itemIndex ? { ...it, [field]: newValue } : it
      );
      return { ...b, items };
    });
    const newSource = serializeDocument(source, updatedBlocks);
    onChange(newSource);
  }, [blocks, source, onChange]);

  // ── Jump to source line for non-editable blocks ──────────────────────────
  const handleJumpToSource = useCallback((block) => {
    if (!onJumpToSource) return;
    // Convert char offset to line number
    const line = sourceLineFromOffset(source, block.start);
    onJumpToSource(line, block.start);
  }, [source, onJumpToSource]);

  const setActiveSourceLine = useCallback((line) => {
    if (!line || activeLineRef.current === line) return;
    activeLineRef.current = line;
    if (onActiveSourceLineChange) onActiveSourceLineChange(line);
  }, [onActiveSourceLineChange]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(container.querySelectorAll('[data-source-line]'));
    const current = items.find((item) => item.offsetTop + item.offsetHeight >= container.scrollTop + 24) || items[0];
    const line = Number(current?.getAttribute('data-source-line'));
    if (line) setActiveSourceLine(line);
  }, [setActiveSourceLine]);

  useEffect(() => {
    const line = Number(initialSourceLine);
    const container = containerRef.current;
    if (!line || !container || lastInitialLineRef.current === line) return;

    const frame = window.requestAnimationFrame(() => {
      const items = Array.from(container.querySelectorAll('[data-source-line]'));
      if (!items.length) return;

      let target = items[0];
      for (const item of items) {
        const itemLine = Number(item.getAttribute('data-source-line'));
        if (!itemLine || itemLine > line) break;
        target = item;
      }

      container.scrollTop = Math.max(0, target.offsetTop - 24);
      lastInitialLineRef.current = line;
      setActiveSourceLine(Number(target.getAttribute('data-source-line')) || line);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [blocks, initialSourceLine, setActiveSourceLine]);

  return (
    <div
      ref={containerRef}
      className="rich-text-editor-container"
      onScroll={handleScroll}
      style={{
        padding: '20px',
        overflowY: 'auto',
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        boxSizing: 'border-box',
        transform: `scale(${zoomLevel})`,
        transformOrigin: 'top left',
        width: `${100 / zoomLevel}%`,
        minHeight: `${100 / zoomLevel}%`,
      }}
    >
      {blocks.map((block) => {
        const sourceLine = sourceLineFromOffset(source, block.start);
        return (
          <div
            key={block.id}
            data-source-line={sourceLine}
            onMouseDown={() => setActiveSourceLine(sourceLine)}
            onFocusCapture={() => setActiveSourceLine(sourceLine)}
          >
            <BlockRenderer
              block={block}
              activeProjectPath={activeProjectPath}
              sourceTex={sourceTex}
              onBlockEdit={handleBlockEdit}
              onListItemEdit={handleListItemEdit}
              onJumpToSource={handleJumpToSource}
            />
          </div>
        );
      })}
      {blocks.length === 0 && (
        <div style={{ color: 'var(--vscode-descriptionForeground, #888)', fontSize: '13px', padding: '20px' }}>
          {t('editorPanel.emptyRichText', 'No editable content. Open a .tex file with a document body.')}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BlockRenderer — renders a single block based on its type
// ─────────────────────────────────────────────────────────────────────────────

function BlockRenderer({ block, activeProjectPath, sourceTex, onBlockEdit, onListItemEdit, onJumpToSource }) {
  switch (block.type) {
    case 'preamble':
      return <PreambleBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'heading':
      return <HeadingBlock block={block} onEdit={onBlockEdit} />;
    case 'paragraph':
      return <ParagraphBlock block={block} onEdit={onBlockEdit} />;
    case 'list':
      return <ListBlock block={block} onItemEdit={onListItemEdit} />;
    case 'quote':
      return <QuoteBlock block={block} onEdit={onBlockEdit} />;
    case 'math':
      return <MathBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'figure':
      return <FigureBlock block={block} activeProjectPath={activeProjectPath} sourceTex={sourceTex} onJumpToSource={onJumpToSource} />;
    case 'graphic':
      return <GraphicBlock block={block} activeProjectPath={activeProjectPath} onJumpToSource={onJumpToSource} />;
    case 'table':
      return <TableBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'code':
      return <CodeBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'environment':
      return <EnvironmentBlock block={block} onJumpToSource={onJumpToSource} />;
    case 'comment':
      return <CommentBlock block={block} />;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Editable blocks
// ─────────────────────────────────────────────────────────────────────────────

function HeadingBlock({ block, onEdit }) {
  const sizes = { 1: '22px', 2: '20px', 3: '18px', 4: '16px', 5: '14px', 6: '13px' };
  const style = {
    fontSize: sizes[block.level] || '18px',
    fontWeight: 'bold',
    color: 'var(--vscode-text-light, #ffffff)',
    margin: '16px 0 8px 0',
    outline: 'none',
    padding: '2px 4px',
    borderRadius: '3px',
    borderBottom: '1px solid transparent',
    whiteSpace: 'pre-wrap',
  };

  return (
    <EditableLatexText
      text={block.text}
      onCommit={(newText) => onEdit(block.id, newText)}
      style={style}
      editingStyle={{ borderBottom: '1px solid var(--vscode-accent, #007acc)' }}
    />
  );
}

function sourceLineFromOffset(source, offset) {
  return source.slice(0, Math.max(0, offset || 0)).split('\n').length;
}

function ParagraphBlock({ block, onEdit }) {
  const style = {
    margin: '6px 0',
    fontSize: '13px',
    lineHeight: '1.6',
    color: 'var(--chat-text, #cccccc)',
    outline: 'none',
    padding: '2px 4px',
    borderRadius: '3px',
    whiteSpace: 'pre-wrap',
  };

  return (
    <EditableLatexText
      text={block.text}
      onCommit={(newText) => onEdit(block.id, newText)}
      style={style}
      editingStyle={{ background: 'var(--vscode-list-hoverBg, rgba(255,255,255,0.04))' }}
    />
  );
}

function ListBlock({ block, onItemEdit }) {
  const isOrdered = block.listType === 'enumerate';
  const isDescription = block.listType === 'description';
  const ListTag = isOrdered ? 'ol' : 'ul';
  return (
    <ListTag style={{ margin: '8px 0', paddingLeft: '24px', fontSize: '13px', lineHeight: '1.6', color: 'var(--chat-text, #cccccc)' }}>
      {block.items.map((item, i) => (
        <li key={i} style={{ margin: '4px 0', listStyleType: isDescription ? 'none' : undefined }}>
          {isDescription ? (
            <span style={{ display: 'flex', gap: '6px' }}>
              <EditableLatexText
                as="span"
                text={item.term}
                onCommit={(v) => onItemEdit(block.id, i, 'term', v)}
                style={{ fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', outline: 'none', whiteSpace: 'pre-wrap' }}
              />
              <EditableLatexText
                as="span"
                text={item.text}
                onCommit={(v) => onItemEdit(block.id, i, 'text', v)}
                style={{ outline: 'none', flex: 1, whiteSpace: 'pre-wrap' }}
              />
            </span>
          ) : (
            <EditableLatexText
              as="span"
              text={item.text}
              onCommit={(v) => onItemEdit(block.id, i, 'text', v)}
              style={{ outline: 'none', display: 'inline-block', width: '100%', whiteSpace: 'pre-wrap' }}
            />
          )}
        </li>
      ))}
    </ListTag>
  );
}

function QuoteBlock({ block, onEdit }) {
  const style = {
    margin: '8px 0',
    paddingLeft: '12px',
    borderLeft: '3px solid var(--vscode-accent, #007acc)',
    color: 'var(--chat-muted, #8a8a8a)',
    fontSize: '13px',
    outline: 'none',
    padding: '4px 8px',
    whiteSpace: 'pre-wrap',
  };

  return (
    <EditableLatexText
      as="blockquote"
      text={block.text}
      onCommit={(newText) => onEdit(block.id, newText)}
      style={style}
      editingStyle={{ background: 'var(--vscode-list-hoverBg, rgba(255,255,255,0.04))' }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-editable blocks (rendered preview + jump to source)
// ─────────────────────────────────────────────────────────────────────────────

// ── GraphicBlock ────────────────────────────────────────────────────────────
//
// Renders a tikzpicture / PGFPlots block as a live SVG preview by asking the
// backend to compile the snippet through tectonic + PyMuPDF. The block is
// read-only: clicking anywhere outside the source-label jumps the user to
// the matching source line in Monaco.
//
// Status transitions:
//   idle -> loading -> ok  (svg set)
//   idle -> loading -> err (log set)
// Debounced re-render so the user can type freely without spawning a compile
// per keystroke.
function EditableLatexText({ as: Tag = 'div', text, onCommit, style, editingStyle = {} }) {
  const [isEditing, setIsEditing] = useState(false);
  const editRef = useRef(null);
  const safeText = text || '';

  useEffect(() => {
    if (!isEditing || !editRef.current) return;
    const el = editRef.current;
    el.focus();
    moveCaretToEnd(el);
  }, [isEditing]);

  const commit = useCallback((value) => {
    setIsEditing(false);
    if (value !== safeText) onCommit(value);
  }, [onCommit, safeText]);

  if (isEditing) {
    return (
      <Tag
        ref={editRef}
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => commit(e.currentTarget.textContent || '')}
        onKeyDown={(e) => {
          const isMod = e.ctrlKey || e.metaKey;
          if (isMod && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            insertLatexWrapper(e.currentTarget, 'textbf');
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setIsEditing(false);
          }
        }}
        style={{ ...style, ...editingStyle }}
      >
        {safeText}
      </Tag>
    );
  }

  return (
    <Tag
      tabIndex={0}
      onClick={() => setIsEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setIsEditing(true);
        }
      }}
      style={{ ...style, cursor: 'text' }}
    >
      {renderStyledLatexText(safeText)}
    </Tag>
  );
}

function moveCaretToEnd(el) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertLatexWrapper(el, command) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;

  const start = getTextOffset(el, range.startContainer, range.startOffset);
  const end = getTextOffset(el, range.endContainer, range.endOffset);
  if (start === -1 || end === -1) return;

  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const currentText = el.textContent || '';
  const selectedText = currentText.slice(selectionStart, selectionEnd);
  const prefix = `\\${command}{`;
  const suffix = '}';
  const nextText = `${currentText.slice(0, selectionStart)}${prefix}${selectedText}${suffix}${currentText.slice(selectionEnd)}`;

  el.textContent = nextText;

  const caretOffset = selectedText
    ? selectionStart + prefix.length + selectedText.length + suffix.length
    : selectionStart + prefix.length;
  setCaretOffset(el, caretOffset);
}

function getTextOffset(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textOffset = 0;

  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current === node) return textOffset + offset;
    textOffset += current.textContent.length;
  }

  if (node === root) {
    let childOffset = 0;
    for (let i = 0; i < Math.min(offset, root.childNodes.length); i++) {
      childOffset += root.childNodes[i].textContent.length;
    }
    return childOffset;
  }

  return -1;
}

function setCaretOffset(root, offset) {
  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let target = root;
  let targetOffset = root.childNodes.length;

  while (walker.nextNode()) {
    const current = walker.currentNode;
    const length = current.textContent.length;
    if (remaining <= length) {
      target = current;
      targetOffset = remaining;
      break;
    }
    remaining -= length;
  }

  const range = document.createRange();
  range.setStart(target, targetOffset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderInlineLatex(text) {
  return tokenizeInlineMath(text).map((token, index) => {
    if (token.type === 'text') {
      return <React.Fragment key={index}>{token.value}</React.Fragment>;
    }
    const html = renderKatexInline(token.value);
    if (!html) {
      return <React.Fragment key={index}>{token.raw}</React.Fragment>;
    }
    return (
      <span
        key={index}
        className="rich-text-inline-math"
        data-latex={token.raw}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  });
}

function renderKatexInline(math) {
  try {
    return katex.renderToString(math, {
      displayMode: false,
      throwOnError: false,
      strict: 'ignore',
    });
  } catch {
    return '';
  }
}

function tokenizeInlineMath(text) {
  const tokens = [];
  let cursor = 0;
  let i = 0;

  const pushText = (end) => {
    if (end > cursor) tokens.push({ type: 'text', value: text.slice(cursor, end) });
  };

  while (i < text.length) {
    if (text.startsWith('\\(', i)) {
      const end = findInlineCommandMathEnd(text, i + 2);
      if (end !== -1) {
        pushText(i);
        tokens.push({
          type: 'math',
          value: text.slice(i + 2, end),
          raw: text.slice(i, end + 2),
        });
        i = end + 2;
        cursor = i;
        continue;
      }
    }

    if (text[i] === '$' && !isEscaped(text, i) && text[i + 1] !== '$' && text[i - 1] !== '$') {
      const end = findInlineDollarMathEnd(text, i + 1);
      if (end !== -1) {
        pushText(i);
        tokens.push({
          type: 'math',
          value: text.slice(i + 1, end),
          raw: text.slice(i, end + 1),
        });
        i = end + 1;
        cursor = i;
        continue;
      }
    }

    i++;
  }

  pushText(text.length);
  return tokens;
}

function findInlineCommandMathEnd(text, start) {
  let i = start;
  while (i < text.length) {
    if (text.startsWith('\\)', i) && !isEscaped(text, i)) return i;
    i++;
  }
  return -1;
}

function findInlineDollarMathEnd(text, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\n') return -1;
    if (text[i] === '$' && !isEscaped(text, i) && text[i + 1] !== '$') return i;
    i++;
  }
  return -1;
}

function isEscaped(text, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashCount++;
  return slashCount % 2 === 1;
}

function GraphicBlock({ block, activeProjectPath, onJumpToSource }) {
  const [state, setState] = useState({ status: 'idle', svg: '', log: '' });
  const debounceRef = useRef(null);
  const tokenRef = useRef(0);

  const cacheKey = useMemo(() => {
    const raw = block.raw || block.source || '';
    return `${activeProjectPath || ''}::${hashSource(raw)}`;
  }, [block.raw, block.source, activeProjectPath]);

  useEffect(() => {
    // Reset in-flight token and clear pending debounce on source change.
    tokenRef.current += 1;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const raw = block.raw || block.source || '';
    if (!raw.trim()) {
      setState({ status: 'idle', svg: '', log: '' });
      return;
    }

    // Front-end cache hit: avoid a round-trip entirely.
    const cached = graphicSvgCache.get(cacheKey);
    if (cached) {
      setState({ status: 'ok', svg: cached, log: '' });
      return;
    }

    setState({ status: 'loading', svg: '', log: '' });

    debounceRef.current = setTimeout(async () => {
      const myToken = tokenRef.current;
      try {
        const res = await fetch('/api/latex/render-graphic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            graphic: raw,
            projectPath: activeProjectPath || '',
            cacheKey,
            graphicEngine: block.graphicEngine || '',
          }),
        });
        const data = await res.json();
        // Drop the result if the user has kept typing and triggered a newer
        // render — we only apply the latest in-flight response.
        if (myToken !== tokenRef.current) return;
        if (data && data.success && data.svg) {
          graphicSvgCache.set(cacheKey, data.svg);
          // Cap cache to avoid unbounded growth
          if (graphicSvgCache.size > GRAPHIC_CACHE_MAX) {
            const firstKey = graphicSvgCache.keys().next().value;
            graphicSvgCache.delete(firstKey);
          }
          setState({ status: 'ok', svg: data.svg, log: '' });
        } else {
          setState({ status: 'err', svg: '', log: (data && data.log) || 'render failed' });
        }
      } catch (err) {
        if (myToken !== tokenRef.current) return;
        setState({ status: 'err', svg: '', log: String(err) });
      }
    }, 250);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [cacheKey, block.raw, block.source, block.graphicEngine, activeProjectPath]);

  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #888)' }}>
          {block.graphicEngine === 'tikz' ? 'TikZ / PGFPlots' : 'graphic'}
        </div>
        <div
          onClick={(e) => { e.stopPropagation(); onJumpToSource(block); }}
          style={{ fontSize: '10px', color: 'var(--vscode-accent, #007acc)', cursor: 'pointer' }}
          title="Jump to source line"
        >
          jump to source →
        </div>
      </div>
      <div
        style={{
          padding: '8px',
          background: 'var(--editor-bg, #1e1e1e)',
          borderRadius: '3px',
          minHeight: '60px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
        }}
      >
        {state.status === 'loading' && (
          <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
            Rendering preview…
          </span>
        )}
        {state.status === 'err' && (
          <pre
            style={{
              margin: 0,
              fontSize: '10px',
              color: 'var(--vscode-errorForeground, #f48771)',
              maxHeight: '120px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              width: '100%',
            }}
            title={state.log}
          >
            {`Preview unavailable — ${state.log.split('\n').slice(-3).join('\n').trim()}`}
          </pre>
        )}
        {state.status === 'ok' && (
          <div
            // The backend returns trusted SVG produced by tectonic from the
            // user's own source. Using dangerouslySetInnerHTML avoids creating
            // an <img> round-trip and keeps the SVG resolution crisp at any
            // zoom level. The block is read-only, so no user input is rendered
            // as HTML here.
            dangerouslySetInnerHTML={{ __html: state.svg }}
            style={{ maxWidth: '100%' }}
          />
        )}
      </div>
    </NonEditableWrapper>
  );
}

function NonEditableWrapper({ block, onJumpToSource, children }) {
  return (
    <div
      onClick={() => onJumpToSource(block)}
      title="Click to jump to source"
      style={{
        position: 'relative',
        margin: '8px 0',
        padding: '8px 12px',
        background: 'var(--vscode-list-hoverBg, rgba(255,255,255,0.03))',
        border: '1px solid var(--vscode-widget-border, #2a2a2a)',
        borderRadius: '4px',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--vscode-accent, #007acc)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--vscode-widget-border, #2a2a2a)'; }}
    >
      <div style={{ position: 'absolute', top: '4px', right: '6px', display: 'flex', gap: '4px', alignItems: 'center' }}>
        <Lock size={10} style={{ color: 'var(--vscode-descriptionForeground, #888)' }} />
        <span style={{ fontSize: '9px', color: 'var(--vscode-descriptionForeground, #888)' }}>
          read-only
        </span>
      </div>
      {children}
    </div>
  );
}

function MathBlock({ block, onJumpToSource }) {
  // Render math via KaTeX through formatMessageContent
  const md = block.display ? `$$\n${block.math}\n$$` : `$${block.math}$`;
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <div style={{ padding: '4px 0', overflowX: 'auto' }}>
        {formatMessageContent(md)}
      </div>
    </NonEditableWrapper>
  );
}

// ── FigureBlock ────────────────────────────────────────────────────────────
//
// Renders a \\begin{figure} block that just embeds an image via
// \\includegraphics{...}. The source path is resolved by the backend
// (/api/latex/render-include), which:
//   - passes raster images (PNG/JPG/GIF/WEBP) through as-is
//   - rasterizes the first page of a PDF to a PNG payload
// This means users see a real preview of their figures without compiling
// the whole document, including the \includegraphics{../illustrations/x.pdf}
// case that previously 403'd on the /api/file/raw endpoint.
function FigureBlock({ block, activeProjectPath, onJumpToSource, sourceTex }) {
  const [state, setState] = useState({ status: 'idle', src: '', mime: '', svg: '', log: '' });
  const tokenRef = useRef(0);
  const raw = block.src || block.graphicSource || '';
  const isGraphicInput = !block.src && !!block.graphicSource;

  useEffect(() => {
    if (!raw.trim()) {
      setState({ status: 'idle', src: '', mime: '', svg: '', log: '' });
      return;
    }

    if (isGraphicInput) {
      tokenRef.current += 1;
      const myToken = tokenRef.current;

      setState({ status: 'loading', src: '', mime: '', svg: '', log: '' });
      fetch('/api/latex/render-graphic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graphic: block.graphicSource || '',
          projectPath: activeProjectPath || '',
          sourceTex: sourceTex || '',
          cacheKey: '',
          graphicEngine: block.graphicEngine || 'tikz',
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (myToken !== tokenRef.current) return;
          if (data && data.success && data.svg) {
            setState({ status: 'ok', src: '', mime: '', svg: data.svg, log: '' });
          } else {
            setState({ status: 'err', src: '', mime: '', svg: '', log: (data && data.log) || 'preview failed' });
          }
        })
        .catch((err) => {
          if (myToken !== tokenRef.current) return;
          setState({ status: 'err', src: '', mime: '', svg: '', log: String(err) });
        });
      return;
    }

    // URL-encode the path components for the query string.
    const params = new URLSearchParams({
      projectPath: activeProjectPath || '',
      filePath: raw,
    });
    if (sourceTex) params.set('sourceTex', sourceTex);
    const url = `/api/latex/render-include?${params.toString()}`;

    tokenRef.current += 1;
    const myToken = tokenRef.current;

    setState({ status: 'loading', src: '', mime: '', svg: '', log: '' });
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (myToken !== tokenRef.current) return;
        if (data && data.success && data.data_base64 && data.mime) {
          setState({
            status: 'ok',
            src: `data:${data.mime};base64,${data.data_base64}`,
            mime: data.mime,
            svg: '',
            log: '',
          });
        } else {
          setState({
            status: 'err',
            src: '',
            mime: '',
            svg: '',
            log: (data && (data.error || data.log)) || 'preview failed',
          });
        }
      })
      .catch((err) => {
        if (myToken !== tokenRef.current) return;
        setState({ status: 'err', src: '', mime: '', svg: '', log: String(err) });
      });
  }, [raw, activeProjectPath, sourceTex, isGraphicInput, block.graphicSource, block.graphicEngine]);

  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <figure style={{ margin: 0, textAlign: 'center' }}>
        {state.status === 'loading' && (
          <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', padding: '12px' }}>
            Loading image preview…
          </div>
        )}
        {state.status === 'ok' && state.svg && (
          <div
            dangerouslySetInnerHTML={{ __html: state.svg }}
            style={{ maxWidth: '100%' }}
          />
        )}
        {state.status === 'ok' && state.src && (
          <img
            src={state.src}
            alt={block.alt || ''}
            style={{ maxWidth: '100%', borderRadius: '4px' }}
          />
        )}
        {state.status === 'err' && (
          <div
            style={{
              padding: '8px',
              fontSize: '10px',
              color: 'var(--vscode-errorForeground, #f48771)',
              textAlign: 'left',
            }}
            title={state.log}
          >
            Image preview unavailable — {state.log}
          </div>
        )}
        {block.caption && (
          <figcaption style={{ fontSize: '11px', color: 'var(--chat-muted, #8a8a8a)', marginTop: '6px' }}>
            {block.caption}
          </figcaption>
        )}
        {block.label && (
          <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #888)' }}>
            [label:{block.label}]
          </div>
        )}
      </figure>
    </NonEditableWrapper>
  );
}

function TableBlock({ block, onJumpToSource }) {
  const table = useMemo(() => parseTablePreview(block), [block]);

  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      {block.caption && (
        <div style={{ fontSize: '11px', color: 'var(--chat-muted, #8a8a8a)', marginBottom: '8px', textAlign: 'center' }}>
          Table: {renderCellContent(block.caption)}
        </div>
      )}
      {table && table.rows.length ? (
        <div style={{ overflowX: 'auto', padding: '2px 0' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              tableLayout: 'auto',
              fontSize: '12px',
              lineHeight: '1.45',
              color: 'var(--chat-text, #cccccc)',
              background: 'var(--editor-bg, #1e1e1e)',
            }}
          >
            {table.header && (
              <thead>
                <LatexTableRow row={table.header} alignments={table.alignments} isHeader />
              </thead>
            )}
            <tbody>
              {table.bodyRows.map((row, rowIndex) => (
                <LatexTableRow
                  key={rowIndex}
                  row={row}
                  alignments={table.alignments}
                  isHeader={false}
                />
              ))}
            </tbody>
          </table>
          {block.label && (
            <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #888)', marginTop: '6px', textAlign: 'right' }}>
              [label:{block.label}]
            </div>
          )}
        </div>
      ) : (
        <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px', whiteSpace: 'pre-wrap' }}>
          {block.raw || block.source}
        </pre>
      )}
    </NonEditableWrapper>
  );
}

function LatexTableRow({ row, alignments, isHeader }) {
  const Cell = isHeader ? 'th' : 'td';
  const borderColor = 'var(--vscode-widget-border, #2a2a2a)';
  const topRule = row.rulesBefore.includes('toprule') || row.rulesBefore.includes('hline');
  const midRule = row.rulesBefore.includes('midrule');
  const bottomRule = row.rulesBefore.includes('bottomrule');

  return (
    <tr>
      {row.cells.map((cell, cellIndex) => (
        <Cell
          key={cellIndex}
          colSpan={cell.colSpan || 1}
          style={{
            padding: '6px 8px',
            textAlign: alignments[cellIndex] || 'left',
            fontWeight: isHeader ? 600 : 400,
            borderTop: topRule || midRule ? `1px solid ${borderColor}` : undefined,
            borderBottom: bottomRule || isHeader ? `1px solid ${borderColor}` : undefined,
            verticalAlign: 'top',
            whiteSpace: 'normal',
            wordBreak: 'break-word',
          }}
        >
          {renderCellContent(cell.text)}
        </Cell>
      ))}
    </tr>
  );
}

function parseTablePreview(block) {
  const tabular = block.tabular || extractTabularFromSource(block.source || block.raw || '');
  if (!tabular || !tabular.body) return null;

  const rows = splitLatexTableRows(tabular.body)
    .map(parseLatexTableRow)
    .filter(row => row.cells.length > 0);

  if (!rows.length) return null;

  const alignments = parseColumnAlignments(tabular.columnSpec || '');
  const hasHeaderRule = rows.length > 1 && rows[1].rulesBefore.some(rule => rule === 'hline' || rule === 'midrule');
  const hasTopRule = rows[0].rulesBefore.includes('toprule');
  const header = hasHeaderRule || hasTopRule ? rows[0] : null;
  const bodyRows = header ? rows.slice(1) : rows;

  return { alignments, header, bodyRows, rows };
}

function extractTabularFromSource(source) {
  const match = source.match(/\\begin\{tabular\*?\}/);
  if (!match) return null;
  const start = match.index;
  const endMatch = source.slice(start).match(/\\end\{tabular\*?\}/);
  if (!endMatch) return null;
  const raw = source.slice(start, start + endMatch.index + endMatch[0].length);
  const begin = raw.match(/^\\begin\{tabular\*?\}/);
  let cursor = begin ? begin[0].length : 0;
  const args = [];
  while (raw[cursor] === '{') {
    const close = findMatchingBraceInText(raw, cursor);
    if (close === -1) break;
    args.push(raw.slice(cursor + 1, close));
    cursor = close + 1;
    if (args.length >= 2) break;
  }
  const bodyEnd = raw.search(/\\end\{tabular\*?\}/);
  return {
    columnSpec: args[args.length - 1] || '',
    body: raw.slice(cursor, bodyEnd === -1 ? raw.length : bodyEnd),
  };
}

function splitLatexTableRows(body) {
  const rows = [];
  let depth = 0;
  let cursor = 0;
  let rowStart = 0;

  while (cursor < body.length) {
    const char = body[cursor];
    if (char === '{' && !isEscaped(body, cursor)) depth++;
    else if (char === '}' && !isEscaped(body, cursor) && depth > 0) depth--;
    else if (char === '\\' && body[cursor + 1] === '\\' && depth === 0) {
      rows.push(body.slice(rowStart, cursor));
      cursor += 2;
      if (body[cursor] === '[') {
        const optEnd = body.indexOf(']', cursor + 1);
        if (optEnd !== -1) cursor = optEnd + 1;
      }
      rowStart = cursor;
      continue;
    }
    cursor++;
  }

  rows.push(body.slice(rowStart));
  return rows;
}

function parseLatexTableRow(rowSource) {
  const rulesBefore = [];
  let cleaned = rowSource.trim();

  cleaned = cleaned.replace(/\\(toprule|midrule|bottomrule|hline)\b/g, (_, rule) => {
    rulesBefore.push(rule);
    return ' ';
  });
  cleaned = cleaned.replace(/\\cline\{[^}]*\}/g, () => {
    rulesBefore.push('hline');
    return ' ';
  });

  const cells = splitLatexCells(cleaned)
    .map(parseLatexCell)
    .filter(cell => cell.text.trim() || cell.colSpan > 1);

  return { rulesBefore, cells };
}

function splitLatexCells(rowSource) {
  const cells = [];
  let depth = 0;
  let cursor = 0;
  let cellStart = 0;

  while (cursor < rowSource.length) {
    const char = rowSource[cursor];
    if (char === '{' && !isEscaped(rowSource, cursor)) depth++;
    else if (char === '}' && !isEscaped(rowSource, cursor) && depth > 0) depth--;
    else if (char === '&' && !isEscaped(rowSource, cursor) && depth === 0) {
      cells.push(rowSource.slice(cellStart, cursor));
      cellStart = cursor + 1;
    }
    cursor++;
  }

  cells.push(rowSource.slice(cellStart));
  return cells;
}

function parseLatexCell(cellSource) {
  const trimmed = cellSource.trim();
  const multi = trimmed.match(/^\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}$/);
  if (multi) {
    return { text: normalizeLatexCellText(multi[2]), colSpan: Number(multi[1]) || 1 };
  }
  return { text: normalizeLatexCellText(trimmed), colSpan: 1 };
}

function normalizeLatexCellText(text) {
  return text
    .replace(/\\(centering|raggedright|raggedleft|arraybackslash)\b/g, '')
    .replace(/~+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseColumnAlignments(spec) {
  const alignments = [];
  let cursor = 0;

  while (cursor < spec.length) {
    const char = spec[cursor];
    if (char === 'l') alignments.push('left');
    else if (char === 'c') alignments.push('center');
    else if (char === 'r') alignments.push('right');
    else if ('pmbX'.includes(char) && spec[cursor + 1] === '{') {
      alignments.push('left');
      const close = findMatchingBraceInText(spec, cursor + 1);
      cursor = close === -1 ? cursor : close;
    } else if (char === '@' && spec[cursor + 1] === '{') {
      const close = findMatchingBraceInText(spec, cursor + 1);
      cursor = close === -1 ? cursor : close;
    }
    cursor++;
  }

  return alignments;
}

function renderCellContent(text) {
  return renderStyledLatexText(text || '');
}

function renderStyledLatexText(text) {
  return tokenizeInlineMath(text).map((token, index) => {
    if (token.type === 'text') {
      return <React.Fragment key={index}>{renderStyledTextOnly(token.value)}</React.Fragment>;
    }
    const html = renderKatexInline(token.value);
    if (!html) {
      return <React.Fragment key={index}>{token.raw}</React.Fragment>;
    }
    return (
      <span
        key={index}
        className="rich-text-inline-math"
        data-latex={token.raw}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  });
}

function renderStyledTextOnly(text) {
  const commandMatch = findFirstStyleCommand(text);
  if (!commandMatch) return stripSimpleLatexCommands(text);

  const before = text.slice(0, commandMatch.start);
  const inner = text.slice(commandMatch.contentStart, commandMatch.contentEnd);
  const after = text.slice(commandMatch.end);
  const style = {
    textbf: { fontWeight: 600 },
    textit: { fontStyle: 'italic' },
    emph: { fontStyle: 'italic' },
    texttt: { fontFamily: 'monospace' },
    textsc: { fontVariant: 'small-caps' },
    underline: { textDecoration: 'underline' },
  }[commandMatch.command] || {};

  return (
    <>
      {renderStyledTextOnly(before)}
      <span style={style}>{renderStyledTextOnly(inner)}</span>
      {renderStyledTextOnly(after)}
    </>
  );
}

function findFirstStyleCommand(text) {
  const re = /\\(textbf|textit|emph|texttt|textsc|underline)\{/g;
  const match = re.exec(text);
  if (!match) return null;
  const openBrace = match.index + match[0].length - 1;
  const closeBrace = findMatchingBraceInText(text, openBrace);
  if (closeBrace === -1) return null;
  return {
    command: match[1],
    start: match.index,
    contentStart: openBrace + 1,
    contentEnd: closeBrace,
    end: closeBrace + 1,
  };
}

function stripSimpleLatexCommands(text) {
  return text
    .replace(/\\(?:label|ref|cite|eqref)\{([^}]*)\}/g, '$1')
    .replace(/\\%/g, '%')
    .replace(/\\&/g, '&')
    .replace(/\\_/g, '_')
    .replace(/\\#/g, '#')
    .replace(/~/g, '\u00a0')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^}]*)\}/g, '$1')
    .replace(/\\([{}])/g, '$1');
}

function findMatchingBraceInText(text, openPos) {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === '{' && !isEscaped(text, i)) depth++;
    else if (text[i] === '}' && !isEscaped(text, i)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function CodeBlock({ block, onJumpToSource }) {
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      {block.lang && (
        <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '4px' }}>
          {block.lang}
        </div>
      )}
      <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '12px', lineHeight: '1.5', fontFamily: 'monospace', overflowX: 'auto', borderRadius: '3px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        <code>{block.raw}</code>
      </pre>
    </NonEditableWrapper>
  );
}

function EnvironmentBlock({ block, onJumpToSource }) {
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '4px' }}>
        environment: {block.envName}
      </div>
      <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px', whiteSpace: 'pre-wrap' }}>
        {block.raw || block.source}
      </pre>
    </NonEditableWrapper>
  );
}

function PreambleBlock({ block, onJumpToSource }) {
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #888)', marginBottom: '4px' }}>
        preamble
      </div>
      <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px', maxHeight: '120px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
        {block.raw || block.source}
      </pre>
    </NonEditableWrapper>
  );
}

function CommentBlock({ block }) {
  return (
    <div style={{ margin: '4px 0', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', fontStyle: 'italic' }}>
      {block.text}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline LaTeX renderer
//
// The previous implementation rendered \textbf{}, \textit{}, $...$ as styled
// HTML spans inside contentEditable blocks. This caused a critical bug:
// `e.currentTarget.textContent` on blur returned the *rendered* text (without
// LaTeX commands), corrupting the source even when the user didn't edit
// anything.
//
// Fix: editable blocks render inline math only while idle. On focus, the same
// block switches back to raw LaTeX so blur serialization preserves commands.
//
// Non-editable blocks (math display, figures, tables) still render via
// KaTeX/react-markdown since they are read-only and never serialized back.
// ─────────────────────────────────────────────────────────────────────────────
