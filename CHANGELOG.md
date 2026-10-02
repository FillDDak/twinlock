# Changelog

All notable changes to Twinlock are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-02

### Added

- Real-time checking of `LINT.IfChange` / `LINT.ThenChange` blocks in any language, including unsaved edits.
- Obligations shown on both sides: the changed block lists outdated targets, and each target file is told it needs an update.
- Targets: whole files (`//path`), labeled blocks (`//path:label`), same-file labels (`:label`), relative paths, and multi-line target lists.
- Recognition of 20+ comment styles, nested blocks, quoted targets and bracketed lists.
- Precise change detection: only guarded lines count. Directive-only edits, wrapping existing code in a new block, and line-ending changes are ignored.
- Git baselines (`HEAD` or any ref, optionally via merge base), with session baselines for files outside git, git-ignored files and Restricted Mode.
- Support for nested repositories and submodules; `.gitignore` is respected when indexing.
- CodeLens, hover previews of linked code, Go to Definition, Find All References, quick fixes and diffs against the baseline.
- **Linked Changes** view in the Source Control sidebar, with a badge, plus a status bar summary.
- **Link Selection** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>L</kbd>): links two selections in their own comment syntax with a suggested label. Supports whole-file links, including to JSON files.
- Acknowledgements for blocks that need no linked change. They are stored per workspace and expire when the block changes again.
- Error diagnostics for broken links, unmatched or unclosed directives, invalid labels and duplicate labels.
- Settings for the baseline ref, severity, directive namespace, excludes, limits and inserted comment syntax; theme colors for the highlights.
