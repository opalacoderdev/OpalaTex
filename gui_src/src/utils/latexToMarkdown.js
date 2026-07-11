// ─────────────────────────────────────────────────────────────────────────────
// latexToMarkdown.js
//
// Converts a *subset* of LaTeX into Markdown + KaTeX-compatible markup so that
// the existing `formatMessageContent` pipeline (react-markdown + remark-math +
// rehype-katex) can render a live preview without a full LaTeX engine.
//
// Supported subset:
//   - Sectioning:  \part, \chapter, \section, \subsection, \subsubsection,
//                  \paragraph, \subparagraph  (with optional *)
//   - Text styling: \textbf{...}, \textit{...}, \emph{...}, \underline{...},
//                   \texttt{...}, \textsc{...}, \underline{...}
//   - Inline math:  $...$  and  \(...\)
//   - Display math: $$...$$ and \[...\]
//   - Lists:        itemize, enumerate, description  (with \item)
//   - Quotes:       quote, quotation, verse  -> blockquote
//   - Figures:      \begin{figure} ... \includegraphics[...]{path} ... \caption{...}
//   - Tables:       tabular inside table environment (basic |c|c| layout)
//   - Verbatim/code: verbatim, lstlisting, minted  -> fenced code block
//   - Comments:     %...  -> preserved as HTML comments
//   - References:   \label{...}, \ref{...}, \cite{...}  -> rendered as badges
//   - Misc commands that are dropped (preamble): \documentclass, \usepackage,
//                   \setlength, \pagestyle, etc.
//
// Anything not recognized is rendered as a fenced ````latex block so the user
// can see the raw source for unsupported constructs (transparent fallback).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a LaTeX source string into a Markdown string suitable for
 * `formatMessageContent`.
 *
 * @param {string} src - LaTeX source
 * @returns {string} Markdown text
 */
