# Releasing Tabbo

Tabbo ships from two repos:

- **`samrobn/tabbo-dev`** (private, this repo) — source of truth.
  All development happens here. Has `.github/workflows/sync-public.yml`
  which opens a PR on the public repo when a `v*` tag is pushed.
- **`samrobn/tabbo`** (public) — release surface. The auto-updater
  fetches from this repo's releases (`release.baseUrl` in
  `electrobun.config.ts`). Has its own `.github/workflows/release.yml`
  (a copy of this repo's) which builds the macOS app and uploads
  artefacts when a `v*` tag is pushed on the public side.

Each release goes through a review gate: the sync workflow opens a PR
on the public repo, the maintainer reviews the diff against the checklist
below, then squash-merges and tags. Nothing is auto-merged.

## Cutting a release

1. **Update `CHANGELOG.md` on `tabbo-dev`.** Add an entry under
   `[Unreleased]` describing user-visible changes only — no internal
   refactors, no commit hashes, no task IDs. Match the voice of
   Anthropic's `claude-code` public CHANGELOG: terse, present-tense,
   one bullet per change.

2. **Bump the version in `package.json`.** `electrobun.config.ts` reads
   it via `pkg.version`, so this single bump propagates to the bundle
   identifier and update manifest.

3. **Commit, push to `tabbo-dev`'s `main`.**

4. **Tag and push the tag:**

   ```bash
   git tag v0.1.0-alpha.2
   git push origin v0.1.0-alpha.2
   ```

5. **Watch the sync workflow** at `tabbo-dev` → Actions → "Sync to
   public". It clones the tagged tree, strips private paths (see
   "What gets stripped" below), pushes a release branch to
   `samrobn/tabbo`, and opens a PR titled `Release v0.1.0-alpha.2`.

6. **Review the PR on `samrobn/tabbo`** using the checklist below.

7. **Squash-merge** the PR on the public repo (do *not* rebase or
   merge — squashing keeps the public history one-commit-per-release).

8. **Tag the public repo** with the same version:

   ```bash
   cd /path/to/public-tabbo-clone
   git pull
   git tag v0.1.0-alpha.2
   git push origin v0.1.0-alpha.2
   ```

   This fires the public repo's `release.yml`, which builds the macOS
   app and uploads `.app.tar.gz`, `.dmg`, the update manifest, and
   `CHANGELOG.md` as a GitHub release.

9. **Probe the update feed** before declaring done:

   ```bash
   curl -sI "https://github.com/samrobn/tabbo/releases/latest/download/stable-macos-arm64-update.json"
   ```

   Must return `200`. A `404` means the release didn't publish
   correctly or the asset name is wrong; existing installs will not
   see the update.

10. **Verify on a real install.** Launch the previous version on a
    machine that has it installed. The update modal should appear
    within a second of launch. Click "Update now"; confirm download
    progress, click "Restart", confirm the relaunched app reports the
    new version.

## Pre-merge review checklist

Run through this before squash-merging the public PR. The first three
items catch sanitisation regressions; the rest catch release-mechanics
mistakes.

- [ ] No new files inside `.claude/` paths slipped through the strip.
      The diff should show zero `.claude/**` files.
- [ ] No new personal info (home-directory paths, real names beyond
      `samrobn`, machine names, email addresses other than Wayne's
      in `engine/`), internal task references (`TASK-YYYYMMDD-XXXX`,
      4-character short codes), or vault wiki-links (`[[...]]`) added
      since the previous public release. Spot-check `git diff` of the
      PR for these patterns.
- [ ] No new credential-shaped strings: `sk-`, `ghp_`, `xoxb-`, JWT,
      AWS access keys, anything that looks like `API_KEY=...`.
- [ ] No new AI-tool references in non-`.claude/` files (Claude,
      ChatGPT, MCP, agent-team, "the user" framing).
- [ ] `CHANGELOG.md` has an entry for the version being released,
      written user-facing.
- [ ] `engine/` directory still preserves Wayne Cripps's copyright
      notices. Spot-check 2-3 random `.cc` files that previously
      carried the notice.
- [ ] Version in `package.json`, the tag, and `CHANGELOG.md` all agree.
- [ ] `release.baseUrl` in `electrobun.config.ts` still points at
      `samrobn/tabbo/releases/latest/download` (i.e. the public repo,
      not `tabbo-dev`).

## What gets stripped

The sync workflow removes these paths from the tree it pushes to the
public repo:

- `.claude/` — agent rules, project memory, anything reviewer-facing
- `evals/dev/` — dev-only eval scratch (already gitignored, defensive)
- `dist-releases/` — local release-artefact downloads (already gitignored)
- `artifacts/`, `dist/`, `build/` — build outputs (already gitignored)

The strip-list lives in [`.publicignore`](.publicignore) as the
single source of truth. `.github/workflows/sync-public.yml` reads
that file via `rsync --exclude-from`. Adding a new private-only
path means editing `.publicignore`, not the workflow.

## Alpha.1 → alpha.2 caveat

Users on `0.1.0-alpha.1` do *not* have the in-app updater (it was
added in alpha.2). They will never see the update modal and must
re-download manually. The alpha.2 CHANGELOG entry calls this out.
From alpha.2 onwards, in-app updates work end-to-end.

## Signing and notarisation (deferred)

Releases currently ship unsigned. macOS Gatekeeper shows *"Tabbo is
damaged and can't be opened"* on first launch; the README install
instructions document the `xattr -dr com.apple.quarantine` workaround.
Proper signing requires Apple Developer Program enrolment ($99/yr),
a Developer ID cert stored as a GitHub secret, and a `notarytool`
step after build. `postbuild.ts` already gates its codesign step on
`ELECTROBUN_DEVELOPER_ID`; turning signing on is a `release.yml`-only
change when the cert is available.
