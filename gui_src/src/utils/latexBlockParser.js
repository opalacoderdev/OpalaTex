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
//                            // 'environment' | 'preamble' | 'comment' |
//                            // 'titlepage' | 'maketitle' | 'abstract'
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
//     titleMeta?: object,    // \title/\author/\institute/\date extracted
//                            // from the preamble (for 'titlepage' blocks)
//   }
// ─────────────────────────────────────────────────────────────────────────────

let blockIdCounter = 0;
function nextId() { return `blk_${++blockIdCounter}`; }

const TABLE_ENV_NAMES = new Set([
  'tabular',
  'tabular*',
  'tabularx',
  'tabularx*',
  'tabulary',
  'tabulary*',
  'longtable',
  'longtable*',
]);

const TABLE_WRAPPER_ENV_NAMES = new Set([
  'center',
  'flushleft',
  'flushright',
]);

// Beamer environments that contain a nested sub-document (their body is
// parsed recursively via parseBody, same as the top-level document body).
// `frame` takes optional `[options]` then up to two brace args (title,
// subtitle). The titled boxes take exactly one mandatory `{title}` arg.
const TITLED_BOX_ENV_NAMES = new Set(['block', 'exampleblock', 'alertblock']);

/**
 * Parse LaTeX source into structured blocks with offsets.
 * @param {string} src - LaTeX source
 * @returns {Array} list of blocks
 */
export function parseLatexBlocks(src) {
  if (!src) return [];
  blockIdCounter = 0;
  const blocks = [];

  // ── Extract document body ────────────────────────────────────────────────
  const docStart = src.indexOf('\\begin{document}');
  const docEnd = src.indexOf('\\end{document}');
  let body, bodyOffset;
  let titleMeta;
  if (docStart !== -1) {
    const afterBegin = docStart + '\\begin{document}'.length;
    body = src.slice(afterBegin, docEnd !== -1 ? docEnd : src.length);
    bodyOffset = afterBegin;
    titleMeta = extractTitleMeta(src.slice(0, afterBegin));
    // Emit preamble as non-editable block
    if (docStart > 0) {
      const preambleSrc = src.slice(0, afterBegin);
      const summary = summarizePreamble(preambleSrc);
      blocks.push({
        id: nextId(),
        type: 'preamble',
        editable: false,
        start: 0,
        end: afterBegin,
        source: preambleSrc,
        raw: preambleSrc,
        documentClass: summary.documentClass,
        packageCount: summary.packageCount,
        visibleSource: summary.visibleSource,
      });
    }
  } else {
    body = src;
    bodyOffset = 0;
    titleMeta = extractTitleMeta(src);
  }

  blocks.push(...parseBody(body, bodyOffset, titleMeta));

  // ── Emit \end{document} as non-editable if present ───────────────────────
  if (docEnd !== -1) {
    blocks.push({
      id: nextId(),
      type: 'preamble',
      editable: false,
      postamble: true,
      start: docEnd,
      end: src.length,
      source: src.slice(docEnd),
      raw: src.slice(docEnd),
    });
  }

  return blocks;
}

/**
 * Tokenize a chunk of LaTeX body text into an ordered list of blocks, with
 * offsets expressed as absolute offsets into the *original* full source
 * (via `bodyOffset`). Used both for the top-level document body and,
 * recursively, for the body of container environments such as `frame`.
 * @param {string} body - LaTeX body text to tokenize
 * @param {number} bodyOffset - absolute offset of `body[0]` in the original source
 * @param {?object} titleMeta - `\title`/`\author`/... extracted from the
 *   preamble, threaded down so a nested `\titlepage` block can render it.
 * @returns {Array} list of blocks
 */
