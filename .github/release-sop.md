# Release SOP

The written procedure for releasing `@rcrsr/mcp-policy-server`. `/conduct:cut-release`
reads this file in its Phase 2 and treats it as authoritative over its own auto-detection;
a maintainer releasing by hand follows the same steps. Keep the two in agreement: when the
release machinery changes, change this file in the same PR.

## 1. Scope

- One package, no workspaces, no qualifier. Every release is a whole-repository release.
- Versioning: Semantic Versioning 2.0.0. Prereleases use `-rc.N` (`0.7.0-rc.1`).
- Registry: npmjs.com, public, via npm trusted publishing. No `NPM_TOKEN` secret exists.

## 2. Version source of truth

`package.json` `version` is the source of truth. `SERVER_VERSION` in `src/server.ts` reads
it at build time, so no source file carries a copy.

`package-lock.json` holds the same value twice (root and `packages[""]`). Do not hand-edit
either file. Bump both in one step:

```bash
npm version {version} --no-git-tag-version
```

This is the `{sync-cmd}`. It rewrites `package.json` and `package-lock.json` and nothing
else. Verify with:

```bash
git diff --stat            # exactly package.json and package-lock.json
git grep -n '"version"' -- package.json package-lock.json | grep -v "{version}"   # empty
```

## 3. Changelog

One file: `CHANGELOG.md`, Keep a Changelog 1.1.0, bracketed headings.

1. Rename `## [Unreleased]` to `## [{version}] - {YYYY-MM-DD}` (today's date, UTC).
2. Insert a fresh `## [Unreleased]` heading directly above it, followed by one blank line.
3. In the link-reference block at the bottom, add a compare line above the previous
   version's line:
   `[{version}]: https://github.com/rcrsr/mcp-policy-server/compare/v{previous}...v{version}`
   The file keeps no `[Unreleased]:` reference line; do not add one.
4. Every entry under the dated heading ends with a PR link: `([#N](.../pull/N))`.

Gate: an empty `Unreleased` section means there is nothing to release. Stop.

## 4. Names

| Thing          | Format                                | Example                       |
| -------------- | ------------------------------------- | ----------------------------- |
| Branch         | `release/{version}`                   | `release/0.7.0`               |
| Release commit | `chore(release): {version}`           | `chore(release): 0.7.0`       |
| Squash subject | `chore(release): {version} (#{pr})`   | `chore(release): 0.7.0 (#12)` |
| PR title       | `Release {version}`                   | `Release 0.7.0`               |
| Tag            | `v{version}`, annotated               | `v0.7.0`                      |
| GitHub Release | title `v{version}`, created by CI     | see section 6                 |

## 5. Pre-flight

Run before branching. All four must hold.

```bash
git status --porcelain                                   # empty
git checkout main && git pull --ff-only                  # at origin/main
gh run list --branch main --limit 1 --json conclusion    # "success"
npm view @rcrsr/mcp-policy-server@{version} version      # fails: not yet published
```

## 6. What the tag triggers

Pushing `v{version}` runs `.github/workflows/release.yml`, which:

1. Fails if the tag does not equal `package.json` `version`. A tag pushed against a stale
   manifest publishes nothing.
2. Runs `npm run check` (typecheck, lint, format, tests with coverage thresholds, knip).
3. Publishes with `npm publish --provenance --access public`. Authentication is the OIDC
   token from `id-token: write`; the npm package settings name `rcrsr/mcp-policy-server`
   and `release.yml` as the trusted publisher. Skips when the registry already holds that
   version.
4. Creates the GitHub Release with `--generate-notes`.

Consequence for `/conduct:cut-release`: `{deploy-tag}` is true for `release.yml`
(auto-generates release notes, no deploy). Phase 8.3 must skip `gh release create`; the
workflow owns the release object. After the workflow finishes, replace the generated notes
with the PR narrative:

```bash
gh release edit v{version} --notes "{narrative}"
```

## 7. Procedure

1. Pre-flight (section 5).
2. `git checkout -b release/{version}`
3. `npm version {version} --no-git-tag-version`
4. Stamp `CHANGELOG.md` (section 3).
5. `git add package.json package-lock.json CHANGELOG.md`
   `git commit -m "chore(release): {version}"`
6. `git push -u origin release/{version}`
7. Open the PR: title `Release {version}`, body = prose narrative of the release, then a
   `## Changes` section (the stamped entries by category for 12 or fewer entries, one
   bullet per theme above that). The `area:docs` and `area:dx` labels arrive automatically.
8. Wait until `mergeStateStatus` is `CLEAN`, zero unresolved review threads, zero failing
   or pending checks. Required checks: `check (22)`, `check (24)`, `check (26)`, CodeQL,
   Dependency review.
9. `gh pr merge {pr} --squash --subject "chore(release): {version} (#{pr})"`
10. `git checkout main && git pull --ff-only`
    `git tag -a v{version} -m "Release {version}"`
    `git push origin v{version}`
11. Watch `gh run watch` for the Release workflow. On success, edit the release notes
    (section 6). For a prerelease, also `gh release edit v{version} --prerelease`.

## 8. Post-release verification

```bash
npm view @rcrsr/mcp-policy-server version                # {version}
npm view @rcrsr/mcp-policy-server --json | jq .dist.attestations.url   # provenance present
gh release view v{version} --json isDraft,isPrerelease,body
npx -y @rcrsr/mcp-policy-server@{version} --version 2>/dev/null || true
```

## 9. Recovery

- **Release workflow failed before publish** (tag/manifest mismatch, `check` red): the
  registry is untouched. Fix forward on `main`, delete the tag locally and remotely
  (`git tag -d v{version}; git push origin :refs/tags/v{version}`), and re-tag the fixed
  commit. Only safe while nothing was published under that version.
- **Published, then a defect found:** never unpublish or retag. Cut a patch release.
  `npm deprecate @rcrsr/mcp-policy-server@{version} "use {patch}"` once the patch is live.
- **Publish succeeded, GitHub Release missing:** re-run the workflow. The publish step
  detects the existing version and skips; the release step creates the missing object.
- **E403 from npm:** a trusted-publisher mismatch, not a version conflict. Check the
  package's trusted publisher entry names this repository, `release.yml`, and no
  environment. Do not treat it as already-published.
