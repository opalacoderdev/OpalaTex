import { describe, expect, test } from 'bun:test';
import { sanitizeImageSrc } from '../sanitizeImageSrc';

describe('sanitizeImageSrc', () => {
  test('allows embedded image data and blob URLs', () => {
    expect(sanitizeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(sanitizeImageSrc(' blob:https://editor.test/asset-id ')).toBe(
      'blob:https://editor.test/asset-id'
    );
  });

  test('rejects remote and executable sources', () => {
    expect(sanitizeImageSrc('https://tracker.test/pixel.png')).toBeUndefined();
    expect(sanitizeImageSrc('http://tracker.test/pixel.png')).toBeUndefined();
    expect(sanitizeImageSrc('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeImageSrc('file:///etc/passwd')).toBeUndefined();
  });

  test('rejects non-image data URLs and empty values', () => {
    expect(sanitizeImageSrc('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(sanitizeImageSrc('')).toBeUndefined();
    expect(sanitizeImageSrc(undefined)).toBeUndefined();
  });
});
