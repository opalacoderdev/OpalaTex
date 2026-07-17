/**
 * Text Box Renderer
 *
 * Renders text box fragments to DOM. Handles:
 * - Background fill color
 * - Border/outline
 * - Internal padding (margins)
 * - Paragraph content inside the box (using pre-measured data)
 */

import {
  DEFAULT_TEXTBOX_MARGINS,
  type TextBoxFragment,
  type TextBoxBlock,
  type TextBoxMetrics,
} from '../pagination-model/types';
import type { RenderContext } from './paintPage';
import { paintParagraphFragment } from './renderParagraph';

/**
 * CSS class names for text box elements
 */
export const TEXTBOX_CLASS_NAMES = {
  textBox: 'layout-textbox',
};

/**
 * Options for rendering a text box fragment
 */
export interface RenderTextBoxFragmentOptions {
  document?: Document;
}

/**
 * Render a text box fragment to DOM
 */
export function paintTextBoxFragment(
  fragment: TextBoxFragment,
  block: TextBoxBlock,
  measure: TextBoxMetrics,
  context: RenderContext,
  config: RenderTextBoxFragmentOptions = {}
): HTMLElement {
  const doc = config.document ?? document;

  const containerEl = doc.createElement('div');
  containerEl.className = TEXTBOX_CLASS_NAMES.textBox;

  // Basic styling
  containerEl.style.position = 'absolute';
  containerEl.style.width = `${fragment.width}px`;
  containerEl.style.height = `${fragment.height}px`;
  containerEl.style.overflow = 'hidden';
  containerEl.style.boxSizing = 'border-box';
  applyTextBoxStacking(containerEl, fragment);

  // Fill color
  if (block.fillColor) {
    containerEl.style.backgroundColor = block.fillColor;
  }

  // Border/outline
  if (block.outlineWidth && block.outlineWidth > 0) {
    const style = block.outlineStyle || 'solid';
    const color = block.outlineColor || '#000000';
    containerEl.style.border = `${block.outlineWidth}px ${style} ${color}`;
  }

  // Internal padding
  const margins = block.margins ?? DEFAULT_TEXTBOX_MARGINS;
  containerEl.style.padding = `${margins.top}px ${margins.right}px ${margins.bottom}px ${margins.left}px`;

  // Store metadata
  containerEl.dataset.blockId = String(fragment.nodeId);
  if (fragment.docFrom !== undefined) {
    containerEl.dataset.docFrom = String(fragment.docFrom);
  }
  if (fragment.docTo !== undefined) {
    containerEl.dataset.docTo = String(fragment.docTo);
  }

  // Render inner paragraph content using pre-measured data
  const innerWidth = fragment.width - margins.left - margins.right;
  let yOffset = 0;

  for (let i = 0; i < block.content.length; i++) {
    const paraBlock = block.content[i];
    const paraMeasure = measure.innerMetrics[i];
    if (!paraMeasure) continue;

    const paraFragment = {
      kind: 'paragraph' as const,
      nodeId: paraBlock.id,
      x: 0,
      y: yOffset,
      width: innerWidth,
      height: paraMeasure.totalHeight,
      docFrom: paraBlock.docFrom,
      docTo: paraBlock.docTo,
      fromLine: 0,
      toLine: paraMeasure.lines.length,
    };

    // Pass `positioning: 'flow'` so the renderer's outer position is
    // explicit. `paintParagraphFragment` already defaults to `position:
    // relative` (it needs to be a containing block for floating images),
    // so passing 'flow' here is documentation more than behavior change —
    // pre-PR the textbox caller re-set the same `position: relative; top:
    // 0; left: 0` after the renderer call (#379).
    const paraEl = paintParagraphFragment(
      paraFragment,
      paraBlock,
      paraMeasure,
      { ...context, positioning: 'flow' },
      { document: doc }
    );

    containerEl.appendChild(paraEl);
    yOffset += paraMeasure.totalHeight;
  }

  return containerEl;
}

function applyTextBoxStacking(element: HTMLElement, fragment: TextBoxFragment): void {
  if (!fragment.isFloating && fragment.zIndex === undefined) return;
  element.style.zIndex = String(fragment.zIndex ?? 10);
}
