import type {
  Document,
  HeaderFooter,
  HeaderFooterType,
  SectionProperties,
} from '../types/document';
import { getMargins } from './sectionGeometry';

export type HeaderFooterRegion = 'header' | 'footer';

export interface ResolvedHeaderFooterPart {
  region: HeaderFooterRegion;
  variant: HeaderFooterType;
  rId: string | null;
  content: HeaderFooter | null;
}

export interface ResolvedPageHeaderFooter {
  pageNumber: number;
  sectionIndex: number;
  sectionPageNumber: number;
  sectionProperties: SectionProperties;
  header: ResolvedHeaderFooterPart;
  footer: ResolvedHeaderFooterPart;
  headerDistance: number;
  footerDistance: number;
  pageBorders: SectionProperties['pageBorders'];
}

function sectionPropertiesAt(doc: Document, sectionIndex: number): SectionProperties {
  const body = doc.package.document;
  return (
    body.sections?.[sectionIndex]?.properties ??
    body.finalSectionProperties ??
    body.sections?.[0]?.properties ??
    {}
  );
}

function variantForPage(
  properties: SectionProperties,
  pageNumber: number,
  sectionPageNumber: number
): HeaderFooterType {
  if (sectionPageNumber === 1 && properties.titlePg === true) return 'first';
  if (pageNumber % 2 === 0 && properties.evenAndOddHeaders === true) return 'even';
  return 'default';
}

function resolvePart(
  doc: Document,
  properties: SectionProperties,
  region: HeaderFooterRegion,
  variant: HeaderFooterType
): ResolvedHeaderFooterPart {
  const refs = region === 'header' ? properties.headerReferences : properties.footerReferences;
  const bag = region === 'header' ? doc.package.headers : doc.package.footers;
  let ref = refs?.find((entry) => entry.type === variant) ?? null;

  // Some producers author only a first-page part while leaving titlePg off.
  // Word treats that story as the ordinary header/footer in this shape.
  if (!ref && variant === 'default' && properties.titlePg !== true) {
    ref = refs?.find((entry) => entry.type === 'first') ?? null;
  }

  const rId = ref?.rId ?? null;
  return {
    region,
    variant,
    rId,
    content: rId ? (bag?.get(rId) ?? null) : null,
  };
}

/**
 * Resolve the exact header/footer stories and section furniture painted on one
 * physical page. Page parity is document-wide; "first" is section-local.
 *
 * @public
 */
export function resolvePageHeaderFooter(
  doc: Document,
  pageNumber: number,
  sectionIndex: number,
  sectionPageNumber: number
): ResolvedPageHeaderFooter {
  const sectionProperties = sectionPropertiesAt(doc, sectionIndex);
  const variant = variantForPage(sectionProperties, pageNumber, sectionPageNumber);
  const margins = getMargins(sectionProperties);

  return {
    pageNumber,
    sectionIndex,
    sectionPageNumber,
    sectionProperties,
    header: resolvePart(doc, sectionProperties, 'header', variant),
    footer: resolvePart(doc, sectionProperties, 'footer', variant),
    // getMargins uses nullish fallback, so explicit authored zero survives.
    headerDistance: margins.header ?? 48,
    footerDistance: margins.footer ?? 48,
    pageBorders: sectionProperties.pageBorders,
  };
}
