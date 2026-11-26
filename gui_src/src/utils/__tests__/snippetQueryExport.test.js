import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PDF_NOTE_MAX_CHARS,
  buildLookupMarkdown,
  buildLookupNoteText,
  formatLookupSource,
  normalizeLookupPath,
  slugifyQuestion,
  suggestLookupPath,
} from '../snippetQueryExport.js';

// i18next-shaped stand-in: the default value with {{name}} interpolated.
const t = (_key, fallback, values = {}) => (
  String(fallback).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values[name]))
);

const DATE = new Date(2026, 9, 23, 9, 5);

test('the note mirrors the server limit on annotation text', () => {
  assert.equal(PDF_NOTE_MAX_CHARS, 10000);
});

test('slugs fold accents instead of dropping the letters', () => {
  assert.equal(slugifyQuestion('Que tipo de floresta é a Amazônia?'), 'que-tipo-de-floresta-e-a-amazonia');
  assert.equal(slugifyQuestion('  ¿¡!!  '), '');
});

test('a long slug is cut at a word boundary', () => {
  const slug = slugifyQuestion('explain the difference between tropical and temperate rainforests in detail');
  assert.ok(slug.length <= 48);
  assert.ok(!slug.endsWith('-'));
  assert.equal(slug, 'explain-the-difference-between-tropical-and');
});

test('the suggested path is dated and lives under lookups/', () => {
  assert.equal(suggestLookupPath('What kind of forest?', DATE), 'lookups/2026-10-23-0905-what-kind-of-forest.md');
  assert.equal(suggestLookupPath('???', DATE), 'lookups/2026-10-23-0905-lookup.md');
});

test('a typed path is normalized to a project-relative .md path', () => {
  assert.equal(normalizeLookupPath('  notes\\answer  '), 'notes/answer.md');
  assert.equal(normalizeLookupPath('./a.md'), 'a.md');
  assert.equal(normalizeLookupPath('A.MD'), 'A.MD');
  assert.equal(normalizeLookupPath('   '), '');
  assert.equal(normalizeLookupPath('folder/'), '');
});

test('the source line names a page, a section, or the conversation', () => {
  assert.equal(formatLookupSource(t, { documentPath: 'main.pdf', page: 3, totalPages: 10 }), 'main.pdf, page 3 of 10');
  assert.equal(formatLookupSource(t, { documentPath: 'main.pdf', page: 3 }), 'main.pdf, page 3');
  assert.equal(formatLookupSource(t, { documentPath: 'notes.md', heading: 'Biomes' }), 'notes.md, section "Biomes"');
  assert.equal(formatLookupSource(t, { surface: 'chat' }), 'Conversation');
  assert.equal(formatLookupSource(t, {}), '');
});

test('the note carries the question and then the answer', () => {
  assert.equal(
    buildLookupNoteText(t, [{ question: ' What kind? ', answer: 'A rainforest.\n' }]),
    'Question: What kind?\n\nA rainforest.',
  );
});

test('the note keeps every question asked in the card, numbered and in order', () => {
  assert.equal(
    buildLookupNoteText(t, [
      { question: 'What kind?', answer: 'A rainforest.' },
      { question: 'How big?', answer: 'About 5.5 million km².' },
      { question: '   ', answer: '' },
    ]),
    'Question 1: What kind?\n\nA rainforest.\n\nQuestion 2: How big?\n\nAbout 5.5 million km².',
  );
});

test('the Markdown file quotes the excerpt and records where it came from', () => {
  const md = buildLookupMarkdown(t, {
    excerpt: 'The Amazon is the largest forest.\n\nSecond paragraph.',
    exchanges: [{
      question: 'What kind of forest is it?',
      answer: 'A **tropical rainforest**.',
      filesRead: ['main.tex'],
    }],
    source: { surface: 'pdf', documentPath: 'main.pdf', page: 2, totalPages: 9 },
    model: 'ollama/test',
    date: DATE,
  });
  assert.equal(md, [
    '# What kind of forest is it?',
    '',
    '- **Source:** main.pdf, page 2 of 9',
    '- **Date:** 2026-10-23 09:05',
    '- **Model:** ollama/test',
    '- **Files read:** `main.tex`',
    '',
    '## Excerpt',
    '',
    '> The Amazon is the largest forest.\n>\n> Second paragraph.',
    '',
    '## Question',
    '',
    'What kind of forest is it?',
    '',
    '## Answer',
    '',
    'A **tropical rainforest**.',
    '',
  ].join('\n'));
});

test('a truncated answer says so in the saved file', () => {
  const md = buildLookupMarkdown(t, {
    excerpt: 'x', exchanges: [{ question: 'y', answer: 'z', truncated: true }], date: DATE,
  });
  assert.match(md, /may be incomplete/);
});

test('the Markdown file keeps the whole history of questions, not only the last', () => {
  const md = buildLookupMarkdown(t, {
    excerpt: 'The Amazon is the largest forest.',
    exchanges: [
      { question: 'What kind of forest is it?', answer: 'A rainforest.', filesRead: ['main.tex', 'refs.bib'] },
      { question: 'How big is it?', answer: 'About 5.5 million km².', truncated: true, filesRead: ['main.tex'] },
    ],
    date: DATE,
  });
  assert.equal(md, [
    '# What kind of forest is it?',
    '',
    '- **Date:** 2026-10-23 09:05',
    '- **Files read:** `main.tex`, `refs.bib`',
    '',
    '## Excerpt',
    '',
    '> The Amazon is the largest forest.',
    '',
    '## Question 1',
    '',
    'What kind of forest is it?',
    '',
    '## Answer 1',
    '',
    'A rainforest.',
    '',
    '## Question 2',
    '',
    'How big is it?',
    '',
    '## Answer 2',
    '',
    'About 5.5 million km².',
    '',
    '_The answer reached the length limit and may be incomplete._',
    '',
  ].join('\n'));
});
