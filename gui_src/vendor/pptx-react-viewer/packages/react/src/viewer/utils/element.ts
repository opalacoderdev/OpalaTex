/**
 * Element utility functions for the PowerPoint viewer/editor.
 *
 * The framework-agnostic helpers (template detection, inline-text eligibility,
 * labels, comment timestamp/marker, connection sites) live in
 * `pptx-viewer-shared` and are re-exported here.
 */
import type { PptxElement } from 'pptx-viewer-core';
import { isLineLikeElement } from 'pptx-viewer-shared';

export {
	isTemplateElement,
	isTemplateElementId,
	isEditableTextElement,
	getElementLabel,
	formatCommentTimestamp,
	getCommentMarkerPosition,
	getConnectionSitePosition,
} from 'pptx-viewer-shared';

/**
 * Returns true if the element is a connector or line, i.e. it renders
 * as an SVG path rather than a filled rectangular box.  These elements
 * need special hit-testing and selection treatment.
 *
 * Delegates to the shared rule so the renderer, the inspector and the insert
 * path cannot drift apart on what counts as a line.
 */
export function isConnectorOrLineElement(element: PptxElement): boolean {
	return isLineLikeElement(element);
}
