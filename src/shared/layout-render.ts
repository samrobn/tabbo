/**
 * Shared primitive→render-item logic for the live preview and the eval harness.
 *
 * Both `src/mainview/src/TabLayoutRenderer.vue` (live preview, in-browser SVG)
 * and `evals/render-json.ts` (offline, @napi-rs/canvas SVG→PNG) depend on this
 * module so the two paths cannot drift visually. Adding a primitive type
 * means: (1) extend `LayoutPrimitive` in rpc-types, (2) add a case here, (3)
 * add a render branch in `renderItemToSvg` below — and both consumers pick it
 * up automatically.
 *
 * Pure logic, zero Vue/runtime dependencies.
 */

import type { LayoutPrimitive, LayoutResult, FontDescriptor } from "./rpc-types";

// DVI integer units → PostScript points. The engine emits page geometry in
// inches (`(int)(8.5 * inch_to_dvi(1.0))`), where `inch_to_dvi(1.0) = 9472573`.
// Convert via DVI/inch then PS pt/inch (72) — NOT TeX pt (72.27), which would
// inflate dimensions by ~0.4% and produce captures 5px off the goldens.
export const DVI_PER_INCH = 9472573;
export const PT_PER_INCH = 72;
export const dviToPt = (n: number): number => (n / DVI_PER_INCH) * PT_PER_INCH;

/*
 * Tab font size lookup: inferred from family name suffix.
 * "85" → 8.5pt; others are whole numbers.
 */
const TAB_FONT_SIZES: Record<string, number> = {
	lute6: 6,    lute7: 7,    lute8: 8,    lute85: 8.5,    lute9: 9,
	blute6: 6,   blute7: 7,   blute8: 8,   blute85: 8.5,   blute9: 9,
	tlute6: 6,   tlute7: 7,   tlute8: 8,   tlute85: 8.5,   tlute9: 9,
};

export function tabFontSizePt(family: string): number {
	return TAB_FONT_SIZES[family] ?? 9;
}

/*
 * Text font substitution.
 * The engine outputs PostScript logical font names (NewCenturySchlbk-Roman,
 * Courier-Bold, etc.). We map to reliable web stacks.
 */
export function substituteTextFont(family: string): string {
	if (family.toLowerCase().includes("courier")) {
		return "'Courier New', monospace";
	}
	return "TabboBody, Georgia, 'Times New Roman', serif";
}

// Editorial-highlight colours: match the exported PDF (ps_print P_S_GRAY/RED/BLUE)
// so the on-screen preview shows the author's Q/@ markings identically. Gray =
// PS `0.5 setgray`; red = CMYK(0,1,1,0); blue = CMYK(0.5,0.5,0,0).
const HIGHLIGHT_FILL: Record<string, string> = { gray: "#808080", red: "#ff0000", blue: "#8080ff" };
export function highlightFill(h?: "gray" | "red" | "blue"): string | undefined {
	return h ? HIGHLIGHT_FILL[h] : undefined;
}

export type GlyphItem      = { kind: "glyph";       x: number; y: number; fontFamily: string; fontSize: number; char: string; fill?: string };
export type TextRunItem    = { kind: "text_run";    x: number; y: number; fontFamily: string; fontSize: number; text: string; fill?: string };
export type RuleItem       = { kind: "rule";        x: number; y: number; width: number; height: number; fill?: string };
export type PathItem       = { kind: "path";        d: string };
export type FilledPathItem = { kind: "filled-path"; d: string };
export type LineItem       = { kind: "line";        x1: number; y1: number; x2: number; y2: number; strokeWidth: number };
export type SlashItem      = { kind: "slash";       rects: Array<{ x: number; y: number; width: number; height: number }> };

export type RenderItem = GlyphItem | TextRunItem | RuleItem | PathItem | FilledPathItem | LineItem | SlashItem;