function parseBody(body, bodyOffset, titleMeta) {
  const blocks = [];

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
          const closeTagLen = ('\\end{' + envName + '}').length;

          // ── Beamer containers: frame, block, exampleblock, alertblock ────
          // These hold a nested sub-document (prose, lists, math, other
          // containers, ...), so their body is parsed recursively instead of
          // being dumped as a single read-only fallback block.
          if (envName === 'frame' || TITLED_BOX_ENV_NAMES.has(envName)) {
            const headerArgsStart = i + envMatch[0].length;
            const { options, braceArgs, cursor: contentStart } = parseContainerHeaderArgs(
              body, headerArgsStart, envName === 'frame', envName === 'frame' ? 2 : 1
            );
            const envBody = body.slice(contentStart, envEnd - closeTagLen);
            const childBodyOffset = bodyOffset + contentStart;
            blocks.push({
              id: nextId(),
              type: 'container',
              editable: true,
              containerKind: envName,
              envName,
              frameOptions: options,
              title: braceArgs[0] || '',
              subtitle: braceArgs[1] || '',
              titleEdited: false,
              start, end: finish,
              bodyStart: childBodyOffset,
              bodyEnd: bodyOffset + (envEnd - closeTagLen),
              source: envSource,
              children: parseBody(envBody, childBodyOffset, titleMeta),
            });
          } else {
            const envBodyOffset = bodyOffset + i + envMatch[0].length;
            const envBody = body.slice(i + envMatch[0].length, envEnd - closeTagLen);
            blocks.push(buildEnvironmentBlock(envName, envBody, envSource, start, finish, envBodyOffset, titleMeta));
          }
          i = envEnd;
          textBufStart = i;
          continue;
        }
      }
    }

    // ── Beamer frame title: \frametitle{...} ────────────────────────────────
    const ftMatch = body.slice(i).match(/^\\frametitle\s*(?:\[[^\]]*\]\s*)?\{/);
    if (ftMatch) {
      flushText();
      const openBrace = i + ftMatch[0].length - 1;
      const braceEnd = findMatchingBrace(body, openBrace);
      if (braceEnd !== -1) {
        const title = body.slice(openBrace + 1, braceEnd);
        const start = bodyOffset + i;
        const finish = bodyOffset + braceEnd + 1;
        blocks.push({
          id: nextId(),
          type: 'frametitle',
          editable: true,
          start, end: finish,
          source: body.slice(i, braceEnd + 1),
          text: title,
        });
        i = braceEnd + 1;
        textBufStart = i;
        continue;
      }
    }

    // ── Beamer title page: \titlepage ───────────────────────────────────────
    // Bare command, no args. Rendered as a preview card built from the
    // \title/\author/\institute/\date extracted from the preamble, instead
    // of leaking the literal `\titlepage` command as plain text.
    if (body.startsWith('\\titlepage', i) && !/[a-zA-Z]/.test(body[i + '\\titlepage'.length] || '')) {
      flushText();
      const cmdEnd = i + '\\titlepage'.length;
      const start = bodyOffset + i;
      const finish = bodyOffset + cmdEnd;
      blocks.push({
        id: nextId(),
        type: 'titlepage',
        editable: false,
        start, end: finish,
        source: body.slice(i, cmdEnd),
        titleMeta: titleMeta || null,
      });
      i = cmdEnd;
      textBufStart = i;
      continue;
    }

    // ── Document title: \maketitle ───────────────────────────────────────────
    // Bare command, no args. Rendered as a preview built from the
    // \title/\author/\date extracted from the preamble, instead of leaking
    // the literal `\maketitle` command as plain text.
    if (body.startsWith('\\maketitle', i) && !/[a-zA-Z]/.test(body[i + '\\maketitle'.length] || '')) {
      flushText();
      const cmdEnd = i + '\\maketitle'.length;
      const start = bodyOffset + i;
      const finish = bodyOffset + cmdEnd;
      blocks.push({
        id: nextId(),
        type: 'maketitle',
        editable: false,
        start, end: finish,
        source: body.slice(i, cmdEnd),
        titleMeta: titleMeta || null,
      });
      i = cmdEnd;
      textBufStart = i;
      continue;
    }

    // ── Sectioning commands ────────────────────────────────────────────────
    const secMatch = body.slice(i).match(/^(\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?)(\s*(?:\[[^\]]*\]\s*)?)\{/);
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
          // Keep the original command (including \chapter, a star, and an
          // optional short title) when an edited heading is written back.
          headingPrefix: body.slice(i, cmdEnd - 1),
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

  return blocks;
}

