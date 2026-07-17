/**
 * Tracked-change metadata on runs and block-level images.
 *
 * @public
 */
export interface TrackedChangeMetadata {
  isInsertion?: boolean;
  isDeletion?: boolean;
  changeAuthor?: string;
  changeDate?: string;
  changeRevisionId?: number;
}
