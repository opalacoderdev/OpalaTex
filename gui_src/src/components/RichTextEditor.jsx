import React, { useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { parseLatexBlocks } from '../utils/latexBlockParser';
import { serializeDocument } from '../utils/latexBlockSerializer';
import { formatMessageContent } from '../utils/formatMessage';

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
//   - Inline LaTeX commands (\textbf{}, \textit{}, $...$) are kept inside the
//     editable text and rendered as styled spans via a lightweight renderer.
// ─────────────────────────────────────────────────────────────────────────────

export default function RichTextEditor({
  source,
  activeProjectPath,
  zoomLevel = 1.0,
  onChange,
  onJumpToSource,
}) {
  const { t } = useTranslation();
  const blocks = useMemo(() => parseLatexBlocks(source), [source]);
  const editingRef = useRef(null);

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
    const lines = source.slice(0, block.start).split('\n');
    const line = lines.length;
    onJumpToSource(line, block.start);
  }, [source, onJumpToSource]);

  return (
    <div
      className="rich-text-editor-container"
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
      {blocks.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          activeProjectPath={activeProjectPath}
          onBlockEdit={handleBlockEdit}
          onListItemEdit={handleListItemEdit}
          onJumpToSource={handleJumpToSource}
        />
      ))}
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

function BlockRenderer({ block, activeProjectPath, onBlockEdit, onListItemEdit, onJumpToSource }) {
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
      return <FigureBlock block={block} activeProjectPath={activeProjectPath} onJumpToSource={onJumpToSource} />;
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
  return (
    <div
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        const newText = e.currentTarget.textContent;
        if (newText !== block.text) onEdit(block.id, newText);
      }}
      style={{
        fontSize: sizes[block.level] || '18px',
        fontWeight: 'bold',
        color: 'var(--vscode-text-light, #ffffff)',
        margin: '16px 0 8px 0',
        outline: 'none',
        padding: '2px 4px',
        borderRadius: '3px',
        borderBottom: '1px solid transparent',
        whiteSpace: 'pre-wrap',
      }}
      onFocus={(e) => { e.currentTarget.style.borderBottom = '1px solid var(--vscode-accent, #007acc)'; }}
      onBlurCapture={(e) => { e.currentTarget.style.borderBottom = '1px solid transparent'; }}
    >
      {block.text}
    </div>
  );
}

function ParagraphBlock({ block, onEdit }) {
  return (
    <div
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        const newText = e.currentTarget.textContent;
        if (newText !== block.text) onEdit(block.id, newText);
      }}
      style={{
        margin: '6px 0',
        fontSize: '13px',
        lineHeight: '1.6',
        color: 'var(--chat-text, #cccccc)',
        outline: 'none',
        padding: '2px 4px',
        borderRadius: '3px',
        whiteSpace: 'pre-wrap',
      }}
      onFocus={(e) => { e.currentTarget.style.background = 'var(--vscode-list-hoverBg, rgba(255,255,255,0.04))'; }}
      onBlurCapture={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {block.text}
    </div>
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
              <span
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => {
                  const v = e.currentTarget.textContent;
                  if (v !== item.term) onItemEdit(block.id, i, 'term', v);
                }}
                style={{ fontWeight: 'bold', color: 'var(--vscode-text-light, #ffffff)', outline: 'none', whiteSpace: 'pre-wrap' }}
              >
                {item.term}
              </span>
              <span
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => {
                  const v = e.currentTarget.textContent;
                  if (v !== item.text) onItemEdit(block.id, i, 'text', v);
                }}
                style={{ outline: 'none', flex: 1, whiteSpace: 'pre-wrap' }}
              >
                {item.text}
              </span>
            </span>
          ) : (
            <span
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => {
                const v = e.currentTarget.textContent;
                if (v !== item.text) onItemEdit(block.id, i, 'text', v);
              }}
              style={{ outline: 'none', display: 'inline-block', width: '100%', whiteSpace: 'pre-wrap' }}
            >
              {item.text}
            </span>
          )}
        </li>
      ))}
    </ListTag>
  );
}

function QuoteBlock({ block, onEdit }) {
  return (
    <blockquote
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        const newText = e.currentTarget.textContent;
        if (newText !== block.text) onEdit(block.id, newText);
      }}
      style={{
        margin: '8px 0',
        paddingLeft: '12px',
        borderLeft: '3px solid var(--vscode-accent, #007acc)',
        color: 'var(--chat-muted, #8a8a8a)',
        fontSize: '13px',
        outline: 'none',
        padding: '4px 8px',
        whiteSpace: 'pre-wrap',
      }}
    >
      {block.text}
    </blockquote>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-editable blocks (rendered preview + jump to source)
// ─────────────────────────────────────────────────────────────────────────────

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

function FigureBlock({ block, activeProjectPath, onJumpToSource }) {
  let imgSrc = block.src;
  if (activeProjectPath && imgSrc && !imgSrc.startsWith('http') && !imgSrc.startsWith('data:')) {
    imgSrc = `/api/file/raw?projectPath=${encodeURIComponent(activeProjectPath)}&filePath=${encodeURIComponent(imgSrc)}`;
  }
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      <figure style={{ margin: 0, textAlign: 'center' }}>
        {imgSrc && (
          <img src={imgSrc} alt={block.alt || ''} style={{ maxWidth: '100%', borderRadius: '4px' }} />
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
  // Render the raw table source as a latex code block (simplified preview)
  return (
    <NonEditableWrapper block={block} onJumpToSource={onJumpToSource}>
      {block.caption && (
        <div style={{ fontSize: '11px', color: 'var(--chat-muted, #8a8a8a)', marginBottom: '6px' }}>
          *Table: {block.caption}*
        </div>
      )}
      <pre style={{ margin: 0, padding: '8px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', fontSize: '11px', overflowX: 'auto', borderRadius: '3px' }}>
        {block.raw || block.source}
      </pre>
    </NonEditableWrapper>
  );
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
// Inline LaTeX renderer — REMOVED
//
// The previous implementation rendered \textbf{}, \textit{}, $...$ as styled
// HTML spans inside contentEditable blocks. This caused a critical bug:
// `e.currentTarget.textContent` on blur returned the *rendered* text (without
// LaTeX commands), corrupting the source even when the user didn't edit
// anything.
//
// Fix: editable blocks now render the raw LaTeX text as-is. The user sees
// \textbf{bold} and $x^2$ in plain text while editing. This is the same
// approach as Overleaf's Rich Text beta for unsupported inline commands —
// they show the raw LaTeX in editable regions.
//
// Non-editable blocks (math display, figures, tables) still render via
// KaTeX/react-markdown since they are read-only and never serialized back.
// ─────────────────────────────────────────────────────────────────────────────