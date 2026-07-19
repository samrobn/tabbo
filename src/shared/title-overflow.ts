import type { LayoutResult } from "./rpc-types";

// Title text runs render on the title font. The engine's title font is 2 by
// default and 3 under ALTTITLE (engine/src/layout/title.cc: `title_font = 2`,
// `font = 3` when ALTTITLE is set; a text-font directive is clamped to {2,3} in
// dvi_f.cc). Lyrics render on font 1, tab glyphs on font 0 — both excluded.
const TITLE_FONT_IDS = new Set([2, 3]);

// AMEND-2: a source title line opens with `{` OR `[` — both dispatch to
// `dotitle` (engine/src/parse/tab_p.cc `case '{'` and `case '['`). Counting
// only `{` mis-aligns the ordinal map on documents that mix the two.
const TITLE_OPENER = /^\s*[{[]/;

/**
 * 1-based source line numbers of top-of-document `{}`/`[]` title lines whose
 * layout is over-wide — the title's right-aligned segment will collide with
 * the overrunning left text on export (the engine never wraps titles). Warns
 * the author in the editor before that collision.
 *
 * Signal: within a title line, some title-font run's rendered extent
 * (`x + width`) crosses into the start `x` of the next run — the `/`-hfill
 * split placed the right segment where the overrunning left text already
 * reaches. Reads only engine-emitted geometry (x and the TFM run advance); no
 * source-text char-count arithmetic (satisfies the "geometry, not char count"
 * requirement). This catches the visible collision exactly, including the
 * sub-word tail overlap the earlier start-position-only test missed.
 */
export function overflowingTitleLines(layout: LayoutResult, source: string): number[] {
  const page = layout.pages?.[0];
  if (!page) return [];

  // AMEND-3: restrict to page 0, above the first music system. Titles carry no
  // source provenance in the layout, so the ordinal source<->layout map is only
  // safe for the leading title block; a title interspersed with music goes
  // inert (returns []) rather than risk a mis-targeted flag. "Above" == smaller
  // y (top-left origin, y grows downward — verified against real worker JSON).
  let firstMusicY = Infinity;
  for (const anchor of layout.anchors ?? []) {
    if (anchor.page === page.page_num && anchor.y < firstMusicY) firstMusicY = anchor.y;
  }

  // AMEND-1: group title runs by (page, y). We already restrict to page 0, so
  // bucketing by y here is per-(page, y) — a page-1 title sharing a y can never
  // fuse into a page-0 group and fake a backward x-step. Insertion order of the
  // map == emission order == top-to-bottom, which aligns with source order.
  const runsByLine = new Map<number, TitleRun[]>();
  for (const system of page.systems) {
    for (const primitive of system.primitives) {
      if (primitive.type !== "text_run" || !TITLE_FONT_IDS.has(primitive.font_id)) continue;
      if (primitive.y >= firstMusicY) continue; // below first music: not top-block
      let runs = runsByLine.get(primitive.y);
      if (!runs) {
        runs = [];
        runsByLine.set(primitive.y, runs);
      }
      // Emission order preserved — do NOT sort by x, that destroys the signal.
      // width defaults to 0 for output predating the field, which degrades the
      // extent test to the old start-monotonicity check (an exact equivalent
      // for detecting non-monotonic starts), so old data still lints safely.
      runs.push({ x: primitive.x, width: primitive.width ?? 0 });
    }
  }
  const layoutTitleGroups = [...runsByLine.values()];

  // Leading source title block: the first contiguous run of `{`/`[` opener
  // lines (AMEND-2 + AMEND-3). Skip preceding directives/comments/blanks to
  // find the run start, then stop at the first non-opener line.
  const lines = source.split("\n");
  const leadingTitleLineNumbers: number[] = [];
  let started = false;
  for (let index = 0; index < lines.length; index++) {
    if (TITLE_OPENER.test(lines[index])) {
      leadingTitleLineNumbers.push(index + 1);
      started = true;
    } else if (started) {
      break;
    }
  }

  // Ordinal-map guard: only map when the counts agree. Any mismatch (multi-line
  // `{ … \n … }` blocks, an unexpected extra top-block run) yields no
  // diagnostic — a missed lint is fine, a mis-targeted flag is not.
  if (layoutTitleGroups.length !== leadingTitleLineNumbers.length) return [];

  const overflowing: number[] = [];
  for (let index = 0; index < layoutTitleGroups.length; index++) {
    if (hasExtentOverlap(layoutTitleGroups[index])) {
      overflowing.push(leadingTitleLineNumbers[index]);
    }
  }
  return overflowing;
}

interface TitleRun {
  x: number;
  width: number;
}

// A title line overflows iff, in emission order, some run's rendered end
// (`x + width`) crosses the start `x` of the next run. Normal words carry a
// positive space gap between end and next start; the only case that closes it
// is the `/`-hfill split placing the right segment where the overrunning left
// text already reaches — i.e. exactly the visible collision. Strictly more
// sensitive than the previous start-monotonicity test (with widths ≥ 0, an
// overlap subsumes every backward start-step) and no false positives.
//
// Residual (missed warning, never a wrong flag): a title with no `/` split —
// a single run that simply runs off the right page edge. With one run there is
// no next run to overlap. Catching it needs a content-right-margin compare,
// deferred as a separate, rarer case.
function hasExtentOverlap(runs: TitleRun[]): boolean {
  for (let index = 0; index < runs.length - 1; index++) {
    if (runs[index].x + runs[index].width > runs[index + 1].x) return true;
  }
  return false;
}
