import { XmlObject, PptxElement, hasShapeProperties, hasTextProperties } from '../../types';
import type { GroupPptxElement } from '../../types';
import { PptxHandlerRuntime as PptxHandlerRuntimeBase } from './PptxHandlerRuntimeSpTreeParsing';

/**
 * Maximum nesting depth for `p:grpSp` recursion (Load H1).
 *
 * PowerPoint itself does not document a hard limit, but legitimate decks
 * almost never nest more than a handful of levels (typical max < 10). A
 * depth of 64 is well above any plausible authoring use while still
 * preventing stack-overflow DoS from a maliciously deep group tree
 * (`<p:grpSp><p:grpSp>...</p:grpSp></p:grpSp>` chain).
 */
const MAX_GROUP_DEPTH = 64;

/** EMU values are int32 per ECMA-376 §22.1.2.4. Clamp parsed values to this range. */
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/**
 * Parse a string as a base-10 integer with a finite-number guard and an
 * int32 clamp. Used for attacker-controlled EMU values from XML attributes.
 * Returns 0 for malformed/non-finite inputs (matching previous fallback
 * behaviour from `parseInt(... || '0')` while rejecting `'1e308'` and
 * similar finite-overflow values).
 */
function parseEmuInt(value: unknown): number {
	const parsed = parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) {
		return 0;
	}
	if (parsed < INT32_MIN) {
		return INT32_MIN;
	}
	if (parsed > INT32_MAX) {
		return INT32_MAX;
	}
	return parsed;
}