export function toRenderItem(p: LayoutPrimitive, fonts: Map<number, FontDescriptor>): RenderItem {
	switch (p.type) {

		case "glyph": {
			const font = fonts.get(p.font_id);
			const family = font?.family ?? "lute9";
			return {
				kind: "glyph",
				x: dviToPt(p.x),
				y: dviToPt(p.y),
				fontFamily: family,
				fontSize: tabFontSizePt(family),
				char: String.fromCodePoint(p.char_code),
				fill: highlightFill(p.highlight),
			};
		}

		case "text_run": {
			const font = fonts.get(p.font_id);
			// Tab-font text runs (e.g. json_print::set_a_char composing a
			// two-digit N-number glyph from PUA codepoints on font 0) must use
			// the lute WOFF2 face directly. substituteTextFont is for body
			// text (titles/lyrics) only — applying it here sends PUA
			// codepoints to Georgia/Times, which have no such glyph (tofu).
			if (font?.type === "tab") {
				return {
					kind: "text_run",
					x: dviToPt(p.x),
					y: dviToPt(p.y),
					fontFamily: font.family,
					fontSize: tabFontSizePt(font.family),
					text: p.text,
					fill: highlightFill(p.highlight),
				};
			}
			return {
				kind: "text_run",
				x: dviToPt(p.x),
				y: dviToPt(p.y),
				fontFamily: substituteTextFont(font?.family ?? ""),
				fontSize: font?.size_pt ?? 12,
				text: p.text,
				fill: highlightFill(p.highlight),
			};
		}

		case "rule": {
			return {
				kind: "rule",
				fill: highlightFill(p.highlight),
				x: dviToPt(p.x),
				y: dviToPt(p.y),
				width: dviToPt(p.width),
				// Minimum 0.25pt so thin rules (staff lines) stay visible.
				// Side effect: a negative h is also clamped to 0.25 — i.e. an
				// invisible hairline. PostScript treats negative h as "draw down"
				// from the moveto; if json_print or beam.cc ever emits that, the
				// rule disappears here. Engine side must pre-negate (see
				// beam.cc beamup JSON_OUT branch).
				height: Math.max(dviToPt(p.height), 0.25),
			};
		}

		case "tie": {
			const x = dviToPt(p.x);
			const y = dviToPt(p.y);
			const length = dviToPt(p.length);
			const isHalf     = p.variant === "half" || p.variant === "half_reversed";
			const isReversed = p.variant === "reversed" || p.variant === "half_reversed";
			const endX = x + (isHalf ? length / 2 : length);
			const bowY = isReversed ? y + length * 0.2 : y - length * 0.2;
			const cpX1 = x + (endX - x) * 0.25;
			const cpX2 = x + (endX - x) * 0.75;
			return { kind: "path", d: `M ${x} ${y} C ${cpX1} ${bowY} ${cpX2} ${bowY} ${endX} ${y}` };
		}

		case "rtie": {
			const x = dviToPt(p.x);
			const y = dviToPt(p.y);
			const length = dviToPt(p.length);
			const bowY = y + length * 0.2;
			const cpX1 = x + length * 0.25;
			const cpX2 = x + length * 0.75;
			return { kind: "path", d: `M ${x} ${y} C ${cpX1} ${bowY} ${cpX2} ${bowY} ${x + length} ${y}` };
		}

		case "slash": {
			// Horizontal beam-bar rules matching ps_print::put_slash.
			// Engine draws `count` horizontal rules of `width` wide and 0.005 in thick,
			// stepping down by (0.03 in + 0.06/count) in between each bar.
			//
			// Note: this branch uses TeX pt/inch (72.27) for the inch→pt conversion,
			// while the rest of the renderer uses PS pt/inch (72) via dviToPt. Pre-existing
			// inconsistency preserved verbatim during the 2026-05-01 extraction; goldens
			// were generated against this exact constant. Don't "fix" to 72 without
			// regenerating evals/goldens-json/ and confirming the change is intentional.
			// Engine emits thickness in DVI units (0.023 in under LSA_FORM, else
			// 0.005 in - see json_print::put_slash). Convert with the same 72.27
			// factor as the rest of this branch; fall back to the historical
			// constant when the field is absent (output predating it).
			const thicknessPt = p.thickness !== undefined
				? (p.thickness / DVI_PER_INCH) * 72.27
				: 0.005 * 72.27;
			const x = dviToPt(p.x);
			const y = dviToPt(p.y);
			const width = dviToPt(p.width);
			const stepPt = (0.03 + 0.06 / p.count) * 72.27;
			return {
				kind: "slash",
				rects: Array.from({ length: p.count }, (_, i) => ({
					x,
					y: y + i * stepPt,
					width,
					height: thicknessPt,
				})),
			};
		}

		case "uline": {
			const x = dviToPt(p.x);
			const y = dviToPt(p.y);
			const w = dviToPt(p.width);

			if (p.variant === "wide") {
				// Filled 4-segment wave matching PS dowslur (ps_print.cc): up-bump
				// then down-bump over 6 deltas, 1.8pt-thick return path, ±0.2pt
				// end tweaks. PS is y-up; offsets are negated for SVG's y-down.
				const delta = w / 6;
				const height = 3.7;
				const thick = 1.8;
				const d = [
					`M ${x} ${y + height}`,
					`C ${x + delta} ${y - height} ${x + 2 * delta} ${y - height} ${x + 3 * delta} ${y + 0.2}`,
					`C ${x + 4 * delta} ${y + height} ${x + 5 * delta} ${y + height} ${x + 6 * delta} ${y - 0.6 * height}`,
					`C ${x + 5 * delta} ${y + height + thick} ${x + 4 * delta} ${y + height + thick} ${x + 3 * delta} ${y - 0.2}`,
					`C ${x + 2 * delta} ${y - height + thick} ${x + delta} ${y - height + thick} ${x} ${y + height}`,
					"Z",
				].join(" ");
				return { kind: "filled-path", d };
			}

			// Closed filled cubic-bezier lozenge matching PS dorslur / doslur.
			const delta = w / 3;

			const isReversed = p.variant === "reversed";
			const apexOffset = isReversed ? -5 : 5;
			const thickOffset = isReversed ? -1.8 : 1.8;
			const apexY = y + apexOffset;

			const d = [
				`M ${x} ${y}`,
				`C ${x + delta} ${apexY} ${x + 2 * delta} ${apexY} ${x + 3 * delta} ${y}`,
				`C ${x + 2 * delta} ${apexY + thickOffset} ${x + delta} ${apexY + thickOffset} ${x} ${y}`,
				"Z",
			].join(" ");

			return { kind: "filled-path", d };
		}

		case "slant": {
			// Fallback prevents stroke-width="undefined" if a future engine
			// introduces a weight variant before the type union is updated.
			const strokeWidth = { thin: 0.5, medium: 1, thick: 1.5 }[p.weight] ?? 0.5;
			return {
				kind: "line",
				x1: dviToPt(p.x1),
				y1: dviToPt(p.y1),
				x2: dviToPt(p.x2),
				y2: dviToPt(p.y2),
				strokeWidth,
			};
		}

		case "curve": {
			const x = dviToPt(p.x);
			const y = dviToPt(p.y);
			const len = dviToPt(p.length);
			const bowX = x + len * 0.3;
			return {
				kind: "path",
				d: `M ${x} ${y} C ${bowX} ${y + len * 0.25} ${bowX} ${y + len * 0.75} ${x} ${y + len}`,
			};
		}
	}
}

