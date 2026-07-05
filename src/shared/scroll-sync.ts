/**
 * Editor <-> preview scroll sync maths.
 *
 * Two sync strategies:
 * - Line-domain (preferred): a piecewise-linear map between source line and
 *   preview pixel offset, built from the engine's per-system anchors. Exact
 *   correspondence, doesn't drift on long documents.
 * - Fraction (fallback): one pane's scroll fraction (0 = top, 1 = bottom) is
 *   read from its scroll geometry and applied as a target scrollTop on the
 *   other pane. Used when anchors aren't available (older workers/goldens,
 *   or no layout yet).
 *
 * Pure logic, zero DOM/Vue dependencies - imported by TabCodeEditor.vue
 * (CodeMirror's view.scrollDOM + line-block APIs) and TabPreview.vue (the
 * containerRef div + measured page/anchor positions).
 */

/** A pane's current scroll position, exchanged between the two panes via App.vue. */
export interface ScrollPosition {
	/** Fractional source line, or null when the emitting pane can't map a line (no anchors/layout yet). */
	line: number | null;
	fraction: number;
}

export function scrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number {
	const scrollRange = scrollHeight - clientHeight;
	if (scrollRange <= 0) return 0;
	return Math.min(1, Math.max(0, scrollTop / scrollRange));
}

export function scrollTopForFraction(fraction: number, scrollHeight: number, clientHeight: number): number {
	const scrollRange = scrollHeight - clientHeight;
	if (scrollRange <= 0) return 0;
	return fraction * scrollRange;
}

/** Clamp a computed scrollTop into the pane's valid range. Never returns NaN/Infinity. */
export function clampScrollTop(target: number, scrollHeight: number, clientHeight: number): number {
	if (Number.isNaN(target)) return 0;
	const max = Math.max(0, scrollHeight - clientHeight);
	return Math.min(max, Math.max(0, target));
}

export interface LineOffsetPoint {
	line: number;
	offset: number;
}

export interface LineOffsetMap {
	lineToOffset(line: number): number;
	offsetToLine(offset: number): number;
}

function segmentSlope(a: LineOffsetPoint, b: LineOffsetPoint): number {
	const lineDelta = b.line - a.line;
	return lineDelta === 0 ? 0 : (b.offset - a.offset) / lineDelta;
}

/**
 * Build a piecewise-linear line<->offset map from anchor points (one per
 * typeset system: source line -> preview pixel offset).
 *
 * A synthetic knot at (line 1, offset 0) is prepended when the first real
 * point isn't already at line 1, so lines before the first anchor ramp
 * linearly from the document top - matching the way the preview renders
 * page 1's leading whitespace/title before its first system. Beyond the
 * last point, the map extends the final segment's slope; callers clamp the
 * resulting pixel/line value into their own valid range (clampScrollTop for
 * pixels, the doc's line count for CodeMirror).
 *
 * Returns null when there isn't enough information to build a mapping (0 or
 * 1 distinct source lines) - callers fall back to fraction-based sync.
 */
export function buildLineOffsetMap(points: LineOffsetPoint[]): LineOffsetMap | null {
	const sorted = [...points].sort((a, b) => a.line - b.line);
	const distinct: LineOffsetPoint[] = [];
	for (const point of sorted) {
		if (distinct.length === 0 || distinct[distinct.length - 1].line !== point.line) {
			distinct.push(point);
		}
	}
	if (distinct.length < 2) return null;

	// Enforce non-decreasing offsets: offsetToLine's bracket search assumes
	// each segment's offset range only grows, so a reversed segment (two
	// systems on one page at close y) is flattened into the earlier offset -
	// the existing flat-segment handling below then covers it, keeping
	// lineToOffset and offsetToLine in agreement.
	for (let i = 1; i < distinct.length; i++) {
		distinct[i] = { line: distinct[i].line, offset: Math.max(distinct[i].offset, distinct[i - 1].offset) };
	}

	const knots = distinct[0].line > 1 ? [{ line: 1, offset: 0 }, ...distinct] : distinct;

	function lineToOffset(line: number): number {
		const first = knots[0];
		const last = knots[knots.length - 1];
		if (line <= first.line) {
			const slope = segmentSlope(first, knots[1] ?? first);
			return first.offset + slope * (line - first.line);
		}
		if (line >= last.line) {
			const slope = segmentSlope(knots[knots.length - 2] ?? last, last);
			return last.offset + slope * (line - last.line);
		}
		for (let i = 0; i < knots.length - 1; i++) {
			const a = knots[i];
			const b = knots[i + 1];
			if (line >= a.line && line <= b.line) {
				return a.offset + segmentSlope(a, b) * (line - a.line);
			}
		}
		return last.offset;
	}

	function offsetToLine(offset: number): number {
		const first = knots[0];
		const last = knots[knots.length - 1];
		if (offset <= first.offset) {
			const slope = segmentSlope(first, knots[1] ?? first);
			return slope === 0 ? first.line : first.line + (offset - first.offset) / slope;
		}
		if (offset >= last.offset) {
			const slope = segmentSlope(knots[knots.length - 2] ?? last, last);
			return slope === 0 ? last.line : last.line + (offset - last.offset) / slope;
		}
		for (let i = 0; i < knots.length - 1; i++) {
			const a = knots[i];
			const b = knots[i + 1];
			if (offset >= a.offset && offset <= b.offset) {
				const slope = segmentSlope(a, b);
				return slope === 0 ? a.line : a.line + (offset - a.offset) / slope;
			}
		}
		return last.line;
	}

	return { lineToOffset, offsetToLine };
}
