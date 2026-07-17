import type { Node as PMNode } from 'prosemirror-model';
import type { ImageBlock } from '../../pagination-model/types';

export function extractImageRevision(
  node: PMNode
): Pick<
  ImageBlock,
  'isInsertion' | 'isDeletion' | 'changeAuthor' | 'changeDate' | 'changeRevisionId'
> {
  const deletion = node.marks.find((mark) => mark.type.name === 'deletion');
  if (deletion) {
    return {
      isDeletion: true,
      changeAuthor: deletion.attrs.author as string | undefined,
      changeDate: deletion.attrs.date as string | undefined,
      changeRevisionId: deletion.attrs.revisionId as number | undefined,
    };
  }

  const insertion = node.marks.find((mark) => mark.type.name === 'insertion');
  if (insertion) {
    return {
      isInsertion: true,
      changeAuthor: insertion.attrs.author as string | undefined,
      changeDate: insertion.attrs.date as string | undefined,
      changeRevisionId: insertion.attrs.revisionId as number | undefined,
    };
  }

  return {};
}
