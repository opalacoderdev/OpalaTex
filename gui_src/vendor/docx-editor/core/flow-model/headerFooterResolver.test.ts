import { describe, expect, test } from 'bun:test';
import type { Document, HeaderFooter, SectionProperties } from '../types/document';
import { resolvePageHeaderFooter } from './headerFooterResolver';

function story(type: 'header' | 'footer', text: string): HeaderFooter {
  return {
    type,
    hdrFtrType: 'default',
    content: [{ type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text }] }] }],
  };
}

function section(prefix: string, overrides: Partial<SectionProperties> = {}): SectionProperties {
  return {
    titlePg: true,
    evenAndOddHeaders: true,
    headerDistance: 0,
    footerDistance: 720,
    headerReferences: [
      { type: 'default', rId: `${prefix}-header-default` },
      { type: 'first', rId: `${prefix}-header-first` },
      { type: 'even', rId: `${prefix}-header-even` },
    ],
    footerReferences: [{ type: 'default', rId: `${prefix}-footer-default` }],
    ...overrides,
  };
}

function documentWithSections(): Document {
  const first = section('s1');
  const second = section('s2');
  const headers = new Map<string, HeaderFooter>();
  const footers = new Map<string, HeaderFooter>();
  for (const prefix of ['s1', 's2']) {
    headers.set(`${prefix}-header-default`, story('header', `${prefix} default`));
    headers.set(`${prefix}-header-first`, story('header', `${prefix} first`));
    headers.set(`${prefix}-header-even`, story('header', `${prefix} even`));
    footers.set(`${prefix}-footer-default`, story('footer', `${prefix} footer`));
  }
  return {
    package: {
      document: {
        content: [],
        sections: [
          { properties: first, content: [] },
          { properties: second, content: [] },
        ],
        finalSectionProperties: second,
      },
      headers,
      footers,
    },
  };
}

describe('resolvePageHeaderFooter', () => {
  test('uses section-local first pages and document-wide even-page parity', () => {
    const document = documentWithSections();

    const first = resolvePageHeaderFooter(document, 1, 0, 1);
    const even = resolvePageHeaderFooter(document, 2, 0, 2);
    const secondSectionFirst = resolvePageHeaderFooter(document, 3, 1, 1);
    const secondSectionDefault = resolvePageHeaderFooter(document, 5, 1, 2);

    expect(first.header.rId).toBe('s1-header-first');
    expect(even.header.rId).toBe('s1-header-even');
    expect(secondSectionFirst.header.rId).toBe('s2-header-first');
    expect(secondSectionDefault.header.rId).toBe('s2-header-default');
  });

  test('preserves explicit zero distance and resolves each section independently', () => {
    const document = documentWithSections();
    const first = resolvePageHeaderFooter(document, 1, 0, 1);
    const second = resolvePageHeaderFooter(document, 3, 1, 1);

    expect(first.headerDistance).toBe(0);
    expect(first.footerDistance).toBe(48);
    expect(first.header.content).toBe(document.package.headers?.get('s1-header-first') ?? null);
    expect(second.header.content).toBe(document.package.headers?.get('s2-header-first') ?? null);
  });

  test('uses a first-only story as default when title-page mode is disabled', () => {
    const properties = section('only', {
      titlePg: false,
      evenAndOddHeaders: false,
      headerReferences: [{ type: 'first', rId: 'only-header-first' }],
    });
    const document: Document = {
      package: {
        document: {
          content: [],
          sections: [{ properties, content: [] }],
          finalSectionProperties: properties,
        },
        headers: new Map([['only-header-first', story('header', 'fallback')]]),
      },
    };

    expect(resolvePageHeaderFooter(document, 1, 0, 1).header.rId).toBe('only-header-first');
  });
});