// ── Block builders ──────────────────────────────────────────────────────────

function buildEnvironmentBlock(envName, envBody, envSource, start, end, envBodyOffset, titleMeta) {
  const base = {
    id: nextId(),
    start, end,
    source: envSource,
    envName,
  };

  // ── Lists ────────────────────────────────────────────────────────────────
  // Each item's body is parsed recursively via parseBody (same as a
  // container's body), so nested lists/paragraphs/math inside a \item are
  // real blocks rather than opaque text — this lets a nested
  // \begin{itemize}...\end{itemize} render as an actual nested list instead
  // of leaking `\begin{itemize}`/`\item` markup as raw text.
  if (envName === 'itemize' || envName === 'enumerate' || envName === 'description') {
    return {
      ...base,
      type: 'list',
      editable: true,
      listType: envName,
      bodyStart: envBodyOffset,
      bodyEnd: envBodyOffset + envBody.length,
      items: parseListItems(envBody, envBodyOffset, titleMeta),
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

  // ── Abstract ─────────────────────────────────────────────────────────────
  // Parsed recursively (like a container's body) so its prose renders as a
  // real editable paragraph with a styled "Abstract" heading, instead of the
  // generic read-only environment fallback dumping raw `\begin{abstract}`
  // source.
  if (envName === 'abstract') {
    return {
      ...base,
      type: 'abstract',
      editable: true,
      bodyStart: envBodyOffset,
      bodyEnd: envBodyOffset + envBody.length,
      children: parseBody(envBody, envBodyOffset, titleMeta),
    };
  }

  if (TABLE_WRAPPER_ENV_NAMES.has(envName)) {
    const tableInfo = extractTableInfo(envBody);
    if (tableInfo.tabular) {
      return {
        ...base,
        type: 'table',
        editable: false,
        raw: envBody,
        caption: tableInfo.caption,
        label: tableInfo.label,
        tabular: tableInfo.tabular,
      };
    }
    // Not wrapping a table: this is a plain alignment wrapper. Parse its
    // body recursively (same as a container) instead of falling through to
    // the generic read-only environment block — a centered paragraph should
    // render as centered editable text, not raw `\begin{center}` markup.
    return {
      ...base,
      type: 'align',
      editable: true,
      align: envName,
      bodyStart: envBodyOffset,
      bodyEnd: envBodyOffset + envBody.length,
      children: parseBody(envBody, envBodyOffset, titleMeta),
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
    const inputMatch = envBody.match(/\\input\s*\{([^}]*)\}/);
    const capMatch = envBody.match(/\\caption\{([^}]*)\}/);
    const labMatch = envBody.match(/\\label\{([^}]*)\}/);

    // Detect inline graphic environments (tikzpicture, pgfplots, picture,
    // chemfig, forest, pstricks) embedded directly inside \begin{figure}.
    // This is the most common way users write TikZ — the entire graphic
    // source lives inside the figure body, not in a separate \input file.
    // We extract the full \begin{env}...\end{env} block so the backend can
    // compile it as-is.
    const inlineGraphicMatch = envBody.match(
      /\\begin\{(tikzpicture\*?|picture|chemfig|forest|pspicture)\}[\s\S]*?\\end\{\1\}/
    );

    return {
      ...base,
      type: 'figure',
      editable: false,
      src: imgMatch ? imgMatch[1] : '',
      inputSrc: !imgMatch && inputMatch ? inputMatch[1] : '',
      graphicSource: imgMatch
        ? ''
        : (inputMatch ? inputMatch[0] : (inlineGraphicMatch ? inlineGraphicMatch[0] : '')),
      graphicEngine: imgMatch
        ? ''
        : (inputMatch ? 'tikz' : (inlineGraphicMatch ? inlineGraphicMatch[1].replace('*', '') : '')),
      alt: capMatch ? capMatch[1] : '',
      caption: capMatch ? capMatch[1] : '',
      label: labMatch ? labMatch[1] : '',
    };
  }

  // ── Table (wrapping tabular) ─────────────────────────────────────────────
  if (envName === 'table' || envName === 'table*') {
    const tableInfo = extractTableInfo(envBody);
    return {
      ...base,
      type: 'table',
      editable: false,
      raw: envBody,
      caption: tableInfo.caption,
      label: tableInfo.label,
      tabular: tableInfo.tabular,
    };
  }

  // ── Bare tabular ─────────────────────────────────────────────────────────
  if (TABLE_ENV_NAMES.has(envName)) {
    const tabular = parseTabularSource(envSource);
    return {
      ...base,
      type: 'table',
      editable: false,
      raw: envBody,
      tabular,
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
    const absEnd = absStart + para.length; // full span, used to advance `cursor`

    // Skip pure whitespace
    if (!para.trim()) {
      cursor = absEnd;
      continue;
    }

    // Exclude a trailing run of whitespace that contains a newline from the
    // block's own editable span, leaving it as inter-block "gap" text
    // spliced verbatim from the source. Without this, a single newline
    // separating e.g. two consecutive `\item`s would live inside the
    // paragraph's editable text — and EditableLatexText's commit path
    // strips trailing newlines, silently gluing the edited item to the
    // next `\item` on save.
    const trailingWs = para.match(/\s+$/);
    const blockText = (trailingWs && trailingWs[0].includes('\n'))
      ? para.slice(0, para.length - trailingWs[0].length)
      : para;
    const blockEnd = absStart + blockText.length;

    // Check if it's a comment-only block
    const stripped = blockText.trim();
    if (stripped.startsWith('%') && !stripped.includes('\n')) {
      blocks.push({
        id: nextId(),
        type: 'comment',
        editable: false,
        start: absStart,
        end: blockEnd,
        source: blockText,
        text: stripped,
      });
    } else {
      blocks.push({
        id: nextId(),
        type: 'paragraph',
        editable: true,
        start: absStart,
        end: blockEnd,
        source: blockText,
        text: blockText,
      });
    }
    cursor = absEnd;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parses the header arguments right after `\begin{envName}` for a container
 * environment: an optional `[options]` group (only when `allowOptions` is
 * true, e.g. `\begin{frame}[fragile]`) followed by up to `maxBraceArgs`
 * consecutive `{...}` groups (e.g. `{Title}{Subtitle}`).
 * @returns {{options: string, braceArgs: string[], cursor: number}}
 */
function parseContainerHeaderArgs(body, cursor, allowOptions, maxBraceArgs) {
  let options = '';
  if (allowOptions && body[cursor] === '[') {
    const close = findMatchingBracket(body, cursor);
    if (close !== -1) {
      options = body.slice(cursor, close + 1);
      cursor = close + 1;
    }
  }
  const braceArgs = [];
  while (braceArgs.length < maxBraceArgs && body[cursor] === '{') {
    const close = findMatchingBrace(body, cursor);
    if (close === -1) break;
    braceArgs.push(body.slice(cursor + 1, close));
    cursor = close + 1;
  }
  return { options, braceArgs, cursor };
}

function findMatchingBracket(s, openPos) {
  // s[openPos] === '['
  let depth = 0;
  for (let i = openPos; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; } // skip escaped char
    if (s[i] === '[') depth++;
    else if (s[i] === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

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

/**
 * Extracts the `\title`/`\subtitle`/`\author`/`\institute`/`\date` metadata
 * declared in the preamble, so a `\titlepage` block in the document body can
 * render a preview instead of the literal command name. Returns `null` when
 * none of these commands are present (nothing to preview).
 * @param {string} preambleSrc - source text before `\begin{document}`
 * @returns {?{title: string, subtitle: string, author: string, institute: string, date: string}}
 */
function extractTitleMeta(preambleSrc) {
  const title = extractBraceCommandArg(preambleSrc, 'title');
  const subtitle = extractBraceCommandArg(preambleSrc, 'subtitle');
  const author = extractBraceCommandArg(preambleSrc, 'author');
  const institute = extractBraceCommandArg(preambleSrc, 'institute');
  const date = extractBraceCommandArg(preambleSrc, 'date');
  if (!title && !subtitle && !author && !institute && !date) return null;
  return { title, subtitle, author, institute, date };
}

/**
 * Summarizes the preamble for display in Rich Text mode: the document class
 * name, a count of loaded packages, and the preamble text with
 * `\documentclass` and `\usepackage` lines stripped out. The Rich Text
 * preview hides those boilerplate tags and shows a compact summary instead,
 * while any other preamble content (e.g. `\newcommand`, `\title`) remains in
 * `visibleSource` for context. The underlying `source`/`raw` fields are left
 * untouched, so nothing is lost when the block is serialized back.
 * @param {string} preambleSrc - source text from the start of the file up to
 *   and including `\begin{document}`
 * @returns {{documentClass: string, packageCount: number, visibleSource: string}}
 */
function summarizePreamble(preambleSrc) {
  const classMatch = preambleSrc.match(/\\documentclass\s*(?:\[[^\]]*\])?\{([^}]*)\}/);
  const packageMatches = preambleSrc.match(/\\usepackage\s*(?:\[[^\]]*\])?\{([^}]*)\}/g) || [];
  let packageCount = 0;
  for (const decl of packageMatches) {
    const argMatch = decl.match(/\{([^}]*)\}\s*$/);
    packageCount += argMatch ? argMatch[1].split(',').filter((s) => s.trim()).length : 0;
  }
  const visibleSource = preambleSrc
    .replace(/^[ \t]*\\documentclass\s*(?:\[[^\]]*\])?\{[^}]*\}[ \t]*\n?/gm, '')
    .replace(/^[ \t]*\\usepackage\s*(?:\[[^\]]*\])?\{[^}]*\}[ \t]*\n?/gm, '')
    .replace(/\\begin\{document\}\s*$/, '')
    .trim();
  return {
    documentClass: classMatch ? classMatch[1] : '',
    packageCount,
    visibleSource,
  };
}

