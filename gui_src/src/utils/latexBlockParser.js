// ─────────────────────────────────────────────────────────────────────────────
// latexBlockParser.js
//
// Parses a LaTeX source into an ordered list of *blocks*, where each block
// knows its character offset range in the original source. This enables the
// Overleaf-style Rich Text strategy:
//
//   - Editable blocks (prose): headings, paragraphs, lists, bold/italic
//     → user can edit text directly; changes are serialized back to LaTeX
//       and spliced into the source at the block's offset range.
//   - Non-editable blocks (complex): display math, tables, figures,
//     verbatim, unrecognized environments/macros
//     → rendered as read-only; click jumps to the corresponding source line
//       in Monaco.
//
// Each block has the shape:
//   {
//     id: string,            // stable id for React keys
//     type: string,          // 'heading' | 'paragraph' | 'list' | 'math' |
//                            // 'figure' | 'table' | 'code' | 'quote' |
//                            // 'environment' | 'preamble' | 'comment'
//     editable: boolean,     // whether the user can edit text in this block
//     start: number,         // char offset in original source (inclusive)
//     end: number,           // char offset in original source (exclusive)
//     source: string,        // raw source text for this block
//     // type-specific fields:
//     level?: number,        // heading level (1-6)
//     text?: string,         // editable text (for prose blocks)
//     items?: Array,         // list items
//     listType?: string,     // 'itemize' | 'enumerate' | 'description'
//     math?: string,         // math content (for math blocks)
//     display?: boolean,     // inline vs display math
//     alt?: string,          // figure alt/caption
//     src?: string,          // figure image path
//     caption?: string,      // table/figure caption
//     label?: string,        // \label value
//     lang?: string,         // code language
//     envName?: string,      // environment name (for fallback blocks)
//     raw?: string,          // raw rendered content (for fallback)
//   }
// ─────────────────────────────────────────────────────────────────────────────

let blockIdCounter = 0;
function nextId() { return `blk_${++blockIdCounter}`; }

/**
 * Parse LaTeX source into structured blocks with offsets.
 * @param {string} src - LaTeX source
 * @returns {Array} list of blocks
 */
