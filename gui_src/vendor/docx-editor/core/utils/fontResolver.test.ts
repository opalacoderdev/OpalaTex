import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveFontFamily,
  getGoogleFontEquivalent,
  registerDocumentFontSingleLineRatio,
  DEFAULT_SINGLE_LINE_RATIO,
} from './fontResolver';

describe('fontResolver — native CJK theme typefaces map to matched Noto webfonts', () => {
  // The names `applyThemeFontLang` writes into the empty `<a:ea>` slot are the
  // native typeface names from `theme1.xml`, not the romanized ones. Each must
  // resolve to a loadable Google (Noto) webfont so measurement and rendering
  // use the same font as Japanese already does.
  const cases: Array<[string, string]> = [
    // Simplified Chinese
    ['宋体', 'Noto Serif SC'],
    ['黑体', 'Noto Sans SC'],
    ['微软雅黑', 'Noto Sans SC'],
    ['等线', 'Noto Sans SC'],
    ['仿宋', 'Noto Serif SC'],
    ['楷体', 'Noto Serif SC'],
    // Traditional Chinese
    ['新細明體', 'Noto Serif TC'],
    ['細明體', 'Noto Serif TC'],
    ['微軟正黑體', 'Noto Sans TC'],
    ['標楷體', 'Noto Serif TC'],
    // Korean
    ['맑은 고딕', 'Noto Sans KR'],
    ['굴림', 'Noto Sans KR'],
    ['돋움', 'Noto Sans KR'],
    ['바탕', 'Noto Serif KR'],
    ['궁서', 'Noto Serif KR'],
  ];

  for (const [name, font] of cases) {
    test(`${name} → ${font}`, () => {
      const resolved = resolveFontFamily(name);
      expect(resolved.googleFont).toBe(font);
      expect(resolved.hasGoogleEquivalent).toBe(true);
      expect(getGoogleFontEquivalent(name)).toBe(font);
    });
  }
});

describe('fontResolver — document metrics survive duplicate bundles', () => {
  test('registers ratio through one copy and resolves it from another', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'font-resolver-dual-'));
    const entrypoint = join(import.meta.dir, 'fontResolver.ts');
    try {
      for (const name of ['copy-a.js', 'copy-b.js'] as const) {
        const result = await Bun.build({
          entrypoints: [entrypoint],
          outdir,
          target: 'bun',
          format: 'esm',
          naming: name,
        });
        expect(result.success).toBe(true);
      }

      const writer = (await import(join(outdir, 'copy-a.js'))) as typeof import('./fontResolver');
      const reader = (await import(join(outdir, 'copy-b.js'))) as typeof import('./fontResolver');

      expect(writer).not.toBe(reader);
      expect(reader.resolveFontFamily('Dual Bundle Font').singleLineRatio).toBe(
        DEFAULT_SINGLE_LINE_RATIO
      );

      writer.registerDocumentFontSingleLineRatio('Dual Bundle Font', 1.2);

      expect(reader.resolveFontFamily('Dual Bundle Font').singleLineRatio).toBe(1.2);
      expect(writer.resolveFontFamily('Dual Bundle Font').singleLineRatio).toBe(1.2);
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });

  test('registerDocumentFontSingleLineRatio updates resolveFontFamily in-process', () => {
    registerDocumentFontSingleLineRatio('In Process Metric Font', 1.2);
    expect(resolveFontFamily('In Process Metric Font').singleLineRatio).toBe(1.2);
  });
});