export class PptxHandlerRuntime extends PptxHandlerRuntimeBase {
	protected async parseGroupShape(
		group: XmlObject,
		baseId: string,
		slidePath: string,
		rawXmlStr?: string,
		depth: number = 0,
		applyOwnTransform: boolean = true,
	): Promise<PptxElement[]> {
		// Load H1: cap recursion depth to prevent stack-overflow DoS from a
		// maliciously deep `<p:grpSp>` chain.
		if (depth > MAX_GROUP_DEPTH) {
			this.compatibilityService.reportWarning({
				code: 'group-depth-exceeded',
				severity: 'warning',
				scope: 'element',
				message: `Group nesting exceeded ${MAX_GROUP_DEPTH} levels; truncating subtree (baseId=${baseId})`,
				slideId: slidePath,
				elementId: baseId,
			});
			return [];
		}

		const grpSpPr = group['p:grpSpPr'] as XmlObject | undefined;
		const xfrm = grpSpPr?.['a:xfrm'] as XmlObject | undefined;

		let parentX = 0,
			parentY = 0,
			parentW = 0,
			parentH = 0;
		let rotation: number | undefined;
		let flipHorizontal = false;
		let flipVertical = false;
		let chX = 0,
			chY = 0,
			chW = 0,
			chH = 0;

		if (xfrm) {
			rotation = xfrm['@_rot'] ? parseEmuInt(xfrm['@_rot']) / 60000 : undefined;
			const flipState = this.readFlipState(xfrm);
			flipHorizontal = flipState.flipHorizontal;
			flipVertical = flipState.flipVertical;

			const off = xfrm['a:off'] as XmlObject | undefined;
			if (off) {
				parentX = Math.round(parseEmuInt(off['@_x']) / this.coordinateDivisor);
				parentY = Math.round(parseEmuInt(off['@_y']) / this.coordinateDivisor);
			}
			const ext = xfrm['a:ext'] as XmlObject | undefined;
			if (ext) {
				parentW = Math.round(parseEmuInt(ext['@_cx']) / this.coordinateDivisor);
				parentH = Math.round(parseEmuInt(ext['@_cy']) / this.coordinateDivisor);
			}
			const chOff = xfrm['a:chOff'] as XmlObject | undefined;
			if (chOff) {
				chX = parseEmuInt(chOff['@_x']);
				chY = parseEmuInt(chOff['@_y']);
			}
			const chExt = xfrm['a:chExt'] as XmlObject | undefined;
			if (chExt) {
				chW = parseEmuInt(chExt['@_cx']);
				chH = parseEmuInt(chExt['@_cy']);
			}
		}

		const scaleX = chW > 0 ? parentW / chW : 1;
		const scaleY = chH > 0 ? parentH / chH : 1;

		const transformElement = (el: PptxElement) => {
			const relativeX = el.x - chX;
			const relativeY = el.y - chY;
			el.x = parentX + relativeX * scaleX;
			el.y = parentY + relativeY * scaleY;
			el.width *= scaleX;
			el.height *= scaleY;

			if (applyOwnTransform && flipHorizontal) {
				el.x = parentX + parentW - (el.x - parentX) - el.width;
				el.flipHorizontal = !el.flipHorizontal;
			}
			if (applyOwnTransform && flipVertical) {
				el.y = parentY + parentH - (el.y - parentY) - el.height;
				el.flipVertical = !el.flipVertical;
			}
			if (applyOwnTransform && rotation) {
				const groupCenterX = parentX + parentW / 2;
				const groupCenterY = parentY + parentH / 2;
				const elementCenterX = el.x + el.width / 2;
				const elementCenterY = el.y + el.height / 2;
				const angle = (rotation * Math.PI) / 180;
				const cos = Math.cos(angle);
				const sin = Math.sin(angle);
				const dx = elementCenterX - groupCenterX;
				const dy = elementCenterY - groupCenterY;
				const rotatedCenterX = groupCenterX + dx * cos - dy * sin;
				const rotatedCenterY = groupCenterY + dx * sin + dy * cos;

				el.x = rotatedCenterX - el.width / 2;
				el.y = rotatedCenterY - el.height / 2;
				el.rotation = (el.rotation ?? 0) + rotation;
			}

			const avgScale = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;
			if (hasShapeProperties(el) && el.shapeStyle?.strokeWidth) {
				el.shapeStyle.strokeWidth *= avgScale;
			}
			if (hasTextProperties(el)) {
				if (el.textStyle?.fontSize) {
					el.textStyle.fontSize *= Math.abs(scaleY);
				}
				if (el.textSegments) {
					el.textSegments.forEach((seg) => {
						if (seg.style.fontSize) {
							seg.style.fontSize *= Math.abs(scaleY);
						}
					});
				}
			}
			return el;
		};

		this.unwrapAlternateContent(group as Record<string, unknown>);

		const childOrder = this.extractSpTreeChildOrder(
			undefined,
			group as Record<string, unknown>,
			'p:grpSp',
		);
		const elements: PptxElement[] = [];

		for (const entry of childOrder) {
			if (entry.tag === 'p:grpSp') {
				const subArr = this.ensureArray(group['p:grpSp']);
				const subGroup = subArr[entry.indexInType];
				if (!subGroup) {
					continue;
				}
				const previousDivisor = this.coordinateDivisor;
				this.coordinateDivisor = 1;
				let subElements: PptxElement[];
				try {
					subElements = await this.parseGroupShape(
						subGroup,
						`${baseId}-group-${entry.indexInType}`,
						slidePath,
						rawXmlStr,
						depth + 1,
						true,
					);
				} finally {
					this.coordinateDivisor = previousDivisor;
				}
				subElements.forEach((el) => transformElement(el));
				elements.push(...subElements);
			} else {
				const previousDivisor = this.coordinateDivisor;
				this.coordinateDivisor = 1;
				let element: PptxElement | null;
				try {
					element = await this.parseSpTreeChild(
						entry.tag,
						entry.indexInType,
						group as Record<string, unknown>,
						slidePath,
						`${baseId}-`,
					);
				} finally {
					this.coordinateDivisor = previousDivisor;
				}
				if (element) {
					transformElement(element);
					elements.push(element);
				}
			}
		}

		return elements;
	}

