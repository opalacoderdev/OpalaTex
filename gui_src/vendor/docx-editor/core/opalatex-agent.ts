export { DocumentAgent, createAgent, createAgentFromDocument } from './agent/DocumentAgent';
export type {
  InsertTextOptions,
  InsertTableOptions,
  InsertImageOptions,
  InsertHyperlinkOptions,
  FormattedTextSegment,
} from './agent/DocumentAgent';
export type {
  ContentControlFilter,
  ContentControlInfo,
  ContentControlLocation,
  FindContentControlsOptions,
} from './agent/contentControls';
export { ContentControlNotFoundError } from './agent/contentControls';
export type { ContentControlValue } from './agent/contentControlValues';