// Finds the first `\name{...}` (optionally preceded by a `[short]` arg) in
// `source` and returns its brace argument, honoring nested braces.
function extractBraceCommandArg(source, name) {
  const re = new RegExp(`\\\\${name}\\s*(?:\\[[^\\]]*\\]\\s*)?\\{`);
  const match = source.match(re);
  if (!match) return '';
  const openBrace = match.index + match[0].length - 1;
  const closeBrace = findMatchingBrace(source, openBrace);
  if (closeBrace === -1) return '';
  return source.slice(openBrace + 1, closeBrace);
}

/**
 * Splits a list environment's body into top-level `\item` spans (skipping
 * `\item`s that belong to a nested environment) and recursively parses each
 * item's content into blocks via parseBody, so a nested list/paragraph/math
 * inside an item is real structure instead of opaque text.
 * @param {string} envBody - text between `\begin{itemize}` and `\end{itemize}`
 * @param {number} envBodyOffset - absolute offset of envBody[0] in the source
 * @param {?object} titleMeta - threaded down to nested `parseBody` calls
 * @returns {Array} list of `{ id, term, hasTerm, start, end, bodyStart, bodyEnd, children }`
 */
function parseListItems(envBody, envBodyOffset, titleMeta) {
  const len = envBody.length;
  const itemStarts = [];
  let i = 0;
  let depth = 0;

  while (i < len) {
    if (envBody.startsWith('\\begin{', i)) {
      const m = envBody.slice(i).match(/^\\begin\{[a-zA-Z*]+\}/);
      if (m) { depth++; i += m[0].length; continue; }
    }
    if (envBody.startsWith('\\end{', i)) {
      const m = envBody.slice(i).match(/^\\end\{[a-zA-Z*]+\}/);
      if (m) { depth--; i += m[0].length; continue; }
    }
    // Match `\item` as a whole command (not `\itemize`/`\itemsep`/...).
    if (depth === 0 && envBody.startsWith('\\item', i) && !/[a-zA-Z]/.test(envBody[i + 5] || '')) {
      itemStarts.push(i);
      i += 5;
      continue;
    }
    i++;
  }

  const items = [];
  for (let k = 0; k < itemStarts.length; k++) {
    const itemStart = itemStarts[k];
    const itemEnd = k + 1 < itemStarts.length ? itemStarts[k + 1] : len;
    let cursor = itemStart + '\\item'.length;

    // Optional `[term]` right after `\item`, used by description lists.
    let term = '';
    let hasTerm = false;
    if (envBody[cursor] === '[') {
      const close = findMatchingBracket(envBody, cursor);
      if (close !== -1) {
        term = envBody.slice(cursor + 1, close);
        cursor = close + 1;
        hasTerm = true;
      }
    }

    const bodyStart = cursor;
    const bodyEnd = itemEnd;
    items.push({
      id: nextId(),
      type: 'listitem',
      editable: true,
      term,
      hasTerm,
      start: envBodyOffset + itemStart,
      end: envBodyOffset + itemEnd,
      bodyStart: envBodyOffset + bodyStart,
      bodyEnd: envBodyOffset + bodyEnd,
      children: parseBody(envBody.slice(bodyStart, bodyEnd), envBodyOffset + bodyStart, titleMeta),
    });
  }
  return items;
}

