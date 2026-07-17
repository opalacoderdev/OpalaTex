import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { paintLine } from '../renderParagraph';
import type { MeasuredLine, ParagraphBlock } from '../../pagination-model/types';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('paintLine — positional tab leaders', () => {
  test('renders w:ptab right-margin dot leaders between label and page number', () => {
    const block: ParagraphBlock = {
      kind: 'paragraph',
      id: 'p1',
      runs: [
        { kind: 'text', text: 'Chapter 1: Introduction', fontSize: 11, fontFamily: 'Calibri' },
        {
          kind: 'tab',
          positional: { alignment: 'right', relativeTo: 'margin', leader: 'dot' },
          fontSize: 11,
          fontFamily: 'Calibri',
        },
        { kind: 'text', text: '1', fontSize: 11, fontFamily: 'Calibri' },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 2,
      toChar: 1,
      width: 0,
      ascent: 12,
      descent: 3,
      lineHeight: 16,
    };

    const el = paintLine(block, line, undefined, document, {
      availableWidth: 640,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      lineRightEdgePx: 640,
    });
    const tab = el.querySelector<HTMLElement>('.layout-run-tab');

    expect(el.dataset.flexLine).toBe('true');
    expect(tab).toBeTruthy();
    expect(tab!.style.flex).toBe('1 1 0px');
    expect(tab!.textContent).toContain('................');
    expect(el.textContent).toContain('Chapter 1: Introduction');
    expect(el.textContent).toContain('1');
  });
});
