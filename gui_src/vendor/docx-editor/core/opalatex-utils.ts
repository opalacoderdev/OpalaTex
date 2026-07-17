export {
  TWIPS_PER_INCH,
  PIXELS_PER_INCH,
  twipsToPixels,
  pixelsToTwips,
  emuToPixels,
  pixelsToEmu,
  emuToTwips,
  twipsToEmu,
  pointsToPixels,
  halfPointsToPixels,
  halfPointsToPoints,
  pointsToHalfPoints,
  eighthsToPixels,
  roundPixels,
  clamp,
  formatPx,
} from './utils/units';
export {
  resolveColor,
  resolveColorToHex,
  resolveHighlightColor,
  resolveShadingColor,
  isBlack,
  isWhite,
  getContrastingColor,
  parseColorString,
  createThemeColor,
  createRgbColor,
  darkenColor,
  lightenColor,
  blendColors,
  ensureHexPrefix,
  resolveHighlightToCss,
  getThemeTintShadeHex,
  generateThemeTintShadeMatrix,
  colorsEqual,
} from './utils/colorResolver';
export type { ThemeMatrixCell } from './utils/colorResolver';
export {
  INTERNAL_CLIPBOARD_TYPE,
  CLIPBOARD_TYPES,
  getClipboardImageFiles,
  copyRuns,
  copyParagraphs,
  runsToClipboardContent,
  paragraphsToClipboardContent,
  writeToClipboard,
  readFromClipboard,
  handlePasteEvent,
  parseClipboardHtml,
  isWordHtml,
  isEditorHtml,
  cleanWordHtml,
  htmlToRuns,
  createClipboardHandlers,
} from './utils/clipboard';
export type { ClipboardContent, ParsedClipboardContent, ClipboardOptions } from './utils/clipboard';
export { createEmptyDocument, createDocumentWithText } from './utils/createDocument';
export type { CreateEmptyDocumentOptions } from './utils/createDocument';
export { toArrayBuffer } from './utils/docxInput';
export type { DocxInput } from './utils/docxInput';
export {
  loadFont,
  loadFonts,
  loadFontFromBuffer,
  loadFontFromUrl,
  loadFontDefinitions,
  loadFontWithMapping,
  loadFontsWithMapping,
  preloadCommonFonts,
  loadDocumentFonts,
  isFontLoaded,
  setGoogleFontsEnabled,
  isGoogleFontsEnabled,
  isLoading,
  getLoadedFonts,
  onFontsLoaded,
  onFontError,
  canRenderFont,
  FONT_MAPPING,
  getGoogleFontEquivalent,
  extractFontsFromDocument,
} from './utils/fontLoader';
export type { FontDefinition } from './utils/fontLoader';
export { deobfuscateFont, isValidFontKey } from './utils/fontDeobfuscation';
export { getEmbeddedFontFaces, loadEmbeddedFonts, getEmbeddedFontFamilies } from './utils/embeddedFonts';
export type { EmbeddedFontFace } from './utils/embeddedFonts';
export {
  getRenderableDocumentFonts,
  selectRenderableFonts,
  excludeFontsByName,
} from './utils/documentPickerFonts';
export type { RenderableFontOptions } from './utils/documentPickerFonts';
export {
  textToStyle,
  paragraphToStyle,
  borderToStyle,
  resolveShadingFill,
  mergeStyles,
  tableCellToStyle,
  sectionToStyle,
} from './utils/formatToStyle';
export { collectHeadings } from './utils/headingCollector';
export type { HeadingInfo } from './utils/headingCollector';
export {
  createPageBreak,
  createColumnBreak,
  createLineBreak,
  createPageBreakRun,
  createPageBreakParagraph,
  insertPageBreak,
  createHorizontalRule,
  insertHorizontalRule,
  isPageBreak,
  isColumnBreak,
  isLineBreak,
  isBreakContent,
  hasPageBreakBefore,
  countPageBreaks,
  findPageBreaks,
  removePageBreak,
} from './utils/insertOperations';
export type { InsertPosition } from './utils/insertOperations';
export {
  isWordCharacter,
  isWhitespace,
  isPunctuation,
  findWordStart,
  findWordEnd,
  findNextWordStart,
  findPreviousWordStart,
  findVisualLineStart,
  findVisualLineEnd,
  getSelectionInfo,
  setSelectionPosition,
  extendSelectionTo,
  moveByWord,
  moveToLineEdge,
  parseNavigationAction,
  handleNavigationKey,
  isNavigationKey,
  getWordAtCursor,
  matchesShortcut,
  describeShortcut,
  getNavigationShortcutDescriptions,
  NAVIGATION_SHORTCUTS,
} from './utils/keyboardNavigation';
export type {
  NavigationDirection,
  NavigationUnit,
  NavigationAction,
  KeyboardShortcut,
} from './utils/keyboardNavigation';
export {
  DEFAULT_SELECTION_STYLE,
  HIGH_CONTRAST_SELECTION_STYLE,
  SELECTION_CSS_VARS,
  getSelectionGeometry,
  mergeAdjacentRects,
  getMergedSelectionGeometry,
  getHighlightRectStyle,
  generateSelectionCSS,
  hasActiveSelection,
  getSelectedText,
  isSelectionWithin,
  getSelectionBoundingRect,
  highlightTextRange,
  selectRange,
  clearSelection,
  isSelectionBackwards,
  normalizeSelectionDirection,
  injectSelectionStyles,
  removeSelectionStyles,
  areSelectionStylesInjected,
  createSelectionChangeHandler,
} from './utils/selectionHighlight';
export type { HighlightRect, SelectionHighlightConfig, SelectionRange } from './utils/selectionHighlight';
export {
  DEFAULT_PARAGRAPH_FLASH_COLOR,
  DEFAULT_PARAGRAPH_FLASH_DURATION_MS,
  PARAGRAPH_FLASH_CLASS_NAME,
  findParagraphBoxesByParaId,
  flashParagraphElements,
  flashParagraphBoxesByParaId,
} from './utils/paragraphFlash';
export type { ParagraphHighlightOptions, ScrollToParaIdOptions } from './utils/paragraphFlash';
export {
  sumColumnWidths,
  redistributeColumnWidths,
  computeSplitLayout,
  buildAnchorMaps,
  computeSplitDialogDefaults,
} from './utils/tableSplitAlgorithm';
export type { CellAnchor, SplitTarget, SplitLayoutResult } from './utils/tableSplitAlgorithm';
export {
  findWordBoundaries,
  findWordBoundariesForPointer,
  getWordAt,
  findWordAt,
  selectWordAtCursor,
  selectWordInTextNode,
  selectParagraphAtCursor,
  handleClickForMultiClick,
  createDoubleClickWordSelector,
  createTripleClickParagraphSelector,
} from './utils/textSelection';
export type { WordSelectionResult } from './utils/textSelection';
export {
  SIDEBAR_WIDTH,
  SIDEBAR_PAGE_GAP,
  SIDEBAR_DOCUMENT_SHIFT,
  MIN_CARD_GAP,
} from './utils/sidebarConstants';
export { readDocxFileFromInput } from './utils/readDocxFile';
export type { ReadDocxFileResult } from './utils/readDocxFile';
export { prefersColorSchemeDark, resolveIsDark, subscribeSystemDark } from './utils/colorMode';
export type { ColorMode } from './utils/colorMode';
export { sanitizeHref } from './utils/sanitizeHref';
export { sanitizeImageSrc } from './utils/sanitizeImageSrc';