export function buildFontMap(layout: LayoutResult): Map<number, FontDescriptor> {
	return new Map(layout.fonts.map(f => [f.font_id, f]));
}

// Escape XML special chars in text-node content. Only `&`, `<`, `>` —
// quotes are not escaped because callers only embed escaped output between
// element tags (text_run, glyph), never inside attribute values.
function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Render a single RenderItem to an SVG element string. Mirrors the per-kind
 * branches in TabLayoutRenderer.vue's <template>.
 */
export function renderItemToSvg(item: RenderItem): string {
	switch (item.kind) {
		case "glyph":
			return `<text x="${item.x}" y="${item.y}" font-family="${item.fontFamily}" font-size="${item.fontSize}" fill="${item.fill ?? "black"}" dominant-baseline="auto">${xmlEscape(item.char)}</text>`;
		case "text_run":
			// Note: substituteTextFont may include single quotes (e.g. "'Courier New', monospace").
			// SVG/HTML attributes can hold single quotes when wrapped in double quotes.
			return `<text x="${item.x}" y="${item.y}" font-family="${item.fontFamily}" font-size="${item.fontSize}" fill="${item.fill ?? "black"}" dominant-baseline="auto">${xmlEscape(item.text)}</text>`;
		case "rule":
			return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="${item.fill ?? "black"}"/>`;
		case "path":
			return `<path d="${item.d}" fill="none" stroke="black" stroke-width="0.5"/>`;
		case "filled-path":
			return `<path d="${item.d}" fill="black" stroke="none"/>`;
		case "line":
			return `<line x1="${item.x1}" y1="${item.y1}" x2="${item.x2}" y2="${item.y2}" stroke="black" stroke-width="${item.strokeWidth}"/>`;
		case "slash":
			return item.rects
				.map(r => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="black"/>`)
				.join("");
	}
}

export interface SvgPage {
	pageNum: number;
	svg: string;
	widthPt: number;
	heightPt: number;
}

/**
 * Convert a LayoutResult to one self-contained SVG string per page.
 *
 * The output mirrors TabLayoutRenderer.vue's template: a viewBox-only <svg>
 * with a single content translate of (left_margin, top_margin), then per-system
 * groups containing rendered primitives. The eval harness rasterises these via
 * @napi-rs/canvas; the live preview consumes the same RenderItem shapes through
 * a Vue template instead.
 */
export function layoutToSvgPages(layout: LayoutResult): SvgPage[] {
	const fonts = buildFontMap(layout);
	const widthPt = dviToPt(layout.page_width_dvi);
	const heightPt = dviToPt(layout.page_height_dvi);
	const leftMarginPt = dviToPt(layout.left_margin_dvi);
	const topMarginPt = dviToPt(layout.top_margin_dvi);

	return layout.pages.map(page => {
		const systemsSvg = page.systems
			.map(system => {
				const items = system.primitives
					.map(p => renderItemToSvg(toRenderItem(p, fonts)))
					.join("");
				return `<g>${items}</g>`;
			})
			.join("");

		const svg = [
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPt} ${heightPt}" width="${widthPt}" height="${heightPt}">`,
			`<g transform="translate(${leftMarginPt}, ${topMarginPt})">`,
			systemsSvg,
			`</g>`,
			`</svg>`,
		].join("");

		return { pageNum: page.page_num, svg, widthPt, heightPt };
	});
}