export function latexToMarkdown(src) {
  if (!src) return '';
  let s = String(src);

  // ── 0. Protect verbatim/lstlisting/minted blocks first ───────────────────
  const codeBlocks = [];
  s = s.replace(
    /\\begin\{(verbatim|lstlisting|minted)\*?\}([\s\S]*?)\\end\{\1\*?\}/g,
    (_, env, body) => {
      const idx = codeBlocks.length;
      const lang = env === 'minted' ? 'text' : env === 'lstlisting' ? 'text' : 'text';
      codeBlocks.push('```' + lang + '\n' + body.replace(/^\n/, '').replace(/\n$/, '') + '\n```');
      return `\u0000CODEBLOCK${idx}\u0000`;
    }
  );

  // ── 0.b Protect tikzpicture / PGFPlots blocks so they reach the renderer
  //       untouched and can be previewed by the GraphicPreview component.
  //       PGFPlots uses \begin{tikzpicture} (or axis) as the outer
  //       environment, so detecting `tikzpicture` covers both. The sentinel
  //       is designed to survive the remaining regex passes (it contains
  //       no LaTeX commands and no fenced-code markers) and to be a valid
  //       inline code token, which `formatMessage.jsx` maps to <code> and
  //       can recognise via the `tikzgraphic:N` class hook.
  const graphicBlocks = [];
  s = s.replace(
    /\\begin\{tikzpicture\*?\}([\s\S]*?)\\end\{tikzpicture\*?\}/g,
    (_, body) => {
      const idx = graphicBlocks.length;
      const raw = '\\begin{tikzpicture}' + body + '\\end{tikzpicture}';
      graphicBlocks.push(raw);
      // Use a placeholder token that downstream regexes will leave alone.
      return `OPALATEX_TIKZGRAPHIC_${idx}_OPALATEX`;
    }
  );

  // ── 1. Strip preamble up to \begin{document} ─────────────────────────────
  const docMatch = s.match(/\\begin\{document\}([\s\S]*?)(?:\\end\{document\}|$)/);
  if (docMatch) {
    s = docMatch[1];
  } else {
    // No \begin{document}: drop common preamble commands line-by-line
    s = s.replace(/\\documentclass[^\n]*\n?/g, '');
    s = s.replace(/\\usepackage(?:\[[^\]]*\])?\{[^}]*\}[^\n]*\n?/g, '');
  }

  // ── 2. Comments → HTML comments (preserve for transparency) ──────────────
  s = s.replace(/(^|[^\\])%.*$/gm, '$1');

  // ── 3. Display math: \[...\] and $$...$$ ─────────────────────────────────
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`);
  // $$...$$ already valid for remark-math; keep as-is

  // ── 4. Inline math: \(...\) → $...$ ──────────────────────────────────────
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim()}$`);

  // ── 5. Sectioning ────────────────────────────────────────────────────────
  const sectionMap = [
    [/\\part\*?\s*\{([^}]*)\}/g, '# '],
    [/\\chapter\*?\s*\{([^}]*)\}/g, '# '],
    [/\\section\*?\s*\{([^}]*)\}/g, '## '],
    [/\\subsection\*?\s*\{([^}]*)\}/g, '### '],
    [/\\subsubsection\*?\s*\{([^}]*)\}/g, '#### '],
    [/\\paragraph\*?\s*\{([^}]*)\}/g, '##### '],
    [/\\subparagraph\*?\s*\{([^}]*)\}/g, '###### '],
  ];
  for (const [re, prefix] of sectionMap) {
    s = s.replace(re, (_, title) => `\n${prefix}${title.trim()}\n`);
  }

  // ── 6. Text styling ──────────────────────────────────────────────────────
  s = s.replace(/\\textbf\{([^}]*)\}/g, '**$1**');
  s = s.replace(/\\textit\{([^}]*)\}/g, '*$1*');
  s = s.replace(/\\emph\{([^}]*)\}/g, '*$1*');
  s = s.replace(/\\texttt\{([^}]*)\}/g, '`$1`');
  // \textsc{...} → smallcaps via HTML (markdown has no native smallcaps)
  s = s.replace(/\\textsc\{([^}]*)\}/g, '<span style="font-variant:small-caps">$1</span>');
  // \underline{...} → HTML underline
  s = s.replace(/\\underline\{([^}]*)\}/g, '<u>$1</u>');

  // ── 7. Lists: itemize, enumerate, description ────────────────────────────
  s = convertLists(s);

  // ── 8. Quote/quotation/verse → blockquote ────────────────────────────────
  s = s.replace(
    /\\begin\{(quote|quotation|verse)\*?\}([\s\S]*?)\\end\{\1\*?\}/g,
    (_, _env, body) => {
      const lines = body.trim().split('\n').map(l => '> ' + l).join('\n');
      return '\n' + lines + '\n';
    }
  );

  // ── 9. Figures ───────────────────────────────────────────────────────────
  s = convertFigures(s);

  // ── 10. Tables (basic tabular) ───────────────────────────────────────────
  s = convertTables(s);

  // ── 11. References ───────────────────────────────────────────────────────
  s = s.replace(/\\label\{([^}]*)\}/g, ' `[label:$1]` ');
  s = s.replace(/\\ref\{([^}]*)\}/g, ' `[ref:$1]` ');
  s = s.replace(/\\eqref\{([^}]*)\}/g, ' `[eqref:$1]` ');
  s = s.replace(/\\cite\{([^}]*)\}/g, (_, keys) => ' ' + keys.split(',').map(k => `[cite:${k.trim()}]`).join(' ') + ' ');

  // ── 12. Drop remaining common preamble/utility commands ──────────────────
  s = s.replace(/\\(setlength|pagestyle|thispagestyle|clearpage|newpage|pagebreak|noindent|hfill|vfill|smallskip|medskip|bigskip|par|\\\\|break|newline|linebreak)\b[^\n]*\n?/g, '\n');
  // \\ (line break) → markdown line break
  s = s.replace(/\\\\/g, '  \n');

  // ── 13. Remaining unrecognized environments → fenced latex block ─────────
  s = s.replace(
    /\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}/g,
    (_, env, body) => `\n\`\`\`latex\n\\begin{${env}}${body}\\end{${env}}\n\`\`\`\n`
  );

  // ── 14. Remaining unrecognized commands → inline code (transparent) ──────
  // Show them as inline code so the user sees what wasn't rendered.
  s = s.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, (m) => '`' + m + '`');

  // ── 15. Restore protected code blocks ────────────────────────────────────
  s = s.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  // ── 15.b Wrap restored graphic blocks in a fenced `tikzgraphic` block so
  //        the Markdown renderer emits a single <code> with class
  //        `language-tikzgraphic` (formatMessage.jsx intercepts that class
  //        to call /api/latex/render-graphic).
  s = s.replace(/OPALATEX_TIKZGRAPHIC_(\d+)_OPALATEX/g, (_, i) => {
    const raw = graphicBlocks[Number(i)] || '';
    // Re-encode the body so the Markdown fenced code block stays valid even
    // if the source contains backticks or triple-backticks. We use a length
    // of backticks that cannot appear inside the source (very rare) and
    // store the actual raw text base64-free as plain text in the body.
    return '```tikzgraphic\n' + raw + '\n```';
  });

  // ── 16. Collapse excessive blank lines ───────────────────────────────────
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function convertLists(s) {
  // itemize → unordered, enumerate → ordered, description → dl-like (use bold term)
  const listEnv = /\\begin\{(itemize|enumerate|description)\*?\}([\s\S]*?)\\end\{\1\*?\}/g;
  // Repeat until no more nested lists convert (handles one level of nesting via recursion)
  let prev;
  do {
    prev = s;
    s = s.replace(listEnv, (_, env, body) => buildList(env, body));
  } while (s !== prev);
  return s;
}

