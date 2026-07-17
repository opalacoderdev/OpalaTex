import { describe, expect, test } from 'bun:test';
import { serializeDocumentBody } from '../docx/serializer/documentSerializer';
import type { Document, HeaderFooter, SectionProperties } from '../types/document';
import { removeHeaderFooterForSection } from './removeHeaderFooterForSection';

const sharedHeader: HeaderFooter = {
  type: 'header',
  hdrFtrType: 'default',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'run', content: [{ type: 'text', text: 'Shared header' }] }],
    },
  ],
};

function documentWithSharedSectionHeader(): Document {
  const first: SectionProperties = {
    headerReferences: [{ type: 'default', rId: 'rId-shared' }],
  };
  const second: SectionProperties = {
    headerReferences: [{ type: 'default', rId: 'rId-shared' }],
  };
  return {
    package: {
      document: {
        content: [
          { type: 'paragraph', content: [], sectionProperties: first },
          { type: 'paragraph', content: [] },
        ],
        sections: [
          { properties: first, content: [] },
          { properties: second, content: [] },
        ],
        finalSectionProperties: second,
      },
      headers: new Map([['rId-shared', sharedHeader]]),
      relationships: new Map([
        [
          'rId-shared',
          {
            id: 'rId-shared',
            type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
            target: 'header1.xml',
          },
        ],
      ]),
    },
  };
}

describe('removeHeaderFooterForSection', () => {
  test('removes an unreferenced first-section part and relationship together', () => {
    const input = documentWithSharedSectionHeader();
    input.package.document.sections = [input.package.document.sections![0]];
    input.package.document.finalSectionProperties = input.package.document.sections[0].properties;

    const result = removeHeaderFooterForSection(input, 'header', 0, 'rId-shared');

    expect(result.package.document.sections?.[0]?.properties.headerReferences).toEqual([]);
    expect(result.package.headers?.has('rId-shared')).toBe(false);
    expect(result.package.relationships?.has('rId-shared')).toBe(false);
    expect(serializeDocumentBody(result.package.document)).not.toContain('rId-shared');
  });

  test('retains a story referenced by another inline section property', () => {
    const input = documentWithSharedSectionHeader();
    const first = input.package.document.sections![0].properties;
    const second = input.package.document.sections![1].properties;
    input.package.document.sections = undefined;
    input.package.document.finalSectionProperties = undefined;
    input.package.document.content = [
      { type: 'paragraph', content: [], sectionProperties: first },
      { type: 'paragraph', content: [], sectionProperties: second },
    ];

    const result = removeHeaderFooterForSection(input, 'header', 0, 'rId-shared');

    expect(result.package.headers?.has('rId-shared')).toBe(true);
    expect(result.package.relationships?.has('rId-shared')).toBe(true);
    const secondRef = result.package.document.content[1];
    expect(
      'sectionProperties' in secondRef
        ? secondRef.sectionProperties?.headerReferences?.[0]?.rId
        : undefined
    ).toBe('rId-shared');
  });

  test('does not treat the final section as inline section zero without a sections array', () => {
    const input = documentWithSharedSectionHeader();
    const first = input.package.document.sections![0].properties;
    const final = input.package.document.sections![1].properties;
    input.package.document.sections = undefined;
    input.package.document.finalSectionProperties = final;
    input.package.document.content = [
      { type: 'paragraph', content: [], sectionProperties: first },
      { type: 'paragraph', content: [] },
    ];

    const result = removeHeaderFooterForSection(input, 'header', 0, 'rId-shared');

    expect(result.package.document.finalSectionProperties?.headerReferences?.[0]?.rId).toBe(
      'rId-shared'
    );
    expect(result.package.headers?.has('rId-shared')).toBe(true);
    expect(result.package.relationships?.has('rId-shared')).toBe(true);
  });

  test('keeps an explicit empty story when removing a later inherited variant', () => {
    const result = removeHeaderFooterForSection(
      documentWithSharedSectionHeader(),
      'header',
      1,
      'rId-shared'
    );
    const firstRef = result.package.document.sections?.[0]?.properties.headerReferences?.[0];
    const secondRef = result.package.document.sections?.[1]?.properties.headerReferences?.[0];

    expect(firstRef?.rId).toBe('rId-shared');
    expect(secondRef?.rId.startsWith('rId_removed_header_default_')).toBe(true);
    expect(result.package.headers?.get(secondRef!.rId)?.content).toEqual([
      { type: 'paragraph', content: [] },
    ]);

    const xml = serializeDocumentBody(result.package.document);
    expect(xml).toContain('r:id="rId-shared"');
    expect(xml).toContain(`r:id="${secondRef!.rId}"`);
  });
});
