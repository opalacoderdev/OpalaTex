import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldShowTexPdfOnly } from '../texViewMode.js';

test('opens .tex in PDF-only mode when preference is on and a compiled PDF exists', () => {
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: true, openTexInPdfView: 'on', hasPdf: true }),
    true,
  );
});

test('stays in code view when no compiled PDF exists yet', () => {
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: true, openTexInPdfView: 'on', hasPdf: false }),
    false,
  );
});

test('respects preference off unless the user explicitly requested PDF-only mode for that file', () => {
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: true, openTexInPdfView: 'off', hasPdf: true }),
    false,
  );
  assert.equal(
    shouldShowTexPdfOnly({
      isTexFile: true,
      openTexInPdfView: 'off',
      hasPdf: true,
      explicitMode: 'pdf',
    }),
    true,
  );
});

test('explicit code override exits PDF-only mode even when preference is on', () => {
  assert.equal(
    shouldShowTexPdfOnly({
      isTexFile: true,
      openTexInPdfView: 'on',
      hasPdf: true,
      explicitMode: 'code',
    }),
    false,
  );
});

test('compile error, Rich Text, WYSIWYG, Diff, or non-.tex files never show PDF-only mode', () => {
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: true, openTexInPdfView: 'on', hasPdf: true, hasCompileError: true }),
    false,
  );
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: true, openTexInPdfView: 'on', hasPdf: true, isRichTextMode: true }),
    false,
  );
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: true, openTexInPdfView: 'on', hasPdf: true, isWysiwygMode: true }),
    false,
  );
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: true, openTexInPdfView: 'on', hasPdf: true, isDiffMode: true }),
    false,
  );
  assert.equal(
    shouldShowTexPdfOnly({ isTexFile: false, openTexInPdfView: 'on', hasPdf: true }),
    false,
  );
});
