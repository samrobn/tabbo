# Tabbo

Professional typesetter for lute tablature, supporting renaissance and baroque lutes in French and Italian notation. Works like TeX - processes plain text `.tab` files into beautiful output.

## Alpha

An early alpha — expect rough edges. The [latest release](https://github.com/samrobn/tabbo/releases/latest) is always the current build.

### Install

1. Download `stable-macos-arm64-Tabbo.dmg` from the [latest release](https://github.com/samrobn/tabbo/releases/latest).
2. Open the `.dmg` and drag Tabbo to Applications.

Future updates land in-app: the update modal appears when a new release is available, downloads in the background, and restarts to apply.

### Saving and exporting

- Click the filename (the chevron button at the top-left of the editor) to open the document menu: rename the file and choose which folder it saves to. Both apply on the next save.
- `Cmd+S` saves - silently on success (the **Edited** badge clears). A file you opened is saved back in place; a new document defaults to `~/Documents/Tabbo/`. Saving into a folder that already holds a file of that name asks before replacing it.
- `Cmd+Shift+E` exports a PDF to the same folder and shows a "Saved to ..." toast; re-exporting with the same name overwrites it.
- Save and export errors show a red toast at the top of the preview pane.

### Unsaved changes

- A muted **Edited** badge appears next to the filename when there are unsaved changes, and fades out when you save.
- Opening another file, starting a new one, or loading a template prompts before discarding edits.
- `Cmd+Q` and closing the window prompt to Save, Discard, or Cancel when there are unsaved changes. The buffer is also autosaved every 30 seconds and on focus loss, so a force-quit still restores your work on relaunch.

### Multi-page scores

- The preview shows page 1 only. `Cmd+Shift+E` exports the full PDF.

### Known rough edges

- No app icon yet — appears with the default Electrobun icon.
- Some glyphs in the live preview render slightly off vs the exported PDF (course letters, staff lines). The PDF export is correct.

## Project structure

Tabbo is an [Electrobun](https://blackboard.sh/electrobun/) desktop app wrapping the C++ tab typesetting engine.

```
tabbo/
├── engine/         # C++ typesetting engine (Make build, produces `tab` binary)
│   ├── src/        # Two-pass typesetter (input → layout → output backends)
│   ├── fonts/      # METAFONT sources, TFM metrics, PK bitmaps, WOFF2 vectors
│   └── examples/   # Sample .tab files
├── gs/             # Minimal Ghostscript build (PS-to-PDF, self-contained)
├── src/
│   ├── bun/        # Electrobun main process (compiler pipeline, RPC, file/menu/settings)
│   ├── shared/     # Shared RPC types
│   └── mainview/   # Vue 3 webview (CodeMirror editor + PDF/live preview)
├── evals/          # Visual regression fixtures and goldens
└── electrobun.config.ts
```

## Build and run

```bash
bun install            # install dependencies
bun run start          # build engine + gs + app, launch desktop app
bun run test           # run bun-side test suite
cd engine && make      # build the tab engine binary in isolation
bun run evals          # visual regression run against goldens
```

Production-style build:

```bash
bun run build:stable   # produces a .app and .dmg in build/
```

### Prerequisites

- macOS with Xcode Command Line Tools (`xcode-select --install`) — required for the C++ engine build and the minimal Ghostscript build.
- [Bun](https://bun.sh) v1.3 or later.

First-time setup builds the C++ engine and a minimal Ghostscript:

```bash
cd engine && make             # produces engine/tab
cd ../gs && bash build-gs.sh  # produces gs/gs-minimal (~25 MB, cached)
cd ..
```

After that, `bun run start` builds the Vite bundle, packages the app, and launches it; subsequent runs reuse the cached binaries.

## About this fork

A desktop port of [Wayne Cripps' Tab program](https://www.cs.dartmouth.edu/~wbc/lute/AboutTab.html) (originally [mandovinnie/Lute-Tab](https://github.com/mandovinnie/Lute-Tab)). The C++ engine retains the two-pass TeX-like architecture and METAFONT fonts; everything around it (live preview, PDF export, packaging) is new.

What this fork adds: an Electrobun-based desktop app around the engine (live preview, PDF export, file management), a JSON layout-output backend driving the preview, a worker-mode CLI for incremental compilation, and a Vite/Vue webview with a CodeMirror editor. The engine's two-pass TeX-like architecture, METAFONT sources, and PostScript output backend are preserved upstream-compatible. See `git log engine/` for the per-file change history.

## Documentation

- [`engine/AboutTab.txt`](engine/AboutTab.txt) — `.tab` file format reference (from upstream).

End-user documentation (UI walkthrough, keyboard reference, troubleshooting) is in progress.

## Credits

- **Original author**: Wayne Cripps (Tab v4.3.108)
- **Desktop app**: samrobn
- **Fonts**: METAFONT sources by Wayne Cripps; WOFF2 vectors derived from the same.

## License

Wrapper code (everything outside `engine/`) is MIT-licensed. The `engine/` directory carries Wayne Cripps's separate terms (free use with attribution, no commercial use without permission). See [`LICENSE`](LICENSE) for the full text and SPDX expression.

## Issues

https://github.com/samrobn/tabbo/issues
