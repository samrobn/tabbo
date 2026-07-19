import { describe, expect, test } from "bun:test";
import { toRenderItem, renderItemToSvg, highlightFill } from "./layout-render";
import type { FontDescriptor, LayoutPrimitive } from "./rpc-types";

// The editorial-highlight path (author's Q/@ markings): the engine stamps a
// `highlight` colour on glyph/rule primitives; the renderer must colour them so
// the preview matches the exported PDF. Absent highlight → black (unchanged).

const fonts = new Map<number, FontDescriptor>([
	[0, { font_id: 0, family: "lute9", type: "tab", size_pt: 9 }],
]);

describe("highlightFill", () => {
	test("maps each highlight to its export colour", () => {
		expect(highlightFill("gray")).toBe("#808080");
		expect(highlightFill("red")).toBe("#ff0000");
		expect(highlightFill("blue")).toBe("#8080ff");
	});
	test("undefined highlight → undefined (renders black downstream)", () => {
		expect(highlightFill(undefined)).toBeUndefined();
	});
});

describe("toRenderItem carries highlight → fill", () => {
	test("highlighted glyph gets the grey fill", () => {
		const p: LayoutPrimitive = { type: "glyph", font_id: 0, char_code: 65, x: 0, y: 0, highlight: "gray" };
		const item = toRenderItem(p, fonts);
		expect(item.kind).toBe("glyph");
		expect((item as { fill?: string }).fill).toBe("#808080");
	});

	test("un-highlighted glyph has no fill (→ black)", () => {
		const p: LayoutPrimitive = { type: "glyph", font_id: 0, char_code: 65, x: 0, y: 0 };
		const item = toRenderItem(p, fonts);
		expect((item as { fill?: string }).fill).toBeUndefined();
	});

	test("highlighted rule (barline) gets the colour", () => {
		const p: LayoutPrimitive = { type: "rule", x: 0, y: 0, width: 100, height: 10, highlight: "red" };
		const item = toRenderItem(p, fonts);
		expect(item.kind).toBe("rule");
		expect((item as { fill?: string }).fill).toBe("#ff0000");
	});

	test("highlighted font-0 text_run (two-digit fret tens digit) gets the colour", () => {
		// The engine draws the tens digit of a two-digit fret as a font-0
		// text_run via set_a_char; under a Q/@ highlight it must colour too, so
		// the whole number matches the export (not just the units-digit glyph).
		const p: LayoutPrimitive = { type: "text_run", font_id: 0, x: 0, y: 0, text: "1", highlight: "gray" };
		const item = toRenderItem(p, fonts);
		expect(item.kind).toBe("text_run");
		expect((item as { fill?: string }).fill).toBe("#808080");
	});

	test("un-highlighted body text_run stays black (no fill)", () => {
		const bodyFonts = new Map<number, FontDescriptor>([
			[2, { font_id: 2, family: "Times", type: "text", size_pt: 12 }],
		]);
		const p: LayoutPrimitive = { type: "text_run", font_id: 2, x: 0, y: 0, text: "Title" };
		const item = toRenderItem(p, bodyFonts);
		expect((item as { fill?: string }).fill).toBeUndefined();
	});
});

describe("renderItemToSvg honours fill", () => {
	test("highlighted glyph renders with the colour, not black", () => {
		const p: LayoutPrimitive = { type: "glyph", font_id: 0, char_code: 65, x: 0, y: 0, highlight: "gray" };
		const svg = renderItemToSvg(toRenderItem(p, fonts));
		expect(svg).toContain('fill="#808080"');
		expect(svg).not.toContain('fill="black"');
	});

	test("un-highlighted glyph stays black", () => {
		const p: LayoutPrimitive = { type: "glyph", font_id: 0, char_code: 65, x: 0, y: 0 };
		const svg = renderItemToSvg(toRenderItem(p, fonts));
		expect(svg).toContain('fill="black"');
	});

	test("highlighted rule renders coloured", () => {
		const p: LayoutPrimitive = { type: "rule", x: 0, y: 0, width: 100, height: 10, highlight: "blue" };
		const svg = renderItemToSvg(toRenderItem(p, fonts));
		expect(svg).toContain('fill="#8080ff"');
	});
});
