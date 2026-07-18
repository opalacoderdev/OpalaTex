import type { PptxSlideBackgroundPattern, XmlObject } from '../../types';
import { stripParentDirSegments } from '../../utils/strip-parent-dir-segments';
import { xmlAttr, xmlAttrNumber, xmlChild, xmlPath } from '../../utils/xml-access';
import { PptxHandlerRuntime as PptxHandlerRuntimeBase } from './PptxHandlerRuntimeColorAndEffects';

export class PptxHandlerRuntime extends PptxHandlerRuntimeBase {
	protected async extractBackgroundImage(
		slideXml: XmlObject,
		slidePath: string,
		rootElement: string = 'p:sld',
	): Promise<string | undefined> {
		try {
			const bg = xmlPath(slideXml, rootElement, 'p:cSld', 'p:bg');
			const blip = xmlPath(bg, 'p:bgPr', 'a:blipFill', 'a:blip');
			const rEmbed = xmlAttr(blip, 'r:embed');
			if (rEmbed) {
				const slideRels = this.slideRelsMap.get(slidePath);
				const target = slideRels?.get(rEmbed);
				if (!target) {
					return undefined;
				}

				// Load H3: external URL gating. Refuse to pass through
				// http(s):// background images unless allowExternalImages
				// is explicitly enabled.
				if (target.startsWith('http://') || target.startsWith('https://')) {
					if (this.allowExternalImages !== true) {
						return undefined;
					}
					return target;
				}
				const imagePath = this.resolveImagePath(slidePath, target);
				return this.getImageData(imagePath);
			}

			const bgRef = xmlChild(bg, 'p:bgRef');
			if (bgRef) {
				return this.extractThemeBackgroundRefImage(bgRef, slidePath);
			}
		} catch (e) {
			console.warn('Failed to extract background image:', e);
		}
		return undefined;
	}

	private getBackgroundRefFillDef(bgRef: XmlObject):
		| NonNullable<typeof this.themeFormatScheme>['fillStyles'][number]
		| undefined {
		const idx = xmlAttrNumber(bgRef, 'idx') ?? 0;
		if (!Number.isFinite(idx) || idx <= 0 || !this.themeFormatScheme) {
			return undefined;
		}
		if (idx >= 1 && idx <= 999) {
			return this.themeFormatScheme.fillStyles[idx - 1];
		}
		if (idx >= 1001 && idx <= 1003) {
			return this.themeFormatScheme.backgroundFillStyles[idx - 1001];
		}
		return undefined;
	}

	private async extractThemeBackgroundRefImage(
		bgRef: XmlObject,
		partPath: string,
	): Promise<string | undefined> {
		const fillDef = this.getBackgroundRefFillDef(bgRef);
		if (fillDef?.kind !== 'image' || !fillDef.rawNode) {
			return undefined;
		}

		const blip = xmlChild(fillDef.rawNode as XmlObject, 'a:blip');
		const rEmbed = xmlAttr(blip, 'r:embed');
		const rLink = xmlAttr(blip, 'r:link');
		const relId = rEmbed || rLink;
		if (!relId) {
			return undefined;
		}

		const themePath = await this.resolveThemePathForBackgroundPart(partPath);
		if (!themePath) {
			return undefined;
		}
		await this.loadThemeRelationships(themePath);
		const themeRels = this.slideRelsMap.get(themePath);
		const target = themeRels?.get(relId);
		if (!target) {
			return undefined;
		}

		if (target.startsWith('http://') || target.startsWith('https://')) {
			if (this.allowExternalImages !== true) {
				return undefined;
			}
			return target;
		}

		const imagePath = this.resolveImagePath(themePath, target);
		return this.getImageData(imagePath);
	}

	private async loadThemeRelationships(themePath: string): Promise<void> {
		if (this.slideRelsMap.has(themePath)) {
			return;
		}
		const relsPath = themePath.replace(/^ppt\/theme\/([^/]+\.xml)$/u, 'ppt/theme/_rels/$1.rels');
		await this.loadSlideRelationships(themePath, relsPath);
	}

	private async resolveThemePathForBackgroundPart(partPath: string): Promise<string | undefined> {
		if (partPath.startsWith('ppt/theme/')) {
			return partPath;
		}
		const masterPath = await this.resolveMasterPathForBackgroundPart(partPath);
		if (masterPath) {
			return this.masterThemePaths.get(masterPath) ?? this.resolveThemePathForMaster(masterPath);
		}
		return this.resolvePrimaryThemePath();
	}