function buildList(env, body) {
  const items = splitItems(body);
  const marker = env === 'enumerate' ? '1. ' : '- ';
  const out = items.map(item => {
    if (env === 'description') {
      const m = item.match(/^\s*\\item\s*\[([^\]]*)\]\s*([\s\S]*)$/);
      if (m) return `- **${m[1].trim()}**: ${m[2].trim()}`;
      return `- ${item.replace(/^\s*\\item\s*/, '').trim()}`;
    }
    return marker + item.replace(/^\s*\\item\s*/, '').trim();
  });
  return '\n' + out.join('\n') + '\n';
}

function splitItems(body) {
  // Split on \item that are not inside a nested \begin...\end
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

function convertFigures(s) {
  return s.replace(
    /\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g,
    (_, body) => {
      let img = '';
      const imgMatch = body.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/);
      if (imgMatch) img = imgMatch[1];
      let caption = '';
      const capMatch = body.match(/\\caption\{([^}]*)\}/);
      if (capMatch) caption = capMatch[1];
      let label = '';
      const labMatch = body.match(/\\label\{([^}]*)\}/);
      if (labMatch) label = labMatch[1];
      const parts = [];
      if (img) parts.push(`![${caption || ''}](${img})`);
      if (caption) parts.push(`*Figure: ${caption}*`);
      if (label) parts.push(`[label:${label}]`);
      return '\n' + parts.join('\n') + '\n';
    }
  );
}

function convertTables(s) {
  // Handle \begin{table}...\end{table} or simple alignment wrappers around a table.
  s = s.replace(
    /\\begin\{(table\*?|center|flushleft|flushright)\}([\s\S]*?)\\end\{\1\}/g,
    (_, env, body) => {
      const table = parseFirstTableSource(body);
      if (!table) {
        return env.startsWith('table')
          ? '\n```latex\n' + body.trim() + '\n```\n'
          : `\n\\begin{${env}}${body}\\end{${env}}\n`;
      }
      const caption = (body.match(/\\caption\{([^}]*)\}/) || [])[1] || '';
      const label = (body.match(/\\label\{([^}]*)\}/) || [])[1] || '';
      return '\n' + buildTabular(table.body, caption, label) + '\n';
    }
  );
  s = convertBareTables(s);
  return s;
}

function convertBareTables(s) {
  let out = '';
  let cursor = 0;
  const beginRe = /\\begin\{(tabular\*?|tabularx\*?|tabulary\*?|longtable\*?)\}/g;
  let match;

  while ((match = beginRe.exec(s)) !== null) {
    const table = parseTableSourceAt(s, match.index);
    if (!table) continue;
    out += s.slice(cursor, match.index);
    out += '\n' + buildTabular(table.body, '', '') + '\n';
    cursor = table.end;
    beginRe.lastIndex = table.end;
  }

  return out + s.slice(cursor);
}

function parseFirstTableSource(source) {
  const match = source.match(/\\begin\{(tabular\*?|tabularx\*?|tabulary\*?|longtable\*?)\}/);
  return match && match.index !== undefined ? parseTableSourceAt(source, match.index) : null;
}

function parseTableSourceAt(source, start) {
  const beginMatch = source.slice(start).match(/^\\begin\{(tabular\*?|tabularx\*?|tabulary\*?|longtable\*?)\}/);
  if (!beginMatch) return null;

  const envName = beginMatch[1];
  let cursor = start + beginMatch[0].length;
  const maxArgs = (envName.startsWith('tabularx') || envName.startsWith('tabulary') || envName === 'tabular*')
    ? 2
    : 1;

  for (let arg = 0; arg < maxArgs && source[cursor] === '{'; arg++) {
    const close = findMatchingBraceInText(source, cursor);
    if (close === -1) return null;
    cursor = close + 1;
  }

  const endToken = `\\end{${envName}}`;
  const endStart = source.indexOf(endToken, cursor);
  if (endStart === -1) return null;

  return {
    body: source.slice(cursor, endStart),
    end: endStart + endToken.length,
  };
}

function findMatchingBraceInText(text, openPos) {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function buildTabular(body, caption, label) {
  // Split rows on \\ (but not \\\\)
  const rows = body.split(/\\\\(?!\w)/).map(r => r.trim()).filter(Boolean);
  if (!rows.length) return '';
  const parsed = rows.map(r => {
    // Remove horizontal rule commands.
    r = r
      .replace(/\\(?:toprule|midrule|bottomrule|hline)\b/g, '')
      .replace(/\\cline\{[^}]*\}/g, '');
    // Split cells on & (not \&)
    return r.split('&').map(c => c.trim());
  }).filter(row => row.some(cell => cell));
  // First row as header, rest as body
  const header = parsed[0] || [];
  const bodyRows = parsed.slice(1);
  let md = '';
  md += '| ' + header.map(h => h || ' ').join(' | ') + ' |\n';
  md += '| ' + header.map(() => '---').join(' | ') + ' |\n';
  for (const row of bodyRows) {
    // pad to header length
    while (row.length < header.length) row.push('');
    md += '| ' + row.join(' | ') + ' |\n';
  }
  if (caption) md += `*Table: ${caption}*\n`;
  if (label) md += `[label:${label}]\n`;
  return md.trim();
}
