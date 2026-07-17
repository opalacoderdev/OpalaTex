import { describe, expect, test } from 'bun:test';
import { underlineStyleToCss } from '../underlineStyle';

describe('underlineStyleToCss', () => {
  test('maps OOXML wave underline to CSS wavy decoration', () => {
    expect(underlineStyleToCss('wave')).toEqual({ decorationStyle: 'wavy' });
  });

  test('maps OOXML thick underline to CSS decoration thickness', () => {
    expect(underlineStyleToCss('thick')).toEqual({ decorationThickness: '2px' });
  });

  test('maps heavy wave underline to wavy plus thickness', () => {
    expect(underlineStyleToCss('wavyHeavy')).toEqual({
      decorationStyle: 'wavy',
      decorationThickness: '2px',
    });
  });
});
