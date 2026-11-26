/**
 * What a "Look up" card becomes when the user keeps it (§2.13.4): the excerpt
 * and every question asked about it in the card, each with its answer.
 *
 * The card itself is ephemeral; keeping an answer is always an explicit action,
 * either a note inside the PDF or a Markdown file in the project. Both shapes
 * are built here, as pure functions, so they can be tested without a browser.
 *
 * `t` is the i18n function: the saved file is written in the user's language,
 * like everything else the user reads.
 */

// Mirrors opalatex/pdf_annotations.MAX_CONTENT_CHARS. The server refuses a
// longer note with an error; the card disables the action up front and says
// why, instead of offering a button that can only fail.
export const PDF_NOTE_MAX_CHARS = 10000;

const pad = (value) => String(value).padStart(2, '0');

export function formatLookupTimestamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A filesystem-safe, ASCII slug of the question (accents folded, not dropped). */
export function slugifyQuestion(question, maxLength = 48) {
  const slug = String(question || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  const clipped = slug.slice(0, maxLength);
  // Cut at a word boundary when one is reasonably close, so the name stays readable.
  const lastDash = clipped.lastIndexOf('-');
  return (lastDash > maxLength / 2 ? clipped.slice(0, lastDash) : clipped).replace(/-+$/, '');
}

/** Project-relative path offered when saving: lookups/YYYY-MM-DD-HHMM-<slug>.md */
export function suggestLookupPath(question, date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slug = slugifyQuestion(question) || 'lookup';
  return `lookups/${stamp}-${slug}.md`;
}

/**
 * The path the user typed, as the write endpoint expects it: forward slashes,
 * no leading "./", always ending in .md. '' when nothing usable was typed.
 * Escaping the project is refused by the server, not guessed at here.
 */
export function normalizeLookupPath(input) {
  let path = String(input || '').trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (!path || path.endsWith('/')) return '';
  if (!path.toLowerCase().endsWith('.md')) path = `${path}.md`;
  return path;
}

/** Where the excerpt came from, as one localized line ('' when unknown). */
export function formatLookupSource(t, source = {}) {
  const document = source.documentPath || '';
  if (source.surface === 'chat') {
    return t('snippetQuery.sourceChat', 'Conversation');
  }
  if (!document) return '';
  if (source.page) {
    return source.totalPages
      ? t('snippetQuery.sourcePageOf', '{{document}}, page {{page}} of {{total}}', {
        document, page: source.page, total: source.totalPages,
      })
      : t('snippetQuery.sourcePage', '{{document}}, page {{page}}', { document, page: source.page });
  }
  if (source.heading) {
    return t('snippetQuery.sourceSection', '{{document}}, section "{{heading}}"', {
      document, heading: source.heading,
    });
  }
  return document;
}

/**
 * The exchanges of one look-up card, in the order they were asked: every
 * question that received an answer, each with its answer. Blank entries are
 * dropped so a stray call cannot write an empty "Question" heading.
 */
function answeredExchanges(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : [])
    .map((exchange) => ({
      question: String(exchange?.question || '').trim(),
      answer: String(exchange?.answer || '').trim(),
      truncated: Boolean(exchange?.truncated),
      filesRead: Array.isArray(exchange?.filesRead) ? exchange.filesRead : [],
    }))
    .filter((exchange) => exchange.question);
}

/**
 * The text stored in a PDF note: each question, then its answer. A card with
 * several questions numbers them so the note reads as the sequence it was.
 */
export function buildLookupNoteText(t, exchanges) {
  const items = answeredExchanges(exchanges);
  const numbered = items.length > 1;
  return items.map((exchange, index) => {
    const label = numbered
      ? t('snippetQuery.noteQuestionNumberedLabel', 'Question {{n}}', { n: index + 1 })
      : t('snippetQuery.noteQuestionLabel', 'Question');
    return `${label}: ${exchange.question}\n\n${exchange.answer}`;
  }).join('\n\n');
}

const quote = (text) => String(text || '')
  .trim()
  .split('\n')
  .map((line) => (line ? `> ${line}` : '>'))
  .join('\n');

/**
 * The Markdown document written by "Save as Markdown": the excerpt once, then
 * every question asked in the card with its answer, in order. A single
 * question keeps the plain "Question" / "Answer" headings; several are numbered.
 */
export function buildLookupMarkdown(t, {
  excerpt,
  exchanges = [],
  source = {},
  model = '',
  date = new Date(),
}) {
  const items = answeredExchanges(exchanges);
  const firstLine = (items[0]?.question || '').split('\n')[0];
  const title = firstLine.length > 90 ? `${firstLine.slice(0, 87).trimEnd()}...` : firstLine;
  const sourceLine = formatLookupSource(t, source);
  // Every file any answer relied on, once, in the order first read.
  const filesRead = [...new Set(items.flatMap((exchange) => exchange.filesRead))];

  const meta = [
    sourceLine ? `- **${t('snippetQuery.mdSource', 'Source')}:** ${sourceLine}` : '',
    `- **${t('snippetQuery.mdDate', 'Date')}:** ${formatLookupTimestamp(date)}`,
    model ? `- **${t('snippetQuery.mdModel', 'Model')}:** ${model}` : '',
    filesRead.length
      ? `- **${t('snippetQuery.mdFilesRead', 'Files read')}:** ${filesRead.map((f) => `\`${f}\``).join(', ')}`
      : '',
  ].filter(Boolean);

  const parts = [
    `# ${title}`,
    meta.join('\n'),
    `## ${t('snippetQuery.mdExcerpt', 'Excerpt')}`,
    quote(excerpt),
  ];
  const numbered = items.length > 1;
  items.forEach((exchange, index) => {
    const n = index + 1;
    parts.push(
      `## ${numbered
        ? t('snippetQuery.mdQuestionNumbered', 'Question {{n}}', { n })
        : t('snippetQuery.mdQuestion', 'Question')}`,
      exchange.question,
      `## ${numbered
        ? t('snippetQuery.mdAnswerNumbered', 'Answer {{n}}', { n })
        : t('snippetQuery.mdAnswer', 'Answer')}`,
      exchange.answer,
    );
    if (exchange.truncated) {
      parts.push(`_${t('snippetQuery.truncatedNotice', 'The answer reached the length limit and may be incomplete.')}_`);
    }
  });
  return `${parts.join('\n\n')}\n`;
}
