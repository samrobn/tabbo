# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0-alpha.2] - 2026-05-23

> **Manual re-download required.** Alpha.1 doesn't include the in-app updater (it's new in this release), so the update modal will never appear in your installed copy. Download alpha.2 manually from the [releases page](https://github.com/samrobn/tabbo/releases/latest) once to bootstrap. From alpha.2 onwards, updates land in-app.

### Added

- In-app auto-update with a changelog modal. New releases show a "What's new" panel; click "Update now" to download in the background, then "Restart" to apply.

### Changed

- Install instructions updated for macOS Sequoia 15+: use `xattr -dr com.apple.quarantine /Applications/Tabbo.app` to clear the quarantine flag (the right-click → Open workaround is gone in recent macOS).

## [0.1.0-alpha.1] - 2026-04-29

### Added

- Initial alpha release of Tabbo: a native macOS desktop app for lute tablature typesetting.
- Tab source editor with CodeMirror (syntax highlighting, undo/redo, keyboard shortcuts).
- Live preview pane: re-renders the current tab source on every edit via the C++ `tab` engine and Ghostscript PS-to-PDF pipeline.
- Inline error display — compile errors from the engine appear directly below the editor.
- Open and save `.tab` files via the File menu.
- Guard against silent loss of unsaved edits: confirmation prompt before closing or opening a new file when the buffer is dirty.
- Preview stability: stopped flicker between successive recompiles.
- Bundled lute tablature fonts (renaissance, baroque, thin variants) and Ghostscript for self-contained offline use.

[Unreleased]: https://github.com/samrobn/tabbo/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/samrobn/tabbo/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/samrobn/tabbo/releases/tag/v0.1.0-alpha.1