export function parseLatexBlocks(src) {
  if (!src) return [];
  blockIdCounter = 0;
  const blocks = [];
  let pos = 0;

  // ── Extract document body ────────────────────────────────────────────────
  const docStart = src.indexOf('\\begin{document}');
  const docEnd = src.indexOf('\\end{document}');
  let body, bodyOffset;
  if (docStart !== -1) {
    const afterBegin = docStart + '\\begin{document}'.length;
    body = src.slice(afterBegin, docEnd !== -1 ? docEnd : src.length);
    bodyOffset = afterBegin;
    // Emit preamble as non-editable block
    if (docStart > 0) {
      blocks.push({
        id: nextId(),
        type: 'preamble',
        editable: false,
        start: 0,
        end: afterBegin,
        source: src.slice(0, afterBegin),
        raw: src.slice(0, afterBegin),
      });
    }
  } else {
    body = src;
    bodyOffset = 0;
  }

  // ── Tokenize body into top-level chunks ──────────────────────────────────
  // We scan for environments, display math, and commands that start blocks.
  const len = body.length;
  let i = 0;
  let textBuf = '';
  let textBufStart = 0;

  const flushText = () => {
    if (textBuf.trim()) {
      parseProseBlocks(blocks, textBuf, bodyOffset + textBufStart, bodyOffset + i);
    }
    textBuf = '';
    textBufStart = i;
  };

  while (i < len) {
    // ── Display math: \[...\] ─────────────────────────────────────────────
    if (body.startsWith('\\[', i)) {
      flushText();
      const end = findEnd(body, i, '\\]', '\\[');
      const start = bodyOffset + i;
      const finish = bodyOffset + end;
      blocks.push({
        id: nextId(),
        type: 'math',
        editable: false,
        display: true,
        start, end: finish,
        source: body.slice(i, end),
        math: body.slice(i + 2, end - 2).trim(),
      });
      i = end;
      textBufStart = i;
      continue;
    }

    // ── Display math: $$...$$ ─────────────────────────────────────────────
    if (body.startsWith('$$', i)) {
      flushText();
      const end = findDelim(body, i + 2, '$$');
      if (end !== -1) {
        const start = bodyOffset + i;
        const finish = bodyOffset + end + 2;
        blocks.push({
          id: nextId(),
          type: 'math',
          editable: false,
          display: true,
          start, end: finish,
          source: body.slice(i, end + 2),
          math: body.slice(i + 2, end).trim(),
        });
        i = end + 2;
        textBufStart = i;
        continue;
      }
    }

    // ── Environment: \begin{env}...\end{env} ───────────────────────────────
    if (body.startsWith('\\begin{', i)) {
      const envMatch = body.slice(i).match(/^\\begin\{([a-zA-Z*]+)\}/);
      if (envMatch) {
        const envName = envMatch[1];
        const envEnd = findEnvEnd(body, i, envName);
        if (envEnd !== -1) {
          flushText();
          const start = bodyOffset + i;
          const finish = bodyOffset + envEnd;
          const envSource = body.slice(i, envEnd);
          const envBody = body.slice(i + envMatch[0].length, envEnd - ('\\end{' + envName + '}').length);
          blocks.push(buildEnvironmentBlock(envName, envBody, envSource, start, finish));
          i = envEnd;
          textBufStart = i;
          continue;
        }
      }
    }

    // ── Sectioning commands ────────────────────────────────────────────────
    const secMatch = body.slice(i).match(/^(\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?)\s*\{/);
    if (secMatch) {
      flushText();
      const cmdEnd = i + secMatch[0].length;
      const braceEnd = findMatchingBrace(body, cmdEnd - 1);
      if (braceEnd !== -1) {
        const title = body.slice(cmdEnd, braceEnd);
        const start = bodyOffset + i;
        const finish = bodyOffset + braceEnd + 1;
        const level = sectionLevel(secMatch[1]);
        blocks.push({
          id: nextId(),
          type: 'heading',
          editable: true,
          start, end: finish,
          source: body.slice(i, braceEnd + 1),
          level,
          text: title,
        });
        i = braceEnd + 1;
        textBufStart = i;
        continue;
      }
    }

    // ── Accumulate prose ───────────────────────────────────────────────────
    textBuf += body[i];
    i++;
  }
  flushText();

  // ── Emit \end{document} as non-editable if present ───────────────────────
  if (docEnd !== -1) {
    blocks.push({
      id: nextId(),
      type: 'preamble',
      editable: false,
      start: docEnd,
      end: src.length,
      source: src.slice(docEnd),
      raw: src.slice(docEnd),
    });
  }

  return blocks;
}

// ── Block builders ──────────────────────────────────────────────────────────

function buildEnvironmentBlock(envName, envBody, envSource, start, end) {
  const base = {
    id: nextId(),
    start, end,
    source: envSource,
    envName,
  };

  // ── Lists ────────────────────────────────────────────────────────────────
  if (envName === 'itemize' || envName === 'enumerate' || envName === 'description') {
    const items = splitItems(envBody);
    return {
      ...base,
      type: 'list',
      editable: true,
      listType: envName,
      items: items.map(item => {
        const m = item.match(/^\s*\\item\s*(?:\[([^\]]*)\])?\s*([\s\S]*)$/);
        if (m) return { term: m[1] || '', text: m[2].trim() };
        return { term: '', text: item.replace(/^\s*\\item\s*/, '').trim() };
      }),
    };
  }

  // ── Quotes ───────────────────────────────────────────────────────────────
  if (envName === 'quote' || envName === 'quotation' || envName === 'verse') {
    return {
      ...base,
      type: 'quote',
      editable: true,
      text: envBody.trim(),
    };
  }

  // ── Math environments ────────────────────────────────────────────────────
  if (['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*'].includes(envName)) {
    return {
      ...base,
      type: 'math',
      editable: false,
      display: true,
      math: envBody.trim(),
    };
  }

  // ── Figure ───────────────────────────────────────────────────────────────
  if (envName === 'figure' || envName === 'figure*') {
    const imgMatch = envBody.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/);
    const capMatch = envBody.match(/\\caption\{([^}]*)\}/);
    const labMatch = envBody.match(/\\label\{([^}]*)\}/);
    return {
      ...base,
      type: 'figure',
      editable: false,
      src: imgMatch ? imgMatch[1] : '',
      alt: capMatch ? capMatch[1] : '',
      caption: capMatch ? capMatch[1] : '',
      label: labMatch ? labMatch[1] : '',
    };
  }

  // ── Table (wrapping tabular) ─────────────────────────────────────────────
  if (envName === 'table' || envName === 'table*') {
    return {
      ...base,
      type: 'table',
      editable: false,
      raw: envBody,
      caption: (envBody.match(/\\caption\{([^}]*)\}/) || [])[1] || '',
      label: (envBody.match(/\\label\{([^}]*)\}/) || [])[1] || '',
    };
  }

  // ── Bare tabular ─────────────────────────────────────────────────────────
  if (envName === 'tabular' || envName === 'tabular*') {
    return {
      ...base,
      type: 'table',
      editable: false,
      raw: envBody,
    };
  }

  // ── Code blocks ──────────────────────────────────────────────────────────
  if (envName === 'verbatim' || envName === 'lstlisting' || envName === 'minted') {
    let lang = '';
    if (envName === 'minted') {
      const m = envSource.match(/\\begin\{minted\}\{([^}]*)\}/);
      if (m) lang = m[1];
    } else if (envName === 'lstlisting') {
      const m = envSource.match(/\\begin\{lstlisting\}(?:\[language=([^,\]]*)\])?/);
      if (m) lang = m[1] || '';
    }
    return {
      ...base,
      type: 'code',
      editable: false,
      lang,
      raw: envBody,
    };
  }

  // ── Graphics: tikzpicture (covers plain TikZ + PGFPlots) ─────────────────
  // PGFPlots uses \begin{tikzpicture} (or \begin{axis}) as its outer
  // environment, so detecting `tikzpicture` is enough to cover both.
  // The RichTextEditor renders this block as an inline SVG preview by
  // calling the /api/latex/render-graphic backend endpoint.
  if (envName === 'tikzpicture' || envName === 'tikzpicture*') {
    return {
      ...base,
      type: 'graphic',
      editable: false,
      graphicEngine: 'tikz',
      raw: envSource,
    };
  }

  // ── Graphics: classic LaTeX picture environment ──────────────────────────
  // The old-school vector graphics env. Standalone class + tectonic can
  // compile it without extra packages, so it gets the same preview path
  // as TikZ.
  if (envName === 'picture') {
    return {
      ...base,
      type: 'graphic',
      editable: false,
      graphicEngine: 'picture',
      raw: envSource,
    };
  }

  // ── Graphics: chemfig (chemistry diagrams built on top of TikZ) ─────────
  // chemfig is normally loaded with \usepackage{chemfig}. We can't know
  // whether the user has it, but the worst case is a compile error in the
  // preview — falling back to the environment block view. We always treat
  // it as a graphic so the preview pipeline is exercised.
  if (envName === 'chemfig') {
    return {
      ...base,
      type: 'graphic',
      editable: false,
      graphicEngine: 'chemfig',
      raw: envSource,
    };
  }

  // ── Graphics: PSTricks environments ─────────────────────────────────────
  // pspicture / psgraph. These rely on PSTricks, which tectonic does NOT
  // support by default. We still classify them as graphics so the UI shows
  // a single consistent card, and the backend will surface a clear error
  // log in the preview if the packages are missing.
  if (envName === 'pspicture' || envName === 'psgraph') {
    return {
      ...base,
      type: 'graphic',
      editable: false,
      graphicEngine: 'pstricks',
      raw: envSource,
    };
  }

  // ── Graphics: flowchart / tree-drawing macros (forest, tikz-cd) ─────────
  // These wrap tikzpicture internally; treating them as graphics lets the
  // backend compile them and surface any missing-package errors cleanly.
  if (envName === 'forest' || envName === 'tikzmatrix' || envName === 'tikz-cd') {
    return {
      ...base,
      type: 'graphic',
      editable: false,
      graphicEngine: 'tikz',
      raw: envSource,
    };
  }

  // ── Fallback: unrecognized environment ───────────────────────────────────
  return {
    ...base,
    type: 'environment',
    editable: false,
    raw: envSource,
  };
}