	private async resolveMasterPathForBackgroundPart(partPath: string): Promise<string | undefined> {
		if (partPath.startsWith('ppt/slideMasters/')) {
			return partPath;
		}

		let layoutPath: string | undefined;
		if (partPath.startsWith('ppt/slideLayouts/')) {
			layoutPath = partPath;
		} else {
			layoutPath = this.resolveLayoutPathFromRelationships(partPath);
		}
		if (!layoutPath) {
			return undefined;
		}

		if (!this.slideRelsMap.has(layoutPath)) {
			const layoutRelsPath = `${layoutPath.replace('slideLayouts/', 'slideLayouts/_rels/')}.rels`;
			await this.loadSlideRelationships(layoutPath, layoutRelsPath);
		}
		return this.resolveMasterPathFromRelationships(layoutPath);
	}

	private resolveLayoutPathFromRelationships(slidePath: string): string | undefined {
		const slideRels = this.slideRelsMap.get(slidePath);
		if (!slideRels) {
			return undefined;
		}
		for (const [, target] of slideRels.entries()) {
			if (target.includes('slideLayout')) {
				return this.resolveRelatedPartPath(slidePath, target);
			}
		}
		return undefined;
	}

	private resolveMasterPathFromRelationships(layoutPath: string): string | undefined {
		const layoutRels = this.slideRelsMap.get(layoutPath);
		if (!layoutRels) {
			return undefined;
		}
		for (const [, target] of layoutRels.entries()) {
			if (target.includes('slideMaster')) {
				return this.resolveRelatedPartPath(layoutPath, target);
			}
		}
		return undefined;
	}

	private resolveRelatedPartPath(partPath: string, target: string): string {
		if (target.startsWith('/')) {
			return target.substring(1);
		}
		if (target.startsWith('..') || target.startsWith('./')) {
			const partDir = partPath.substring(0, partPath.lastIndexOf('/') + 1);
			return this.resolvePath(partDir, target);
		}
		return `ppt/${stripParentDirSegments(target)}`;
	}

	protected extractBackgroundColor(
		slideXml: XmlObject,
		rootElement: string = 'p:sld',
	): string | undefined {
		try {
			const bg = xmlPath(slideXml, rootElement, 'p:cSld', 'p:bg');
			if (!bg) {
				return undefined;
			}

			// Try solid fill from bgPr
			const bgPr = xmlChild(bg, 'p:bgPr');
			if (bgPr) {
				const solidFill = xmlChild(bgPr, 'a:solidFill');
				if (solidFill) {
					return this.parseColor(solidFill);
				}
				// Pattern fill foreground colour as fallback for solid rendering
				const pattFill = xmlChild(bgPr, 'a:pattFill');
				if (pattFill) {
					const fgClr = this.parseColor(xmlChild(pattFill, 'a:fgClr'));
					if (fgClr) {
						return fgClr;
					}
					const bgClr = this.parseColor(xmlChild(pattFill, 'a:bgClr'));
					if (bgClr) {
						return bgClr;
					}
				}
			}

			// Try bgRef (reference to theme background fill style list)
			const bgRef = xmlChild(bg, 'p:bgRef');
			if (bgRef) {
				return this.resolveBackgroundRefColor(bgRef);
			}
		} catch {
			// Ignore background parsing errors
		}
		return undefined;
	}

	/**
	 * Resolve a `<p:bgRef>` element to a flat colour string.
	 *
	 * Per ECMA-376 §20.1.4.2.10 the `@idx` attribute selects an entry
	 * from one of two style matrices on the active theme:
	 *
	 * - `idx == 0` → no fill (transparent / undefined)
	 * - `1 ≤ idx ≤ 999` → `fmtScheme/fillStyleLst[idx-1]`
	 * - `1001 ≤ idx ≤ 1003` → `fmtScheme/bgFillStyleLst[idx-1001]`
	 *
	 * When the resolved fill is a gradient or pattern we surface its
	 * primary colour; gradient CSS is handled separately by
	 * {@link extractBackgroundGradient}. The colour child of `bgRef`
	 * acts as the `phClr` placeholder for any `phClr` tokens inside the
	 * referenced fill definition.
	 */
	protected resolveBackgroundRefColor(bgRef: XmlObject): string | undefined {
		const idx = xmlAttrNumber(bgRef, 'idx') ?? 0;

		// idx == 0 → no fill
		if (idx === 0) {
			return undefined;
		}

		// Direct solid fill child overrides any matrix lookup
		const solidFill = xmlChild(bgRef, 'a:solidFill');
		if (solidFill) {
			return this.parseColor(solidFill);
		}

		// The colour choice on bgRef itself acts as the phClr supplier.
		const overrideColor = this.parseColor(bgRef);

		if (this.themeFormatScheme) {
			let fillDef = undefined as (typeof this.themeFormatScheme)['fillStyles'][number] | undefined;
			if (idx >= 1 && idx <= 999) {
				fillDef = this.themeFormatScheme.fillStyles[idx - 1];
			} else if (idx >= 1001 && idx <= 1003) {
				fillDef = this.themeFormatScheme.backgroundFillStyles[idx - 1001];
			}

			if (fillDef) {
				switch (fillDef.kind) {
					case 'none':
						return undefined;
					case 'solid':
						return overrideColor || fillDef.color;
					case 'gradient':
						return overrideColor || fillDef.color;
					case 'pattern':
						return overrideColor || fillDef.color || fillDef.patternBackgroundColor;
					case 'image':
					case 'group':
						return overrideColor;
				}
			}
		}

		if (overrideColor) {
			return overrideColor;
		}

		// Out-of-range or missing scheme — log & fall through to white so the
		// renderer doesn't blank the slide.
		if (idx !== 0) {
			console.warn(
				`bgRef @idx=${idx} did not resolve to a fill style (theme has ${
					this.themeFormatScheme?.fillStyles.length ?? 0
				} fillStyleLst / ${
					this.themeFormatScheme?.backgroundFillStyles.length ?? 0
				} bgFillStyleLst entries); falling back to #FFFFFF.`,
			);
		}
		return '#FFFFFF';
	}

