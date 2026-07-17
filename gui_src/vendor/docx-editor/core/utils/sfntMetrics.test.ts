import { describe, expect, test } from 'bun:test';
import { readSfntSingleLineRatio } from './sfntMetrics';

describe('readSfntSingleLineRatio', () => {
  test('rejects truncated and oversized table directories', () => {
    expect(readSfntSingleLineRatio(new ArrayBuffer(4))).toBeNull();

    const oversized = new ArrayBuffer(12);
    new DataView(oversized).setUint16(4, 257, false);
    expect(readSfntSingleLineRatio(oversized)).toBeNull();
  });

  test('rejects table offsets outside the font buffer', () => {
    const buffer = new ArrayBuffer(28);
    const view = new DataView(buffer);
    view.setUint16(4, 1, false);
    for (const [index, char] of [...'head'].entries()) {
      view.setUint8(12 + index, char.charCodeAt(0));
    }
    view.setUint32(20, 1_000_000, false);
    view.setUint32(24, 20, false);

    expect(readSfntSingleLineRatio(buffer)).toBeNull();
  });
});