// ── Prose splitting ─────────────────────────────────────────────────────────
//
// Takes a chunk of text (between environments/math) and splits it into
// paragraph blocks. Inline math ($...$) and inline commands (\textbf{...})
// are kept inside the paragraph text as markup — the RichTextEditor handles
// them as inline spans.

function parseProseBlocks(blocks, text, startOffset, endOffset) {
  // Split on blank lines (paragraph breaks)
  const paragraphs = text.split(/\n\s*\n/);
  let cursor = startOffset;
  for (const para of paragraphs) {
    // Find the actual position of this paragraph in the text
    const paraStart = text.indexOf(para, cursor - startOffset);
    const absStart = startOffset + paraStart;
    const absEnd = absStart + para.length;

    // Skip pure whitespace
    if (!para.trim()) {
      cursor = absEnd;
      continue;
    }

    // Check if it's a comment-only block
    const stripped = para.trim();
    if (stripped.startsWith('%') && !stripped.includes('\n')) {
      blocks.push({
        id: nextId(),
        type: 'comment',
        editable: false,
        start: absStart,
        end: absEnd,
        source: para,
        text: stripped,
      });
    } else {
      blocks.push({
        id: nextId(),
        type: 'paragraph',
        editable: true,
        start: absStart,
        end: absEnd,
        source: para,
        text: para,
      });
    }
    cursor = absEnd;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sectionLevel(cmd) {
  const map = {
    '\\part': 1, '\\chapter': 1,
    '\\section': 2, '\\subsection': 3, '\\subsubsection': 4,
    '\\paragraph': 5, '\\subparagraph': 6,
  };
  const base = cmd.replace('*', '');
  return map[base] || 2;
}

function findEnd(s, start, endDelim, openDelim) {
  // Find endDelim after start, accounting for nesting of openDelim
  let depth = 1;
  let i = start + openDelim.length;
  while (i < s.length) {
    if (s.startsWith(openDelim, i)) { depth++; i += openDelim.length; continue; }
    if (s.startsWith(endDelim, i)) { depth--; if (depth === 0) return i + endDelim.length; i += endDelim.length; continue; }
    i++;
  }
  return s.length;
}

function findDelim(s, start, delim) {
  let i = start;
  while (i < s.length) {
    if (s.startsWith(delim, i)) return i;
    if (s[i] === '\\') i++; // skip escaped
    i++;
  }
  return -1;
}

function findEnvEnd(s, start, envName) {
  const open = `\\begin{${envName}}`;
  const close = `\\end{${envName}}`;
  let depth = 1;
  let i = start + open.length;
  while (i < s.length) {
    if (s.startsWith(open, i)) { depth++; i += open.length; continue; }
    if (s.startsWith(close, i)) { depth--; if (depth === 0) return i + close.length; i += close.length; continue; }
    i++;
  }
  return -1;
}

function findMatchingBrace(s, openPos) {
  // s[openPos] === '{'
  let depth = 0;
  for (let i = openPos; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
    else if (s[i] === '\\') i++; // skip next char (escaped)
  }
  return -1;
}

function splitItems(body) {
  const items = [];
  let depth = 0;
  let buf = '';
  const tokens = body.split(/(\\item|\\begin\{|\\end\{)/);
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk === '\\item' && depth === 0) {
      if (buf.trim()) items.push(buf);
      buf = '';
    } else if (tk === '\\begin{') {
      depth++;
      buf += tk + (tokens[++i] || '');
    } else if (tk === '\\end{') {
      depth--;
      buf += tk + (tokens[++i] || '');
    } else {
      buf += tk;
    }
  }
  if (buf.trim()) items.push(buf);
  return items;
}