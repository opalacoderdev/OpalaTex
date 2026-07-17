import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { paintTextRun } from '../renderParagraph/runs';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('comment highlight paint', () => {
  test('uses shared subtle comment tokens by default', () => {
    const el = paintTextRun(
      {
        kind: 'text',
        text: 'commented',
        commentIds: [7],
      },
      document
    );

    expect(el.dataset.commentId).toBe('7');
    expect(el.style.backgroundColor).toBe('var(--doc-comment-bg)');
    expect(el.style.borderBottomWidth).toBe('2px');
    expect(el.style.borderBottomStyle).toBe('solid');
    expect(el.style.borderBottomColor).toBe('var(--doc-comment-border)');
  });

  test('does not paint resolved comments', () => {
    const el = paintTextRun(
      {
        kind: 'text',
        text: 'resolved',
        commentIds: [7],
      },
      document,
      new Set([7])
    );

    expect(el.dataset.commentId).toBeUndefined();
    expect(el.style.backgroundColor).toBe('');
    expect(el.style.borderBottom).toBe('');
  });
});
