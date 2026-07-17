export {
  createSelectionFromDOM,
  getSelectionRuns,
  type ClipboardSelection,
} from './managers/ClipboardManager';
export {
  AutoSaveManager,
  formatLastSaveTime,
  getAutoSaveStatusLabel,
  getAutoSaveStorageSize,
  formatStorageSize,
  isAutoSaveSupported,
} from './managers/AutoSaveManager';
export type { AutoSaveStatus, SavedDocumentData } from './managers/types';
export {
  TableSelectionManager,
  TABLE_DATA_ATTRIBUTES,
  findTableFromClick,
  getTableFromDocument,
  updateTableInDocument,
  deleteTableFromDocument,
} from './managers/TableSelectionManager';
export type { CellCoordinates } from './managers/types';
export { ErrorManager } from './managers/ErrorManager';
export type { ErrorNotification, ErrorSeverity } from './managers/types';
export { PluginLifecycleManager, injectStyles } from './managers/PluginLifecycleManager';
export {
  getDefaultPrintOptions,
  triggerPrint,
  openPrintWindow,
  parsePageRange,
  formatPageRange,
  isPrintSupported,
  type PrintOptions,
} from './utils/print';
export {
  createEmptyDocument,
  createDocumentWithText,
  type CreateEmptyDocumentOptions,
} from './utils/createDocument';
export type { Theme } from './types/document';
