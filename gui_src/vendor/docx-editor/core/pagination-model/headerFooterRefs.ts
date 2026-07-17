/**
 * Header/footer relationship ids active for a section or page.
 *
 * @public
 */
export interface PageHeaderFooterRefs {
  headerDefault?: string;
  headerFirst?: string;
  headerEven?: string;
  footerDefault?: string;
  footerFirst?: string;
  footerEven?: string;
  /** `w:titlePg`; when true, the section's first page uses the first-page refs. */
  titlePg?: boolean;
}

/** @public */
export function selectHeaderFooterRefForPage(
  refs: PageHeaderFooterRefs,
  part: 'header' | 'footer',
  options: { isFirstOfSection: boolean; isEvenPage: boolean; evenAndOddHeaders: boolean }
): string | undefined {
  const prefix = part === 'header' ? 'header' : 'footer';
  if (options.isFirstOfSection && refs.titlePg) {
    return refs[`${prefix}First` as const];
  }
  if (options.evenAndOddHeaders && options.isEvenPage) {
    return refs[`${prefix}Even` as const];
  }
  return refs[`${prefix}Default` as const];
}
