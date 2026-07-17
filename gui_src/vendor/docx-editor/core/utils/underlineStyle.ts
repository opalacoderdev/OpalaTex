import type { UnderlineStyle } from '../types/document';

export interface CssUnderlineStyle {
  decorationStyle?: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
  decorationThickness?: string;
}

/**
 * Map OOXML underline variants to browser text-decoration properties.
 */
export function underlineStyleToCss(style: UnderlineStyle | string | undefined): CssUnderlineStyle {
  switch (style) {
    case 'double':
      return { decorationStyle: 'double' };
    case 'dotted':
    case 'dottedHeavy':
      return {
        decorationStyle: 'dotted',
        ...(style === 'dottedHeavy' ? { decorationThickness: '2px' } : {}),
      };
    case 'dash':
    case 'dashedHeavy':
    case 'dashLong':
    case 'dashLongHeavy':
    case 'dotDash':
    case 'dashDotHeavy':
    case 'dotDotDash':
    case 'dashDotDotHeavy':
      return {
        decorationStyle: 'dashed',
        ...(style.endsWith('Heavy') ? { decorationThickness: '2px' } : {}),
      };
    case 'wave':
    case 'wavyHeavy':
    case 'wavyDouble':
      return {
        decorationStyle: 'wavy',
        ...(style !== 'wave' ? { decorationThickness: '2px' } : {}),
      };
    case 'thick':
      return { decorationThickness: '2px' };
    default:
      return {};
  }
}
