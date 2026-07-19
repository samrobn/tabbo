import { describe, expect, test } from "bun:test";
import { overflowingTitleLines } from "./title-overflow";
import type { Anchor, LayoutPrimitive, LayoutResult } from "./rpc-types";

// --- synthetic LayoutResult builders (no engine needed) ---------------------
// A title line's words are separate title-font (font 2/3) text_runs sharing one
// y, emitted in source order. Over-wide == one run's extent (x + width) crosses
// the next run's start x (widths default to 0 for start-only fixtures).

function run(x: number, y: number, font_id = 2, width = 0): LayoutPrimitive {
  return { type: "text_run", font_id, x, y, width, text: "w" };
}

function makeLayout(
  pages: { page_num: number; runs: LayoutPrimitive[] }[],
  anchors?: Anchor[],
): LayoutResult {
  return {
    schema_version: 1,
    page_width_dvi: 60_000_000,
    page_height_dvi: 80_000_000,
    left_margin_dvi: 9_472_573,
    top_margin_dvi: 9_472_573,
    staff_len_dvi: 54_724_951,
    fonts: [{ font_id: 2, family: "pncr", type: "text", size_pt: 10.7 }],
    pages: pages.map((p) => ({
      page_num: p.page_num,
      systems: [{ system_num: 0, primitives: p.runs }],
    })),
    anchors,
    errors: [],
  };
}