	/**
	 * Parse a p:grpSp element into a GroupPptxElement with children.
	 * Children have coordinates relative to the group's position.
	 */
	protected override async parseGroupShapeAsGroup(
		group: XmlObject,
		baseId: string,
		slidePath: string,
		rawXmlStr?: string,
	): Promise<PptxElement | null> {
		const grpSpPr = group['p:grpSpPr'] as XmlObject | undefined;
		const xfrm = grpSpPr?.['a:xfrm'] as XmlObject | undefined;

		let parentX = 0,
			parentY = 0,
			parentW = 0,
			parentH = 0;
		let rotation: number | undefined;
		let flipHorizontal = false;
		let flipVertical = false;

		if (xfrm) {
			rotation = xfrm['@_rot'] ? parseEmuInt(xfrm['@_rot']) / 60000 : undefined;
			const flipState = this.readFlipState(xfrm);
			flipHorizontal = flipState.flipHorizontal;
			flipVertical = flipState.flipVertical;

			const off = xfrm['a:off'] as XmlObject | undefined;
			if (off) {
				parentX = Math.round(parseEmuInt(off['@_x']) / this.coordinateDivisor);
				parentY = Math.round(parseEmuInt(off['@_y']) / this.coordinateDivisor);
			}
			const ext = xfrm['a:ext'] as XmlObject | undefined;
			if (ext) {
				parentW = Math.round(parseEmuInt(ext['@_cx']) / this.coordinateDivisor);
				parentH = Math.round(parseEmuInt(ext['@_cy']) / this.coordinateDivisor);
			}
		}

		const grpFillStyle = grpSpPr
			? this.extractShapeStyle(grpSpPr as XmlObject | undefined)
			: undefined;
		const hasGroupFill = grpFillStyle && grpFillStyle.fillMode && grpFillStyle.fillMode !== 'none';

		const children = await this.parseGroupShape(group, baseId, slidePath, rawXmlStr, 0, false);
		if (children.length === 0) {
			return null;
		}

		// Apply group fill inheritance
		if (hasGroupFill) {
			for (const child of children) {
				if (hasShapeProperties(child) && child.shapeStyle?.fillMode === 'group') {
					child.shapeStyle = {
						...child.shapeStyle,
						fillMode: grpFillStyle.fillMode,
						fillColor: grpFillStyle.fillColor,
						fillOpacity: grpFillStyle.fillOpacity,
						fillGradient: grpFillStyle.fillGradient,
						fillGradientStops: grpFillStyle.fillGradientStops,
						fillGradientAngle: grpFillStyle.fillGradientAngle,
						fillGradientType: grpFillStyle.fillGradientType,
						fillPatternPreset: grpFillStyle.fillPatternPreset,
						fillPatternBackgroundColor: grpFillStyle.fillPatternBackgroundColor,
					};
				}
			}
		}

		// Convert children to group-relative coordinates
		for (const child of children) {
			child.x -= parentX;
			child.y -= parentY;
		}

		const grpCNvPr = (group?.['p:nvGrpSpPr'] as XmlObject | undefined)?.['p:cNvPr'] as
			| XmlObject
			| undefined;
		const grpSlideRels = this.slideRelsMap.get(slidePath);
		const { actionClick: grpActionClick, actionHover: grpActionHover } = this.parseElementActions(
			grpCNvPr,
			grpSlideRels,
			this.orderedSlidePaths,
		);

		// Extract element name from cNvPr/@name (used for morph !! matching)
		const grpElementName = grpCNvPr?.['@_name'] ? String(grpCNvPr['@_name']).trim() : undefined;

		const groupElement: GroupPptxElement = {
			type: 'group',
			id: baseId,
			name: grpElementName || undefined,
			x: parentX,
			y: parentY,
			width: parentW || Math.max(...children.map((c) => c.x + c.width)),
			height: parentH || Math.max(...children.map((c) => c.y + c.height)),
			rotation,
			flipHorizontal,
			flipVertical,
			children,
			rawXml: group as XmlObject,
			actionClick: grpActionClick,
			actionHover: grpActionHover,
			groupFill: hasGroupFill ? grpFillStyle : undefined,
		};

		return groupElement;
	}

	protected extractGradientFillColor(gradFill: XmlObject): string | undefined {
		return this.colorStyleCodec.extractGradientFillColor(gradFill);
	}
}