	/**
	 * Extract a structured pattern fill (`<a:pattFill>`) from a slide
	 * background. Returns the preset name plus resolved fg/bg colours so
	 * renderers can draw a real SVG pattern instead of a flat fill.
	 *
	 * ECMA-376 §20.1.8.47.
	 */
	protected extractBackgroundPattern(
		slideXml: XmlObject,
		rootElement: string = 'p:sld',
	): PptxSlideBackgroundPattern | undefined {
		try {
			const pattFill = xmlPath(slideXml, rootElement, 'p:cSld', 'p:bg', 'p:bgPr', 'a:pattFill');
			if (!pattFill) {
				return undefined;
			}
			const preset = (xmlAttr(pattFill, 'prst') ?? '').trim();
			if (!preset) {
				return undefined;
			}
			const fgColor = this.parseColor(xmlChild(pattFill, 'a:fgClr'));
			const bgColor = this.parseColor(xmlChild(pattFill, 'a:bgClr'));
			return {
				preset,
				fgColor,
				bgColor,
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * Extract the `<p:bgPr/@shadeToTitle>` boolean attribute from a slide
	 * background. Captured for round-trip — render-time semantics are a
	 * passthrough hint to renderers that may want to blend toward the
	 * title placeholder colour.
	 *
	 * ECMA-376 §19.3.1.2 (CT_BackgroundProperties).
	 */
	protected extractBackgroundShadeToTitle(
		slideXml: XmlObject,
		rootElement: string = 'p:sld',
	): boolean | undefined {
		try {
			const bgPr = xmlPath(slideXml, rootElement, 'p:cSld', 'p:bg', 'p:bgPr');
			if (!bgPr) {
				return undefined;
			}
			const raw = xmlAttr(bgPr, 'shadeToTitle');
			if (raw === undefined) {
				return undefined;
			}
			const normalized = raw.trim().toLowerCase();
			return normalized === '1' || normalized === 'true';
		} catch {
			return undefined;
		}
	}

	/**
	 * Extract a CSS gradient string from a slide/layout/master background.
	 * Handles `a:gradFill` within `p:bgPr` and gradient-based `p:bgRef`.
	 */
	protected extractBackgroundGradient(
		slideXml: XmlObject,
		rootElement: string = 'p:sld',
	): string | undefined {
		try {
			const bg = xmlPath(slideXml, rootElement, 'p:cSld', 'p:bg');
			if (!bg) {
				return undefined;
			}

			const gradFill = xmlPath(bg, 'p:bgPr', 'a:gradFill');
			if (gradFill) {
				return this.extractGradientFillCss(gradFill);
			}

			// bgRef may reference a theme background fill that is a gradient
			const bgRef = xmlChild(bg, 'p:bgRef');
			if (bgRef && this.themeFormatScheme) {
				const idx = xmlAttrNumber(bgRef, 'idx') ?? 0;
				if (idx >= 1001) {
					const offset = idx - 1001;
					const fillDef = this.themeFormatScheme.backgroundFillStyles[offset];
					if (fillDef?.kind === 'gradient' && fillDef.rawNode) {
						const overrideColor = this.parseColor(bgRef);
						if (overrideColor) {
							const result = this.reResolveGradientWithPhClr(
								fillDef.rawNode as XmlObject,
								overrideColor,
							);
							return result.css;
						}
						return fillDef.gradientCss;
					}
				}
			}
		} catch {
			// Ignore
		}
		return undefined;
	}

	protected async getMasterBackgroundImage(layoutPath: string): Promise<string | undefined> {
		const layoutRels = this.slideRelsMap.get(layoutPath);
		if (!layoutRels) {
			return undefined;
		}

		for (const [, target] of layoutRels.entries()) {
			if (target.includes('slideMaster')) {
				const layoutDir = layoutPath.substring(0, layoutPath.lastIndexOf('/') + 1);
				const masterPath = target.startsWith('/')
					? target.substring(1)
					: target.startsWith('..')
						? this.resolvePath(layoutDir, target)
						: `ppt/${stripParentDirSegments(target)}`;

				try {
					const masterXmlStr = await this.zip.file(masterPath)?.async('string');
					if (masterXmlStr) {
						const masterXmlObj = this.parser.parse(masterXmlStr);
						const masterRelsPath = `${masterPath.replace('slideMasters/', 'slideMasters/_rels/')}.rels`;
						await this.loadSlideRelationships(masterPath, masterRelsPath);

						return this.extractBackgroundImage(masterXmlObj, masterPath, 'p:sldMaster');
					}
				} catch {
					// Ignore
				}
				break;
			}
		}
		return undefined;
	}

	protected async getLayoutBackgroundImage(slidePath: string): Promise<string | undefined> {
		const slideRels = this.slideRelsMap.get(slidePath);
		if (!slideRels) {
			return undefined;
		}

		for (const [, target] of slideRels.entries()) {
			if (target.includes('slideLayout')) {
				const slideDir = slidePath.substring(0, slidePath.lastIndexOf('/') + 1);
				const layoutPath = target.startsWith('/')
					? target.substring(1)
					: target.startsWith('..')
						? this.resolvePath(slideDir, target)
						: `ppt/${stripParentDirSegments(target)}`;

				try {
					const layoutXmlStr = await this.zip.file(layoutPath)?.async('string');
					if (layoutXmlStr) {
						const layoutXmlObj = this.parser.parse(layoutXmlStr);
						// We need to load layout rels to resolve images
						const layoutRelsPath = `${layoutPath.replace('slideLayouts/', 'slideLayouts/_rels/')}.rels`;
						await this.loadSlideRelationships(layoutPath, layoutRelsPath);

						const bg = this.extractBackgroundImage(layoutXmlObj, layoutPath, 'p:sldLayout');

						if (bg) {
							return bg;
						}

						// Fallback to Master
						return this.getMasterBackgroundImage(layoutPath);
					}
				} catch {
					// Ignore
				}
				break;
			}
		}
		return undefined;
	}

	protected async getLayoutBackgroundColor(slidePath: string): Promise<string | undefined> {
		const slideRels = this.slideRelsMap.get(slidePath);
		if (!slideRels) {
			return undefined;
		}

		for (const [, target] of slideRels.entries()) {
			if (target.includes('slideLayout')) {
				const slideDir = slidePath.substring(0, slidePath.lastIndexOf('/') + 1);
				const layoutPath = target.startsWith('/')
					? target.substring(1)
					: target.startsWith('..')
						? this.resolvePath(slideDir, target)
						: `ppt/${stripParentDirSegments(target)}`;

				try {
					const layoutXmlStr = await this.zip.file(layoutPath)?.async('string');
					if (layoutXmlStr) {
						const layoutXmlObj = this.parser.parse(layoutXmlStr);
						const layoutBg = this.extractBackgroundColor(layoutXmlObj, 'p:sldLayout');
						if (layoutBg) {
							return layoutBg;
						}

						// Fallback to master background colour
						return this.getMasterBackgroundColor(layoutPath);
					}
				} catch {
					// Ignore
				}
				break;
			}
		}
		return undefined;
	}

	/**
	 * Resolve the slide master's background colour given a layout path.
	 */
	protected async getMasterBackgroundColor(layoutPath: string): Promise<string | undefined> {
		const layoutRels = this.slideRelsMap.get(layoutPath);
		if (!layoutRels) {
			return undefined;
		}

		for (const [, target] of layoutRels.entries()) {
			if (target.includes('slideMaster')) {
				const layoutDir = layoutPath.substring(0, layoutPath.lastIndexOf('/') + 1);
				const masterPath = target.startsWith('/')
					? target.substring(1)
					: target.startsWith('..')
						? this.resolvePath(layoutDir, target)
						: `ppt/${stripParentDirSegments(target)}`;

				try {
					const masterXmlStr = await this.zip.file(masterPath)?.async('string');
					if (masterXmlStr) {
						const masterXmlObj = this.parser.parse(masterXmlStr);
						return this.extractBackgroundColor(masterXmlObj, 'p:sldMaster');
					}
				} catch {
					// Ignore
				}
				break;
			}
		}
		return undefined;
	}
}