describe("overflowingTitleLines", () => {
  test("fitting single title (monotonic x) → []", () => {
    const layout = makeLayout(
      [{ page_num: 1, runs: [run(0, 0), run(1000, 0), run(2000, 0)] }],
      [{ line: 3, page: 1, y: 5000 }],
    );
    expect(overflowingTitleLines(layout, "{Fits fine}\n\nb")).toEqual([]);
  });

  test("over-wide single title (one backward x-step) → [its line]", () => {
    // x steps back (5000 -> 3000): the `/`-split negative-gap collision.
    const layout = makeLayout(
      [{ page_num: 1, runs: [run(0, 0), run(5000, 0), run(3000, 0)] }],
      [{ line: 3, page: 1, y: 5000 }],
    );
    expect(overflowingTitleLines(layout, "{Way too wide indeed/Author}\n\nb")).toEqual([1]);
  });

  test("two leading titles, only the 2nd over-wide → [2nd line]", () => {
    const layout = makeLayout(
      [
        {
          page_num: 1,
          runs: [
            run(0, 0), run(1000, 0), // line 1: fits
            run(0, 2000), run(5000, 2000), run(3000, 2000), // line 2: backward
          ],
        },
      ],
      [{ line: 3, page: 1, y: 8000 }],
    );
    expect(overflowingTitleLines(layout, "{Fine}\n{Wide/A}\nb")).toEqual([2]);
  });

  test("AMEND-1: page-0 and page-1 titles sharing a y stay separate → []", () => {
    // Naive grouping by y alone would fuse page-0 [0, 5000] with page-1 [3000]
    // into [0, 5000, 3000] and fake a backward step. Grouping per (page, y)
    // (we only read page 0) keeps page 0 monotonic.
    const layout = makeLayout(
      [
        { page_num: 1, runs: [run(0, 0), run(5000, 0)] },
        { page_num: 2, runs: [run(3000, 0)] },
      ],
      [
        { line: 3, page: 1, y: 8000 },
        { line: 9, page: 2, y: 8000 },
      ],
    );
    expect(overflowingTitleLines(layout, "{Top title}\n\nb")).toEqual([]);
  });

  test("AMEND-2: a leading `[`-title is counted, so the ordinal map aligns", () => {
    // Line 1 opens with `[`, line 2 with `{`. Counting only `{` would give 1
    // source title vs 2 layout groups → mismatch → inert. Counting both keeps
    // the map aligned so the over-wide brace title (line 2) flags correctly and
    // the fitting bracket title (line 1) does not.
    const layout = makeLayout(
      [
        {
          page_num: 1,
          runs: [
            run(0, 0), run(1000, 0), // line 1 `[...]`: fits
            run(0, 2000), run(5000, 2000), run(3000, 2000), // line 2 `{...}`: backward
          ],
        },
      ],
      [{ line: 3, page: 1, y: 8000 }],
    );
    expect(overflowingTitleLines(layout, "[Bracket title]\n{Brace wide/A}\nb")).toEqual([2]);
  });

  test("AMEND-2: a fitting lone `[`-title is not flagged → []", () => {
    const layout = makeLayout(
      [{ page_num: 1, runs: [run(0, 0), run(1000, 0)] }],
      [{ line: 3, page: 1, y: 5000 }],
    );
    expect(overflowingTitleLines(layout, "[Just brackets]\n\nb")).toEqual([]);
  });

  test("guard: a leading `{}` that emits zero runs (count mismatch) → []", () => {
    // Source has one title line but the layout emitted no title runs for it.
    const layout = makeLayout(
      [{ page_num: 1, runs: [] }],
      [{ line: 2, page: 1, y: 5000 }],
    );
    expect(overflowingTitleLines(layout, "{Empty}\nb")).toEqual([]);
  });

  test("AMEND-3: an over-wide title below the first music anchor → []", () => {
    // First music is at y=1000 (line 1). The over-wide title sits at y=5000,
    // below it, so it is outside the top block and never linted.
    const layout = makeLayout(
      [{ page_num: 1, runs: [run(0, 5000), run(5000, 5000), run(3000, 5000)] }],
      [{ line: 1, page: 1, y: 1000 }],
    );
    expect(overflowingTitleLines(layout, "b\n{Wide but below/A}")).toEqual([]);
  });

  test("no-title document → []", () => {
    const layout = makeLayout(
      [{ page_num: 1, runs: [] }],
      [{ line: 1, page: 1, y: 1000 }],
    );
    expect(overflowingTitleLines(layout, "b\nc\nd")).toEqual([]);
  });

  test("empty layout (no pages) → []", () => {
    const layout = makeLayout([], []);
    expect(overflowingTitleLines(layout, "{Anything}")).toEqual([]);
  });

  test("tail overlap with monotonic starts (sub-word) → [its line]", () => {
    // The user's case: run starts are strictly increasing (0 < 3500 < 10000),
    // so the old start-monotonicity test returned [] (missed the collision).
    // But the wide middle word's rendered end (3500 + 8000 = 11500) crosses the
    // right segment's start (10000) — a visible tail overlap the extent test
    // catches. This case would fail (return []) under the old start-only logic.
    const layout = makeLayout(
      [
        {
          page_num: 1,
          runs: [
            run(0, 0, 2, 3000),
            run(3500, 0, 2, 8000), // wide word: end 11500 crosses next start
            run(10000, 0, 2, 5000), // right segment starts left of prior end
          ],
        },
      ],
      [{ line: 3, page: 1, y: 8000 }],
    );
    expect(overflowingTitleLines(layout, "{Wide left tail/Author}\n\nb")).toEqual([1]);
  });

  test("monotonic starts with space gaps (fitting title) → []", () => {
    // Same start monotonicity, but each word's end sits left of the next start
    // (a real space gap) — no overlap, so no false positive from the widths.
    const layout = makeLayout(
      [
        {
          page_num: 1,
          runs: [
            run(0, 0, 2, 900),
            run(1000, 0, 2, 900),
            run(2000, 0, 2, 900),
          ],
        },
      ],
      [{ line: 3, page: 1, y: 8000 }],
    );
    expect(overflowingTitleLines(layout, "{A fitting title}\n\nb")).toEqual([]);
  });

  test("ALTTITLE font 3 runs are recognised as titles", () => {
    const layout = makeLayout(
      [{ page_num: 1, runs: [run(0, 0, 3), run(5000, 0, 3), run(3000, 0, 3)] }],
      [{ line: 3, page: 1, y: 8000 }],
    );
    expect(overflowingTitleLines(layout, "{Alt wide/A}\n\nb")).toEqual([1]);
  });
});
