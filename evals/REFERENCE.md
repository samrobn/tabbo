# Reference engine

`evals/reference/` contains a pre-built binary of the upstream `tab` typesetter, pinned to a specific commit of the original repository. It exists so that goldens reflect upstream output rather than whatever the local engine happens to produce - this is what makes `bun run evals` a real regression test rather than a tautology.

## Current pin

- **Commit**: `ea6465df2bee21ff3d52122dbd2bce872c803732`
- **Source**: https://github.com/mandovinnie/Lute-Tab
- **Message**: "At Paul Overells's suggestion fix the -o option with the -pdf output command"
- **Date**: 2026-01-25
- **Platform**: arm64 macOS only (Darwin arm64)

The pin is deliberate. Goldens only regenerate when the pin is consciously bumped - the reference is not auto-tracked to upstream master.

This specific commit was chosen because it sits after the Aug 2025 burst of visually-relevant upstream changes (font widths, new `-R` sizes, autoKey fix) and is the latest available. The Jan 2026 commit itself is a `-pdf` fix we don't use. Upstream is otherwise dormant.

## Contents

- `tab` - the upstream binary, built from the pinned commit
- `fonts/` - the upstream font files (`.tfm` metrics and `.pk` bitmaps) at the same commit
- `VERSION` - machine-readable record of the commit sha, date, source URL, and build platform

## How the harness uses this

- `regenerate-goldens.ts` uses the reference binary to render goldens. Goldens represent upstream output.
- `run.ts` uses the local `engine/tab` binary. Running `bun run evals` renders the local engine's output for comparison against the reference goldens. A visual mismatch means the local engine has diverged from upstream.

## Bumping the pin

When upstream has a meaningful change you want to track:

1. Clone upstream and check out the new commit:
   ```
   git clone https://github.com/mandovinnie/Lute-Tab.git /tmp/lute-tab-reference
   cd /tmp/lute-tab-reference
   git checkout <new-sha>
   ```

2. Build the binary (no source edits - the reference must be unmodified upstream):
   ```
   make
   ```
   If the build fails due to compiler warnings being treated as errors, add `-Wno-error` via `CXXFLAGS` on the command line. Do not edit upstream source.

3. Copy the artefacts into `evals/reference/`:
   ```
   cp /tmp/lute-tab-reference/tab evals/reference/tab
   chmod +x evals/reference/tab
   cp /tmp/lute-tab-reference/*.tfm evals/reference/fonts/
   cp /tmp/lute-tab-reference/*.300pk /tmp/lute-tab-reference/*.600pk \
      /tmp/lute-tab-reference/*.1200pk /tmp/lute-tab-reference/*.2400pk \
      evals/reference/fonts/
   ```

4. Update `evals/reference/VERSION` with the new sha, date, and source URL.

5. Regenerate all goldens and review the diff:
   ```
   bun run evals/regenerate-goldens.ts
   git diff --stat evals/goldens/
   ```
   Use your image viewer to confirm all changes are intentional upstream changes, not regressions introduced here.

6. Commit the updated binary, fonts, VERSION, and goldens together.

## Platform caveat

The committed binary is arm64 macOS only. Cross-platform support (building a reference binary per CI platform) is a future item.

## Note: upstream `TFM_PATH` is stale

The upstream Makefile bakes an absolute font path (`TFM_PATH`) into the binary via the `TLOC` macro, and the committed upstream state points at a maintainer's personal directory (`/Users/j.w.j.burgers/Documents/TAB/`). The upstream setup guide tells new users to edit the Makefile and set `TLOC` to their own `Lute-Tab` checkout before building.

We skip that step deliberately. `regenerate-goldens.ts` always sets `TABFONTS` at runtime, which overrides the compiled-in path. The binary works correctly regardless of the stale `TFM_PATH`.

If you ever invoke `evals/reference/tab` manually without `TABFONTS`, expect `File In: Can't open /Users/j.w.j.burgers/...` messages. That is not a bug - always pass `TABFONTS=evals/reference/fonts` when invoking the reference binary by hand.
