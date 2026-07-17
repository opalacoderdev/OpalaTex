import type { Node as PMNode } from 'prosemirror-model';

/**
 * Text fingerprint of a PM node used to decide whether a raw-preserved block
 * SDT (e.g. a TOC field) is still untouched.
 *
 * Must mirror the parser-side `blocksText` in `docx/blockContentParser.ts`:
 * tabs count as `\t` and fields count as their cached display text. Plain
 * `node.textContent` skips tab leaf nodes, which would drop raw preservation
 * for any TOC whose entries contain tab leaders. Other leaves (symbols,
 * images, note refs) count as empty on both sides.
 */
export function preserveTextFingerprint(node: PMNode): string {
  return node.textBetween(0, node.content.size, '', (leaf) => {
    if (leaf.type.name === 'tab') return '\t';
    if (leaf.type.name === 'field') return String(leaf.attrs.displayText ?? '');
    return '';
  });
}
