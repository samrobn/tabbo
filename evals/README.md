# Evals

Visual regression testing for the `engine/tab` typesetting engine. The existing test suite (`bun run test`) confirms the pipeline produces a PDF, but it cannot catch rendering regressions - a change that misaligns beams, drops glyphs, or shifts staff spacing would pass all unit tests. This harness renders known `.tab` inputs to PNG for comparison against committed reference images.

## How it works

- **Ghostscript harness** (`evals/run.ts`): renders `.tab` → `.ps` → `.pdf` (via `gs -sDEVICE=pdfwrite`) → `.png` (via `gs -sDEVICE=png16m`). Goldens at `evals/goldens/`. Catches engine-level regressions. Also runs the JSON pipeline (`engine/tab -worker` + Skia rasterisation) against goldens at `evals/goldens-json/`.

**Goldens** are rendered by the upstream reference engine, not the local `engine/tab`. They represent what the canonical upstream binary produces. A mismatch means the local engine has diverged from upstream - intentionally or not.

**`bun run evals` fails the run (non-zero exit) on byte drift against either committed golden set.** Every rendered page is byte-compared against `evals/goldens/` (PS) and `evals/goldens-json/` (JSON); a content difference, a new page with no committed golden, or a missing page all count as a failure. If the resolved Ghostscript version doesn't match what the PS goldens were rendered with (`evals/goldens/MANIFEST.json`), the PS byte-compare is skipped for that run (loud warning printed) since the drift would be from Ghostscript, not the engine - the JSON-pipeline compare still runs and can still fail. A small number of pages are permanently skipped in the PS compare because the reference binary shares a bug a local fix corrects - see "Known PS divergences" in `evals/REFERENCE.md`. The intentional-change flow is unchanged: regenerate via `bun evals/regenerate-goldens.ts` (PS) / `bun evals/regenerate-goldens-json.ts` (JSON), visually review per `evals/REVIEW.md`, and commit the new goldens as the acknowledgement step - the byte gate only catches that something changed, not whether the change is correct.

### Retired: PDF.js harness (2026-04-27)

`evals/run-app.ts` and `evals/regenerate-goldens-app.ts` were retired in Phase 3 of the live-preview refactor. The Phase 3 webview renders layout SVG directly rather than routing through PDF.js, so there is no longer a PDF.js rasteriser path in the live preview. The export-PDF path (the only remaining path that produces a PDF) is covered by the Ghostscript harness above. `pdfjs-dist` was removed from `package.json` as part of the same phase.

See `evals/REFERENCE.md` for details on the reference engine, its pinned commit, and how to bump the pin.

## Run

```
bun run evals              # Ghostscript harness, all fixtures
bun run evals simple       # Ghostscript harness, single fixture by name
```

Fixtures: `simple`, `demo`, `sample`, `c`, `t`, `accents`, `uline-wide`, `n-numbers`, `pagenum`, `barnums` (authoritative list: `FIXTURES` in `utils.ts`).

Output lands in `evals/runs/<timestamp>/` (gitignored). Each fixture produces a `.ps`, `.pdf`, and one `.png` per rendered page.

## Directory structure

```
evals/
  run.ts                      - Ghostscript harness (local engine: .tab -> .ps -> .pdf -> .png)
  regenerate-goldens.ts       - Overwrites evals/goldens/ using the upstream reference engine (Ghostscript)
  fixtures/                   - Frozen copies of engine/examples/*.tab
  goldens/                    - Committed reference PNGs + MANIFEST.json (Ghostscript-rendered)
  reference/                  - Pre-built upstream reference binary and fonts (pinned commit)
  runs/                       - Gitignored per-run outputs
  REFERENCE.md                - Reference engine documentation and pin-bumping instructions
```

## Regenerating goldens

Run this after consciously bumping the reference engine pin in `evals/reference/`, or after an intentional engine change that you have verified is correct and want to promote to the new baseline:

```
bun run evals/regenerate-goldens.ts      # Ghostscript goldens (evals/goldens/)
```

The pinned upstream reference binary aborts (SIGABRT, empty stderr) on long absolute paths - a fixed-size path buffer upstream; the fork's own binary is unaffected. The script therefore invokes it with repo-relative paths (`cwd` pinned to the repo root), which keeps regeneration working from long-path checkouts such as `.claude/worktrees/`.

The script runs the full pipeline using the upstream reference binary, copies the resulting PNGs to `evals/goldens/`, and rewrites `MANIFEST.json`. Review the git diff before committing. See `evals/REFERENCE.md` for the full procedure.

## When to run the harness

After any change to `engine/src/**`, `engine/fonts/**`, or the `gs` build flags in `gs/build-gs.sh`. The comparison procedure is in `evals/REVIEW.md`.

## Fixture coverage gaps

The current fixtures do not exercise every code path in the engine. Known gap: `simple.tab` runs the standard portrait `else` branch in `engine/src/output/ps_print.cc` (around line 337) but never the `LSA_FORM` branch at line 331. Regressions isolated to the `LSA_FORM` path will sail through a `simple`-only run. If you are changing code in a branch none of the current fixtures cover, add a new fixture that exercises it before relying on evals to catch the regression.
