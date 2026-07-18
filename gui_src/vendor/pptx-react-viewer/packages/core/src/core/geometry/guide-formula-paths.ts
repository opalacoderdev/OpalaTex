/**
 * OOXML DrawingML geometry path evaluation.
 *
 * Evaluates custom geometry definitions (a:custGeom) with formula-resolved
 * coordinates, producing SVG path data strings.
 */

import type { XmlObject } from '../types';
import { orderedPathCommandEntries } from './custom-geometry-command-order';
import { resolveCoordinate } from './guide-formula-api';
import { angleToRadians } from './guide-formula-eval';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a complete custom geometry definition (a:custGeom) with
 * formula-resolved coordinates, producing an SVG path data string.
 *
 * This handles the case where path coordinates reference guide names
 * instead of being plain numbers.
 *
 * @param pathNodes - Array of `a:path` XML objects from `a:pathLst`.
 * @param variables - Fully resolved variable context from evaluateGuides.
 * @param ensureArray - Helper to normalize XML nodes to arrays.
 * @returns SVG path data string and coordinate-space dimensions.
 */
export function evaluateGeometryPaths(
	pathNodes: ReadonlyArray<Record<string, unknown>>,
	variables: Map<string, number>,
	ensureArray: (val: unknown) => unknown[],
): { pathData: string; pathWidth: number; pathHeight: number } | null {
	let fullPathData = '';
	// Coordinate-space dimensions (from @_w / @_h on the first path that specifies them)
	const pathWidth =
		pathNodes
			.map((path) => Number.parseInt(String(path['@_w'] ?? '0'), 10))
			.find((width) => width > 0) ??
		variables.get('w') ??
		0;
	const pathHeight =
		pathNodes
			.map((path) => Number.parseInt(String(path['@_h'] ?? '0'), 10))
			.find((height) => height > 0) ??
		variables.get('h') ??
		0;

	for (const path of pathNodes) {
		// Each path element may declare its own coordinate-space dimensions
		const w = Number.parseInt(String(path['@_w'] ?? '0'), 10);
		const h = Number.parseInt(String(path['@_h'] ?? '0'), 10);
		const scaleX = pathWidth > 0 && w > 0 ? pathWidth / w : 1;
		const scaleY = pathHeight > 0 && h > 0 ? pathHeight / h : 1;

		const commands: string[] = [];
		// Track current pen position for arcTo conversion (arcTo needs the
		// current position to derive the implicit ellipse center)
		let penX = 0;
		let penY = 0;
		let penRawX = 0;
		let penRawY = 0;
		// Track the most recent moveTo position for close commands
		let moveX = 0;
		let moveY = 0;
		let moveRawX = 0;
		let moveRawY = 0;

		for (const [key, item] of orderedPathCommandEntries(path as XmlObject, ensureArray)) {
			if (!item || typeof item !== 'object') {
				if (key === 'a:close') {
					commands.push('Z');
					penX = moveX;
					penY = moveY;
				}
				continue;
			}

			const record = item as Record<string, unknown>;

			if (key === 'a:moveTo') {
				const pt = record['a:pt'] as Record<string, unknown> | undefined;
				if (pt) {
					const rawX = resolveCoordinate(pt['@_x'] as string | number | undefined, variables);
					const rawY = resolveCoordinate(pt['@_y'] as string | number | undefined, variables);
					const x = rawX * scaleX;
					const y = rawY * scaleY;
					commands.push(`M ${x} ${y}`);
					penX = x;
					penY = y;
					penRawX = rawX;
					penRawY = rawY;
					moveX = x;
					moveY = y;
					moveRawX = rawX;
					moveRawY = rawY;
				}
			} else if (key === 'a:lnTo') {
				const pt = record['a:pt'] as Record<string, unknown> | undefined;
				if (pt) {
					const rawX = resolveCoordinate(pt['@_x'] as string | number | undefined, variables);
					const rawY = resolveCoordinate(pt['@_y'] as string | number | undefined, variables);
					const x = rawX * scaleX;
					const y = rawY * scaleY;
					commands.push(`L ${x} ${y}`);
					penX = x;
					penY = y;
					penRawX = rawX;
					penRawY = rawY;
				}
			} else if (key === 'a:cubicBezTo') {
				const pts = ensureArray(record['a:pt']) as Array<Record<string, unknown>>;
				if (pts.length === 3) {
					const coords = pts.map((pt) => {
						const rawX = resolveCoordinate(pt['@_x'] as string | number | undefined, variables);
						const rawY = resolveCoordinate(pt['@_y'] as string | number | undefined, variables);
						return {
							x: rawX * scaleX,
							y: rawY * scaleY,
							rawX,
							rawY,
						};
					});
					commands.push(
						`C ${coords[0].x} ${coords[0].y} ${coords[1].x} ${coords[1].y} ${coords[2].x} ${coords[2].y}`,
					);
					penX = coords[2].x;
					penY = coords[2].y;
					penRawX = coords[2].rawX;
					penRawY = coords[2].rawY;
				}
			} else if (key === 'a:quadBezTo') {
				const pts = ensureArray(record['a:pt']) as Array<Record<string, unknown>>;
				if (pts.length === 2) {
					const coords = pts.map((pt) => {
						const rawX = resolveCoordinate(pt['@_x'] as string | number | undefined, variables);
						const rawY = resolveCoordinate(pt['@_y'] as string | number | undefined, variables);
						return {
							x: rawX * scaleX,
							y: rawY * scaleY,
							rawX,
							rawY,
						};
					});
					commands.push(`Q ${coords[0].x} ${coords[0].y} ${coords[1].x} ${coords[1].y}`);
					penX = coords[1].x;
					penY = coords[1].y;
					penRawX = coords[1].rawX;
					penRawY = coords[1].rawY;
				}
			} else if (key === 'a:arcTo') {
				const wR = resolveCoordinate(record['@_wR'] as string | number | undefined, variables);
				const hR = resolveCoordinate(record['@_hR'] as string | number | undefined, variables);
				const stAng = resolveCoordinate(
					record['@_stAng'] as string | number | undefined,
					variables,
				);
				const swAng = resolveCoordinate(
					record['@_swAng'] as string | number | undefined,
					variables,
				);

				const result = ooxmlArcToSvg(wR, hR, stAng, swAng, penRawX, penRawY, scaleX, scaleY);
				if (result) {
					commands.push(result.svg);
					penX = result.endX;
					penY = result.endY;
					penRawX = result.rawEndX;
					penRawY = result.rawEndY;
				}
			} else if (key === 'a:close') {
				commands.push('Z');
				penX = moveX;
				penY = moveY;
				penRawX = moveRawX;
				penRawY = moveRawY;
			}
		}

		if (commands.length > 0) {
			fullPathData += `${commands.join(' ')} `;
		}
	}

	const trimmed = fullPathData.trim();
	if (trimmed === '') {
		return null;
	}

	return {
		pathData: trimmed,
		pathWidth,
		pathHeight,
	};
}

