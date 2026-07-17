import type {
  Document,
  HeaderFooter,
  HeaderFooterType,
  SectionProperties,
} from '../types/document';

type HeaderFooterPosition = 'header' | 'footer';

export function updateSectionPropertiesAt(
  body: Document['package']['document'],
  sectionIndex: number,
  update: (properties: SectionProperties) => SectionProperties
): Document['package']['document'] {
  let breakSectionIndex = 0;
  const content = body.content.map((block) => {
    if (!('sectionProperties' in block) || !block.sectionProperties) return block;
    const current = breakSectionIndex++;
    return current === sectionIndex
      ? { ...block, sectionProperties: update(block.sectionProperties) }
      : block;
  });
  const sections = body.sections?.map((section, index) =>
    index === sectionIndex ? { ...section, properties: update(section.properties) } : section
  );
  // With a normalized `sections` array the final section is its last entry.
  // Without one, every inline sectPr ends a section, so the body-level final
  // sectPr follows all `breakSectionIndex` inline sections.
  const finalIndex = sections ? Math.max(0, sections.length - 1) : breakSectionIndex;
  return {
    ...body,
    content,
    sections,
    finalSectionProperties:
      sectionIndex === finalIndex && body.finalSectionProperties
        ? update(body.finalSectionProperties)
        : body.finalSectionProperties,
  };
}

function allocateEmptyStory(
  document: Document,
  position: HeaderFooterPosition,
  variant: HeaderFooterType
): {
  rId: string;
  story: HeaderFooter;
  relationships: NonNullable<Document['package']['relationships']>;
} {
  const pkg = document.package;
  let suffix = 1;
  let rId = `rId_removed_${position}_${variant}_${suffix}`;
  while (pkg.headers?.has(rId) || pkg.footers?.has(rId) || pkg.relationships?.has(rId)) {
    rId = `rId_removed_${position}_${variant}_${++suffix}`;
  }
  const usedTargets = new Set(
    Array.from(pkg.relationships?.values() ?? []).map((relationship) => relationship.target)
  );
  let targetNumber = 1;
  while (usedTargets.has(`${position}${targetNumber}.xml`)) targetNumber++;
  const relationships = new Map(pkg.relationships);
  relationships.set(rId, {
    id: rId,
    type: `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${position}`,
    target: `${position}${targetNumber}.xml`,
  });
  return {
    rId,
    relationships,
    story: {
      type: position,
      hdrFtrType: variant,
      content: [{ type: 'paragraph', content: [] }],
    },
  };
}

/**
 * Removes one section-local header/footer without allowing OOXML inheritance
 * to make a previous section's story reappear.
 *
 * Later sections receive an explicit empty story for the removed variant.
 * The first section can safely omit the reference because it has no predecessor.
 */
export function removeHeaderFooterForSection(
  document: Document,
  position: HeaderFooterPosition,
  sectionIndex: number,
  rId: string
): Document {
  const pkg = document.package;
  const refKey = position === 'header' ? 'headerReferences' : 'footerReferences';
  const mapKey = position === 'header' ? 'headers' : 'footers';
  const sectionProperties =
    pkg.document.sections?.[sectionIndex]?.properties ?? pkg.document.finalSectionProperties;
  const variant =
    sectionProperties?.[refKey]?.find((reference) => reference.rId === rId)?.type ??
    pkg[mapKey]?.get(rId)?.hdrFtrType ??
    'default';
  const empty = sectionIndex > 0 ? allocateEmptyStory(document, position, variant) : null;
  const update = (properties: SectionProperties): SectionProperties => ({
    ...properties,
    [refKey]: empty
      ? [
          ...(properties[refKey] ?? []).filter((reference) => reference.type !== variant),
          { type: variant, rId: empty.rId },
        ]
      : (properties[refKey] ?? []).filter((reference) => reference.rId !== rId),
  });
  const nextBody = updateSectionPropertiesAt(pkg.document, sectionIndex, update);
  const oldStoryStillReferenced =
    nextBody.content.some(
      (block) =>
        'sectionProperties' in block &&
        (block.sectionProperties?.[refKey] ?? []).some((reference) => reference.rId === rId)
    ) ||
    (nextBody.sections ?? []).some((section) =>
      (section.properties[refKey] ?? []).some((reference) => reference.rId === rId)
    ) ||
    (nextBody.finalSectionProperties?.[refKey] ?? []).some((reference) => reference.rId === rId);
  const stories = new Map(pkg[mapKey] ?? []);
  if (!oldStoryStillReferenced) stories.delete(rId);
  if (empty) stories.set(empty.rId, empty.story);
  const relationships = new Map(empty?.relationships ?? pkg.relationships);
  if (!oldStoryStillReferenced) relationships.delete(rId);

  return {
    ...document,
    package: {
      ...pkg,
      [mapKey]: stories,
      document: nextBody,
      relationships,
    },
  };
}
