# Visual review checklist

`bun run evals` now fails the run on byte drift against the committed goldens (PS and JSON pipelines both gated; a Ghostscript version mismatch skips the PS byte-compare only, per `evals/README.md`). This checklist is for the acknowledgement step when a diff is intentional: after regenerating goldens (`bun evals/regenerate-goldens.ts` / `bun evals/regenerate-goldens-json.ts`), use it to judge whether the new goldens are visually correct before committing them — the byte gate only catches that something changed, not whether the change is right.

How to compare engine output against committed goldens.

The harness produces two PNG sets per fixture per run — review BOTH:

- **PS pipeline**: `evals/runs/<ts>/<fixture>-p<N>.png` against `evals/goldens/<fixture>-p<N>.png`. Goldens come from the upstream reference binary; mismatch means the local engine has diverged from upstream PS output.
- **JSON pipeline**: `evals/runs/<ts>/json/<fixture>-p<N>.png` against `evals/goldens-json/<fixture>-p<N>.png`. Goldens come from the local engine itself (current commit); mismatch means JSON-path output changed since the last golden bump.

A regression in only the JSON set indicates the bug is in `engine/src/output/json_print.cc` or `src/shared/layout-render.ts` — the PS pipeline doesn't touch either. A regression in both means it's in shared layout (`engine/src/layout/`) or earlier.

## How to compare

Open each pair in order: golden first, then run PNG. Compare them side by side.

- PS golden: `evals/goldens/<fixture>-p<N>.png`
- PS run:    `evals/runs/<latest-timestamp>/<fixture>-p<N>.png`
- JSON golden: `evals/goldens-json/<fixture>-p<N>.png`
- JSON run:    `evals/runs/<latest-timestamp>/json/<fixture>-p<N>.png`

Work through each fixture, page by page, in both pipelines.

## Comparison checklist

Check in this order:

1. **Page geometry** - dimensions, margins, orientation match.
2. **Staff/system lines** - count, spacing, and alignment across the page match. *(JSON pipeline: staff lines not yet emitted — skip this check on `evals/runs/<ts>/json/` PNGs.)*
3. **Glyphs** - fret numbers, ornaments, flags: shape fidelity and position on the correct line.
4. **Rhythm flags / beams** - stem direction, beam slope, flag shapes match.
5. **Barlines** - position, height, count per system match. *(JSON pipeline: barlines not yet emitted — skip on JSON PNGs.)*
6. **Text** - titles, section labels, lyrics: font, size, horizontal and vertical alignment match.
7. **Multi-page** - margins and running elements are consistent across pages.

## Acceptable vs unacceptable differences

OK:
- Sub-pixel anti-aliasing shifts (a single-pixel-wide edge moving 1 px).

Not OK:
- Any missing glyph.
- Any glyph that changed shape.
- Any misaligned beam.
- Any clipped text.
- Any change in page count.
- Any staff line that moved more than ~2 px.

## Caveat: what the PNGs actually capture

**PS pipeline** renders `.ps` -> `.pdf` (via `gs -sDEVICE=pdfwrite`) -> `.png` (via `gs -sDEVICE=png16m`). The PNGs are Ghostscript's rasterisation of the PDF page, not the user's in-app view (the app uses PDF.js).

Practical consequence: changes to PostScript metadata that `pdfwrite` absorbs but does not propagate to the rendered page will NOT show up in the PNGs. Notably, `%%BoundingBox` and other DSC comments at the top of the PS are informational - `pdfwrite` uses the PS page device's media box, not the comment, for the PDF's page size. If you tweak a DSC comment and the eval PNG is byte-identical to the golden, that is expected, not a bug in the harness. Tweak an actual drawing primitive (`moveto`, `lineto`, `translate`, `scale`, font sizes) to verify visual regression paths.

**JSON pipeline** drives `engine/tab -worker`, generates SVG via `src/shared/layout-render.ts` (the same code the live preview uses), and rasterises via `@napi-rs/canvas` (Skia). Because Skia and Ghostscript are different rasterisers and use different fonts (woff2 vector outlines for tab glyphs vs Type 3 PS bitmaps; Tinos vs Times), pixel diffs between PS and JSON sets are meaningless — only intra-pipeline diffs are. Known JSON-path gaps: staff lines and barlines are not yet emitted on the JSON path (engine work outstanding); `fi` ligature in body text renders as `®` due to encoding differences between the engine's MacOS Roman emission and modern Unicode body fonts.

## Regenerating goldens

- **PS goldens**: `bun evals/regenerate-goldens.ts` (uses upstream reference binary at `evals/reference/tab` — see `evals/REFERENCE.md`).
- **JSON goldens**: `bun evals/regenerate-goldens-json.ts` (uses local engine at `engine/tab`). Bump after intentional output changes in `json_print.cc`, shared layout, or `src/shared/layout-render.ts`. Records the engine commit sha in `MANIFEST.json` so future readers can trace which engine snapshot a golden reflects.
- **WOFF2 coverage golden**: `bun evals/fonts-coverage.ts --update-golden` after an intentional font change (`.mf` sources, `build-woff2-fonts.sh` output, or `pua-mapping.json`). Eyeball `engine/dev/preview.html` first; the script refuses to write on a non-deterministic render. `bun run evals` re-runs the comparison automatically whenever the font sources' hash differs from the golden manifest.
