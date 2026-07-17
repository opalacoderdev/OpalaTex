import type { Page } from '../pagination-model/types';
import type { HeaderFooterType, SectionProperties } from '../types/document';
import type { HeaderFooterContent } from './paintPage/headerFooter';

export interface PageFurniture {
  sectionIndex: number;
  sectionPageNumber: number;
  headerRId: string | null;
  footerRId: string | null;
  headerVariant: HeaderFooterType;
  footerVariant: HeaderFooterType;
  headerContent?: HeaderFooterContent;
  footerContent?: HeaderFooterContent;
  headerDistance: number;
  footerDistance: number;
  pageBorders?: SectionProperties['pageBorders'];
}

const furnitureByPage = new WeakMap<Page, PageFurniture>();

export function registerPageFurniture(page: Page, furniture: PageFurniture): void {
  furnitureByPage.set(page, furniture);
}

export function getPageFurniture(page: Page): PageFurniture | undefined {
  return furnitureByPage.get(page);
}
