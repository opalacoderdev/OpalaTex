import { XmlObject, TextStyle } from '../../types';
import { PptxHandlerRuntime as PptxHandlerRuntimeBase } from './PptxHandlerRuntimeShapeBodyParsing';
import type { ShapeTextParsingContext, ParagraphStyleResult } from './PptxHandlerRuntimeTypes';

export class PptxHandlerRuntime extends PptxHandlerRuntimeBase {
	/**
	 * Resolve paragraph-level styles (alignment, spacing, margins, tabs,
	 * level styles) for a single paragraph.  Modifies `textStyle` in place
	 * for "first-wins" shape-level properties.
	 */
	protected resolveShapeParagraphStyle(
		p: XmlObject,
		textStyle: TextStyle,
		ctx: ShapeTextParsingContext,
	): ParagraphStyleResult {
		// Slide placeholders often contain only text. Their paragraph properties
		// (notably alignment and RTL direction) remain on the matching layout or
		// master placeholder, so merge them before resolving the paragraph style.
		const inheritedParagraph = this.ensureArray(ctx.inheritedTxBody?.['a:p'])[0] as
			| XmlObject
			| undefined;
		const pPr = this.mergeXmlObjects(
			inheritedParagraph?.['a:pPr'] as XmlObject | undefined,
			p['a:pPr'] as XmlObject | undefined,
		);
		const paragraphRtl = this.parseOptionalBooleanAttr(pPr?.['@_rtl']);
		if (paragraphRtl !== undefined && textStyle.rtl === undefined) {
			textStyle.rtl = paragraphRtl;
		}

		let paraAlign: TextStyle['align'] = paragraphRtl ? 'right' : 'left';
		if (pPr?.['@_algn']) {
			const alignMap: Record<string, TextStyle['align']> = {
				l: 'left',
				ctr: 'center',
				r: 'right',
				just: 'justify',
				justify: 'justify',
				justLow: 'justLow',
				dist: 'dist',
				thaiDist: 'thaiDist',
			};
			paraAlign = alignMap[pPr['@_algn']] || 'left';
			if (!textStyle.align) {
				textStyle.align = paraAlign;
			}
		}

		if (textStyle.paragraphSpacingBefore === undefined) {
			const spacingBefore = this.parseParagraphSpacingPx(
				pPr?.['a:spcBef'] as XmlObject | undefined,
			);
			if (spacingBefore !== undefined) {
				textStyle.paragraphSpacingBefore = spacingBefore;
			}
		}
		if (textStyle.paragraphSpacingAfter === undefined) {
			const spacingAfter = this.parseParagraphSpacingPx(pPr?.['a:spcAft'] as XmlObject | undefined);
			if (spacingAfter !== undefined) {
				textStyle.paragraphSpacingAfter = spacingAfter;
			}
		}
		if (textStyle.lineSpacing === undefined && textStyle.lineSpacingExactPt === undefined) {
			const lnSpcNode = pPr?.['a:lnSpc'] as XmlObject | undefined;
			const lineSpacing = this.parseLineSpacingMultiplier(lnSpcNode);
			if (lineSpacing !== undefined) {
				textStyle.lineSpacing = lineSpacing;
			} else {
				const exactPt = this.parseLineSpacingExactPt(lnSpcNode);
				if (exactPt !== undefined) {
					textStyle.lineSpacingExactPt = exactPt;
				}
			}
		}

		// Paragraph indentation (marL, marR, indent)
		if (textStyle.paragraphMarginLeft === undefined && pPr?.['@_marL'] !== undefined) {
			const marL = Number.parseInt(String(pPr['@_marL']), 10);
			if (Number.isFinite(marL)) {
				textStyle.paragraphMarginLeft = marL / PptxHandlerRuntime.EMU_PER_PX;
			}
		}
		if (textStyle.paragraphMarginRight === undefined && pPr?.['@_marR'] !== undefined) {
			const marR = Number.parseInt(String(pPr['@_marR']), 10);
			if (Number.isFinite(marR)) {
				textStyle.paragraphMarginRight = marR / PptxHandlerRuntime.EMU_PER_PX;
			}
		}
		if (textStyle.paragraphIndent === undefined && pPr?.['@_indent'] !== undefined) {
			const indent = Number.parseInt(String(pPr['@_indent']), 10);
			if (Number.isFinite(indent)) {
				textStyle.paragraphIndent = indent / PptxHandlerRuntime.EMU_PER_PX;
			}
		}

		// Tab stops (a:tabLst > a:tab)
		if (!textStyle.tabStops) {
			const tabLst = pPr?.['a:tabLst'] as XmlObject | undefined;
			if (tabLst) {
				const tabNodes = this.ensureArray(tabLst['a:tab']) as XmlObject[];
				if (tabNodes.length > 0) {
					textStyle.tabStops = tabNodes
						.filter((t) => t?.['@_pos'] !== undefined)
						.map((t) => {
							const posRaw = Number.parseInt(String(t['@_pos']), 10);
							const position = Number.isFinite(posRaw) ? posRaw / PptxHandlerRuntime.EMU_PER_PX : 0;
							const algn = String(t['@_algn'] || 'l').trim();
							const align =
								algn === 'ctr' || algn === 'r' || algn === 'dec' ? algn : ('l' as const);
							const leaderVal = String(t['@_leader'] || '').trim();
							const leader =
								leaderVal === 'dot' || leaderVal === 'hyphen' || leaderVal === 'underscore'
									? leaderVal
									: undefined;
							return { position, align, ...(leader ? { leader } : {}) };
						});
				}
			}
		}

		// Additional paragraph properties
		if (pPr?.['@_defTabSz'] !== undefined && textStyle.defaultTabSize === undefined) {
			const defTabSz = Number.parseInt(String(pPr['@_defTabSz']), 10);
			if (Number.isFinite(defTabSz)) {
				textStyle.defaultTabSize = defTabSz / PptxHandlerRuntime.EMU_PER_PX;
			}
		}
		if (pPr?.['@_eaLnBrk'] !== undefined && textStyle.eaLineBreak === undefined) {
			const eaVal = this.parseOptionalBooleanAttr(pPr['@_eaLnBrk']);
			if (eaVal !== undefined) {
				textStyle.eaLineBreak = eaVal;
			}
		}
		if (pPr?.['@_latinLnBrk'] !== undefined && textStyle.latinLineBreak === undefined) {
			const latVal = this.parseOptionalBooleanAttr(pPr['@_latinLnBrk']);
			if (latVal !== undefined) {
				textStyle.latinLineBreak = latVal;
			}
		}
		if (pPr?.['@_fontAlgn'] !== undefined && textStyle.fontAlignment === undefined) {
			const fontAlgn = String(pPr['@_fontAlgn']).trim();
			if (fontAlgn) {
				textStyle.fontAlignment = fontAlgn;
			}
		}
		if (pPr?.['@_hangingPunct'] !== undefined && textStyle.hangingPunctuation === undefined) {
			const hpVal = this.parseOptionalBooleanAttr(pPr['@_hangingPunct']);
			if (hpVal !== undefined) {
				textStyle.hangingPunctuation = hpVal;
			}
		}

		// Resolve run-level default styles
		const defaultRunStyle = this.extractTextRunStyle(
			pPr?.['a:defRPr'] as XmlObject | undefined,
			paraAlign,
			ctx.slideRelationshipMap,
			false,
		);
		// An omitted level inherits a:defPPr. It is distinct from an explicit
		// lvl="0", which inherits a:lvl1pPr.
		const level = pPr?.['@_lvl'] === undefined ? -1 : Number.parseInt(String(pPr['@_lvl']), 10);
		const normalizedLevel = Number.isFinite(level) && level >= 0 ? Math.min(level + 1, 9) : 1;
		const levelKey =
			level === -1
				? 'a:defPPr'
				: `a:lvl${normalizedLevel}pPr`;

		const bodyLstStyle = ctx.txBody?.['a:lstStyle'] as XmlObject | undefined;
		const inheritedLstStyle = ctx.inheritedTxBody?.['a:lstStyle'] as XmlObject | undefined;

		const bodyLevelNode = (bodyLstStyle?.[levelKey] ?? bodyLstStyle?.['a:defPPr']) as XmlObject | undefined;
		const inheritedLevelNode = (inheritedLstStyle?.[levelKey] ?? inheritedLstStyle?.['a:defPPr']) as XmlObject | undefined;

		const inheritedLevelStyle = this.extractTextRunStyle(
			inheritedLevelNode?.['a:defRPr'] as XmlObject | undefined,
			paraAlign,
			ctx.slideRelationshipMap,
			false,
		);
		const bodyLevelStyle = this.extractTextRunStyle(
			bodyLevelNode?.['a:defRPr'] as XmlObject | undefined,
			paraAlign,
			ctx.slideRelationshipMap,
			false,
		);
		const endParagraphStyle = this.extractTextRunStyle(
			p?.['a:endParaRPr'] as XmlObject | undefined,
			paraAlign,
			ctx.slideRelationshipMap,
			false,
		);
		const mergedDefaultRunStyle = {
			...ctx.bodyDefaultRunStyle,
			...inheritedLevelStyle,
			...bodyLevelStyle,
			...endParagraphStyle,
			...defaultRunStyle,
		} as TextStyle;

		// Apply placeholder level-specific defaults as fallback
		if (ctx.effectiveLevelStyles) {
			const normalizedLevelIdx =
				level === -1 ? -1 : Number.isFinite(level) ? Math.min(Math.max(level, 0), 8) : 0;
			const phLevel =
				ctx.effectiveLevelStyles[normalizedLevelIdx] ??
				ctx.effectiveLevelStyles[-1] ??
				(normalizedLevelIdx === -1 ? ctx.effectiveLevelStyles[0] : undefined);
			if (phLevel) {
				this.applyPlaceholderLevelDefaults(mergedDefaultRunStyle, phLevel);
				this.applyPlaceholderLevelDefaults(textStyle, phLevel);
			}
		}
		if (pPr?.['@_algn'] === undefined && textStyle.align !== undefined) {
			paraAlign = textStyle.align;
		}

		// Per-paragraph indentation (checking pPr, body lstStyle, inherited lstStyle, defPPr, and placeholder defaults)
		const indentCandidates = [
			pPr,
			bodyLevelNode,
			inheritedLevelNode,
			bodyLstStyle?.['a:defPPr'] as XmlObject | undefined,
			inheritedLstStyle?.['a:defPPr'] as XmlObject | undefined,
		];

		let parMarginLeft: number | undefined;
		for (const candidate of indentCandidates) {
			if (candidate?.['@_marL'] !== undefined) {
				const val = Number.parseInt(String(candidate['@_marL']), 10);
				if (Number.isFinite(val)) {
					parMarginLeft = val / PptxHandlerRuntime.EMU_PER_PX;
					break;
				}
			}
		}

		let parMarginRight: number | undefined;
		for (const candidate of indentCandidates) {
			if (candidate?.['@_marR'] !== undefined) {
				const val = Number.parseInt(String(candidate['@_marR']), 10);
				if (Number.isFinite(val)) {
					parMarginRight = val / PptxHandlerRuntime.EMU_PER_PX;
					break;
				}
			}
		}

		let parIndent: number | undefined;
		for (const candidate of indentCandidates) {
			if (candidate?.['@_indent'] !== undefined) {
				const val = Number.parseInt(String(candidate['@_indent']), 10);
				if (Number.isFinite(val)) {
					parIndent = val / PptxHandlerRuntime.EMU_PER_PX;
					break;
				}
			}
		}

		let effectiveMarginLeft = parMarginLeft;
		let effectiveMarginRight = parMarginRight;
		let effectiveIndent = parIndent;
		if (ctx.effectiveLevelStyles) {
			const normalizedLevelIdx =
				level === -1 ? -1 : Number.isFinite(level) ? Math.min(Math.max(level, 0), 8) : 0;
			const phLevel =
				ctx.effectiveLevelStyles[normalizedLevelIdx] ??
				ctx.effectiveLevelStyles[-1] ??
				(normalizedLevelIdx === -1 ? ctx.effectiveLevelStyles[0] : undefined);
			if (phLevel) {
				if (effectiveMarginLeft === undefined && phLevel.marginLeft !== undefined) {
					effectiveMarginLeft = phLevel.marginLeft;
				}
				if (effectiveIndent === undefined && phLevel.indent !== undefined) {
					effectiveIndent = phLevel.indent;
				}
			}
		}

		// When a negative indent (hanging indent) is present, PowerPoint ensures
		// the paragraph's effective left margin is at least equal to |indent| so the
		// first line (e.g. bullet or numbered marker) is not pulled into negative
		// space to the left of the shape boundary.
		if (effectiveIndent !== undefined && effectiveIndent < 0) {
			const minMargin = Math.abs(effectiveIndent);
			if (effectiveMarginLeft === undefined || effectiveMarginLeft < minMargin) {
				effectiveMarginLeft = minMargin;
			}
		}

		if (textStyle.paragraphMarginLeft === undefined && effectiveMarginLeft !== undefined) {
			textStyle.paragraphMarginLeft = effectiveMarginLeft;
		}
		if (textStyle.paragraphMarginRight === undefined && effectiveMarginRight !== undefined) {
			textStyle.paragraphMarginRight = effectiveMarginRight;
		}
		if (textStyle.paragraphIndent === undefined && effectiveIndent !== undefined) {
			textStyle.paragraphIndent = effectiveIndent;
		}

		return {
			paraAlign,
			mergedDefaultRunStyle,
			indent: { marginLeft: effectiveMarginLeft, indent: effectiveIndent },
		};
	}
}