// ---------------------------------------------------------------------------
// OOXML arcTo → SVG arc conversion (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Result of converting an OOXML `a:arcTo` command to SVG arc notation.
 */
interface ArcToResult {
	/** SVG arc path segment string (e.g. `"A 50 30 0 1 1 100 75"`). */
	svg: string;
	/** X coordinate of the arc endpoint. */
	endX: number;
	/** Y coordinate of the arc endpoint. */
	endY: number;
	/** Unscaled X coordinate of the arc endpoint in the path's own coordinate space. */
	rawEndX: number;
	/** Unscaled Y coordinate of the arc endpoint in the path's own coordinate space. */
	rawEndY: number;
}

/**
 * Convert an OOXML `a:arcTo` command to an SVG arc path segment.
 *
 * OOXML arcTo: the current pen position lies on an implicit ellipse at
 * angle `stAng`. The arc sweeps `swAng` degrees (in 60000ths). The
 * implicit ellipse center is derived from the current position and stAng.
 *
 * @param wR - Horizontal radius of the ellipse.
 * @param hR - Vertical radius of the ellipse.
 * @param stAng - Start angle in 60000ths of a degree.
 * @param swAng - Sweep angle in 60000ths of a degree.
 * @param penX - Current pen X position.
 * @param penY - Current pen Y position.
 */
export function ooxmlArcToSvg(
	wR: number,
	hR: number,
	stAng: number,
	swAng: number,
	penX: number,
	penY: number,
	scaleX = 1,
	scaleY = 1,
): ArcToResult | null {
	// Degenerate arcs: zero radius or zero sweep produce no visible arc
	if (wR <= 0 || hR <= 0 || swAng === 0) {
		return null;
	}

	const startVisRad = angleToRadians(stAng);
	const sweepRad = angleToRadians(swAng);
	const endVisRad = angleToRadians(stAng + swAng);

	// OOXML stores visual/geometric ray angles. SVG arcs use parametric ellipse
	// coordinates, so convert using the unscaled radii before applying path scale.
	const startRad = Math.atan2(wR * Math.sin(startVisRad), hR * Math.cos(startVisRad));
	const endRad = Math.atan2(wR * Math.sin(endVisRad), hR * Math.cos(endVisRad));

	const cx = penX - wR * Math.cos(startRad);
	const cy = penY - hR * Math.sin(startRad);

	// Compute the absolute endpoint on the ellipse at the end angle
	const rawEndX = cx + wR * Math.cos(endRad);
	const rawEndY = cy + hR * Math.sin(endRad);
	const endX = rawEndX * scaleX;
	const endY = rawEndY * scaleY;

	// SVG arc flags:
	// - large-arc-flag: 1 if the arc spans more than 180 degrees
	// - sweep-flag: 1 if the arc is drawn in the positive-angle direction
	const largeArc = Math.abs(sweepRad) > Math.PI ? 1 : 0;
	const sweep = sweepRad > 0 ? 1 : 0;

	// Round to 3 decimal places for clean SVG output
	const rx = Math.round(wR * scaleX * 1000) / 1000;
	const ry = Math.round(hR * scaleY * 1000) / 1000;
	const ex = Math.round(endX * 1000) / 1000;
	const ey = Math.round(endY * 1000) / 1000;

	return {
		svg: `A ${rx} ${ry} 0 ${largeArc} ${sweep} ${ex} ${ey}`,
		endX,
		endY,
		rawEndX,
		rawEndY,
	};
}