function extractTableInfo(body) {
  const caption = (body.match(/\\caption\{([^}]*)\}/) || [])[1] || '';
  const label = (body.match(/\\label\{([^}]*)\}/) || [])[1] || '';
  const tabularSource = extractFirstTableEnvironmentSource(body);
  return {
    caption,
    label,
    tabular: tabularSource ? parseTabularSource(tabularSource) : null,
  };
}

function extractFirstTableEnvironmentSource(source) {
  const beginRe = /\\begin\{(tabular\*?|tabularx\*?|tabulary\*?|longtable\*?)\}/g;
  const match = beginRe.exec(source);
  if (!match) return '';
  const end = findEnvEnd(source, match.index, match[1]);
  if (end === -1) return '';
  return source.slice(match.index, end);
}

function parseTabularSource(source) {
  const beginMatch = source.match(/^\\begin\{(tabular\*?|tabularx\*?|tabulary\*?|longtable\*?)\}/);
  if (!beginMatch) return null;
  const envName = beginMatch[1];

  let cursor = beginMatch[0].length;
  const args = [];
  const maxArgs = (envName.startsWith('tabularx') || envName.startsWith('tabulary') || envName === 'tabular*')
    ? 2
    : 1;
  while (source[cursor] === '{') {
    const close = findMatchingBrace(source, cursor);
    if (close === -1) break;
    args.push(source.slice(cursor + 1, close));
    cursor = close + 1;
    if (args.length >= maxArgs) break;
  }

  const endRe = new RegExp(`\\\\end\\{${envName.replace('*', '\\*')}\\}\\s*$`);
  const endMatch = source.match(endRe);
  const bodyEnd = endMatch ? source.length - endMatch[0].length : source.length;
  return {
    columnSpec: args[args.length - 1] || '',
    body: source.slice(cursor, bodyEnd),
  };
}
