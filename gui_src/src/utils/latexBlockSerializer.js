// ─────────────────────────────────────────────────────────────────────────────
// latexBlockSerializer.js
//
// Serializes Rich Text blocks back into LaTeX source. Used by the
// RichTextEditor to write edits back into the Monaco source via
// `setFileContent` with offset-based splicing.
//
// Only *editable* blocks are serialized (headings, paragraphs, lists, quotes).
// Non-editable blocks (math, figures, tables, code, environments) are kept
// as-is from their original `source` field — they are never modified by the
// Rich Text editor.
//
// Inline markup inside editable text is preserved as LaTeX commands:
//   **bold**   → \textbf{bold}
//   *italic*   → \textit{italic}
//   `code`     → \texttt{code}
//   $math$     → $math$  (kept as-is)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a single block back to LaTeX source.
 * @param {object} block - a block from parseLatexBlocks
 * @returns {string} LaTeX source for this block
 */
export function serializeBlock(block) {
  if (!block) return '';

  // Non-editable blocks: return original source unchanged
  if (!block.editable) {
    return block.source;
  }

  switch (block.type) {
    case 'heading':
      return serializeHeading(block);
    case 'paragraph':
      return serializeParagraph(block);
    case 'list':
      return serializeList(block);
    case 'quote':
      return serializeQuote(block);
    // 'graphic' (tikzpicture/PGFPlots) is non-editable; preserve source as-is.
    default:
      return block.source;
  }
}

/**
 * Given the full original source and a list of blocks (some possibly edited),
 * produce a new source string by splicing the serialized blocks into their
 * offset ranges.
 *
 * @param {string} originalSource - the original full LaTeX source
 * @param {Array} blocks - blocks from parseLatexBlocks (possibly with edits)
 * @returns {string} new LaTeX source with edits applied
 */
export function serializeDocument(originalSource, blocks) {
  if (!blocks || !blocks.length) return originalSource;

  // Sort blocks by start offset
  const sorted = [...blocks].sort((a, b) => a.start - b.start);

  let result = '';
  let cursor = 0;

  for (const block of sorted) {
    // Append any gap before this block (text between blocks that wasn't captured)
    if (block.start > cursor) {
      result += originalSource.slice(cursor, block.start);
    }
    // Append the serialized block
    result += serializeBlock(block);
    cursor = block.end;
  }

  // Append any trailing content
  if (cursor < originalSource.length) {
    result += originalSource.slice(cursor);
  }

  return result;
}

// ── Block serializers ───────────────────────────────────────────────────────

function serializeHeading(block) {
  const cmd = levelToCommand(block.level);
  return `${cmd}{${block.text}}`;
}

function serializeParagraph(block) {
  // The text field contains the edited paragraph text.
  // Inline markup is already in LaTeX form (we keep \textbf{}, \textit{}, etc.
  // as-is during editing — the RichTextEditor shows them as styled spans but
  // preserves the LaTeX commands in the text).
  return block.text;
}

function serializeList(block) {
  const env = block.listType;
  const lines = block.items.map(item => {
    if (env === 'description') {
      return `  \\item[${item.term || ''}] ${item.text}`;
    }
    return `  \\item ${item.text}`;
  });
  return `\\begin{${env}}\n${lines.join('\n')}\n\\end{${env}}`;
}

function serializeQuote(block) {
  const env = 'quote';
  return `\\begin{${env}}\n${block.text}\n\\end{${env}}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function levelToCommand(level) {
  const map = { 1: '\\section', 2: '\\section', 3: '\\subsection', 4: '\\subsubsection', 5: '\\paragraph', 6: '\\subparagraph' };
  return map[level] || '\\section';
}

/**
 * Convert inline Markdown-style markup (produced by the editable text fields)
 * back to LaTeX commands. This is used when the editable text field stores
 * content in a lightweight markup that the user sees as rendered text.
 *
 * Currently the RichTextEditor keeps LaTeX commands directly in the text,
 * so this is a no-op passthrough. It exists for future use if we switch to
 * a ProseMirror-based inline editor.
 */
export function inlineToLatex(text) {
  if (!text) return '';
  // Future: convert **bold** → \textbf{}, *italic* → \textit{}, etc.
  // For now, LaTeX commands are preserved as-is in the editable text.
  return text;
}