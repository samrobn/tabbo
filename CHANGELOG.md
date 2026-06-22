# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0-alpha.4] - 2026-06-22

### Changed

- Save now writes back to the file you opened, instead of silently creating a separate copy in your Documents folder.
- Opening a file refreshes the live preview immediately, rather than waiting for the next edit.

### Added

- Rename a document inline in the title; saving under the new name writes a copy and leaves the original untouched.
- Save confirms before creating a copy or overwriting an existing file, and shows an error if a save fails.
- Start a new document from File → New (Cmd+N).
- Quitting with unsaved changes prompts you to Save, Discard, or Cancel.
- Tabbo reopens your last file on launch, and offers to recover unsaved work after an unexpected quit or crash.

## [0.1.0-alpha.3] - 2026-05-23

### Changed

- README install instructions clarified: link to the releases page, drop stale "private testers" framing.

## [0.1.0-alpha.2] - 2026-05-23

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

[Unreleased]: https://github.com/samrobn/tabbo/compare/v0.1.0-alpha.4...HEAD
[0.1.0-alpha.4]: https://github.com/samrobn/tabbo/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/samrobn/tabbo/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/samrobn/tabbo/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/samrobn/tabbo/releases/tag/v0.1.0-alpha.1
