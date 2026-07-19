/**
 * TabPreview render truth table.
 *
 * The three top-level branches are deliberately independent v-ifs (not a
 * v-if/v-else chain) so the renderer stays mounted during recompiles - the
 * preview-flicker fix. This pins the (isLoading x layout) matrix that was
 * previously only hand-derived in review.
 */
import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import TabPreview from "./TabPreview.vue";
import { COMPILE_MESSAGES } from "../constants";
import type { LayoutResult } from "../../../shared/rpc-types";

const minimalLayout: LayoutResult = {
	schema_version: 1,
	page_width_dvi: 9472573,
	page_height_dvi: 9472573,
	left_margin_dvi: 0,
	top_margin_dvi: 0,
	staff_len_dvi: 0,
	fonts: [],
	pages: [],
	errors: [],
};

function mountPreview(isLoading: boolean, layout: LayoutResult | null) {
	return mount(TabPreview, {
		props: { isLoading, layout, scrollSync: true },
		global: {
			stubs: {
				// The SVG renderer exercises font/layout plumbing beyond this
				// component's own branching - presence is what the table pins.
				TabLayoutRenderer: true,
			},
		},
	});
}

describe("TabPreview render truth table (isLoading x layout)", () => {
	test("loading, no layout: spinner only", () => {
		const wrapper = mountPreview(true, null);
		expect(wrapper.text()).toContain(COMPILE_MESSAGES.COMPILING);
		expect(wrapper.findComponent({ name: "TabLayoutRenderer" }).exists()).toBe(false);
		expect(wrapper.text()).not.toContain(COMPILE_MESSAGES.EMPTY_PREVIEW);
	});

	test("loading, layout present: renderer stays mounted, no spinner", () => {
		const wrapper = mountPreview(true, minimalLayout);
		expect(wrapper.text()).not.toContain(COMPILE_MESSAGES.COMPILING);
		expect(wrapper.findComponent({ name: "TabLayoutRenderer" }).exists()).toBe(true);
		expect(wrapper.text()).not.toContain(COMPILE_MESSAGES.EMPTY_PREVIEW);
	});

	test("idle, no layout: empty-preview message only", () => {
		const wrapper = mountPreview(false, null);
		expect(wrapper.text()).not.toContain(COMPILE_MESSAGES.COMPILING);
		expect(wrapper.findComponent({ name: "TabLayoutRenderer" }).exists()).toBe(false);
		expect(wrapper.text()).toContain(COMPILE_MESSAGES.EMPTY_PREVIEW);
	});

	test("idle, layout present: renderer only", () => {
		const wrapper = mountPreview(false, minimalLayout);
		expect(wrapper.text()).not.toContain(COMPILE_MESSAGES.COMPILING);
		expect(wrapper.findComponent({ name: "TabLayoutRenderer" }).exists()).toBe(true);
		expect(wrapper.text()).not.toContain(COMPILE_MESSAGES.EMPTY_PREVIEW);
	});
});
