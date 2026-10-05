# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`[PROFORMA]` tag:** A heading tagged `[PROFORMA]` marks boilerplate the hook never injects, in either `full` or `digest` mode. The tag covers the section's nested subsections and overrides `[IMPORTANT]` at any depth. `list-sections` reports a `proforma` field, and `check` reports `[IMPORTANT]` under a `[PROFORMA]` ancestor as `TAG_CONFLICT`. `fetch-policies` and `fetch_policies` still return proforma text.

### Changed

- **Full mode tag lookup:** Full mode now reads the policy files for section tags, so it denies with `Policy resolution failed:` when they cannot be re-read.

## [0.8.3] - 2026-10-01

### Added

- **`policy-mode` agent frontmatter:** An agent file can set `policy-mode: full|digest|digest-minimal` to choose its own injection mode. Precedence is frontmatter, then `--mode`/`--digest-minimal`, then `full`. An invalid value denies with a reason naming the agent file and value. A digest mode from frontmatter falls back to full when the agent declares `tools:` without `Bash`. `--debug` logs the resolved mode and its source. ([#46](https://github.com/rcrsr/mcp-policy-server/pull/46))

### Fixed

- **Digest full text omitted:** Digest mode now injects full text for every section marked `(full text below)`. An untagged `###` descendant of a tagged `###` section was listed as full text but left out. ([#46](https://github.com/rcrsr/mcp-policy-server/pull/46))

## [0.8.2] - 2026-10-01

### Security

- **Regex injection:** Section extraction escapes the prefix and section number before building a regex, so metacharacters match literally. ([#41](https://github.com/rcrsr/mcp-policy-server/pull/41))
- **ReDoS:** Agent tool detection splits the `tools:` line into tokens and matches each against an anchored pattern for `mcp__*policy-server__fetch_policies`, avoiding superlinear backtracking. ([#41](https://github.com/rcrsr/mcp-policy-server/pull/41))

## [0.8.1] - 2026-10-01

### Changed

- **Dependency update:** Updated all npm dependencies to latest, including `@modelcontextprotocol/sdk` 1.31.0 and `oxfmt` 0.71.0, and bumped `github/codeql-action` to v4.38.0. ([#39](https://github.com/rcrsr/mcp-policy-server/pull/39))
- **Dependabot scope:** Dependabot now opens PRs only for security advisories, grouped into one PR per run. Routine version bumps are off. ([#39](https://github.com/rcrsr/mcp-policy-server/pull/39))

### Security

- **Transitive advisories:** Resolved advisories in `fast-uri` (3.1.8), `ip-address` (10.7.2), and `brace-expansion` (5.0.12). `npm audit` reports 0 vulnerabilities. ([#39](https://github.com/rcrsr/mcp-policy-server/pull/39))

## [0.8.0] - 2026-09-30

### Added

- **Digest mode for policy-hook:** `--mode digest` injects one `§ID Title: first sentence` line per section, then the full text of `[IMPORTANT]` sections, then a footer on how to fetch the rest. Options: `--digest-depth`, `--digest-line-chars`, `--digest-minimal` (title-only lines), and `--fetch-instructions` (replaces the default footer). Full mode stays the default and is unchanged. ([#29](https://github.com/rcrsr/mcp-policy-server/pull/29))
- **[IMPORTANT] section tag:** `## {§PY.7} [IMPORTANT] Title` marks a section and its children to be injected in full in digest mode. `policy-cli check` reports `MALFORMED_TAG` errors and `list-sections` gains an `important` field. ([#29](https://github.com/rcrsr/mcp-policy-server/pull/29))
- **§ references in fetch-policies:** `policy-cli fetch-policies §PY.4 §PY.7.2` resolves references given as arguments, with the same expansion and de-duplication as the hook. Mixing references with a file argument exits 1. ([#29](https://github.com/rcrsr/mcp-policy-server/pull/29))

### Changed

- **Policy placement:** `policy-hook` now places the `<policies>` block before the task prompt and wraps the task in `<task>` tags, so the policy block forms a stable prefix that can be prompt-cached. ([#30](https://github.com/rcrsr/mcp-policy-server/pull/30))
- **Heading tag check:** `policy-cli check` now errors on any bracketed token directly after the closing brace of a section heading other than `[IMPORTANT]`. ([#29](https://github.com/rcrsr/mcp-policy-server/pull/29))
- **Prefix failure documentation:** Documentation explains when prefix-only references fail (unmatched or duplicate-covering, including embedded ones in fetched text), hook denial cases, the backtick escape hatch, and continuation token rules. ([#35](https://github.com/rcrsr/mcp-policy-server/pull/35))

### Fixed

- **Duplicate-covering prefixes:** A prefix-only reference (e.g. `§DOC`) that covers a section defined in more than one file now fails naming the files, instead of silently omitting the section. The hook now denies (`Policy resolution failed`) in this case. ([#34](https://github.com/rcrsr/mcp-policy-server/pull/34))
- **Unmatched prefixes:** An embedded prefix-only reference that matches no configured section now fails. The hook now denies (`Policy resolution failed`) for unmatched embedded prefixes. Rollout risk: policies whose prose mentions an unconfigured prefix will be denied until the prefix is configured or the reference is removed. ([#34](https://github.com/rcrsr/mcp-policy-server/pull/34))
- **Continuation tokens:** `fetch_policies` now rejects malformed continuation tokens, including `""` and tokens lacking `chunk:`, with `Invalid continuation token: ...`. ([#34](https://github.com/rcrsr/mcp-policy-server/pull/34))
- **Prefix before a period:** A prefix-only reference that ends a sentence, such as `See §LEGACY.`, is now extracted like `See §LEGACY for details.`, so an unconfigured prefix fails in both forms. A period blocks extraction only when a word character or `*` follows it, so placeholders and globs such as `§PREFIX.N`, `§API.*` and `§TS.md` are still skipped. ([#37](https://github.com/rcrsr/mcp-policy-server/pull/37))

## [0.7.0] - 2026-09-08

### Added

- **llms.txt:** Root-level [llms.txt](https://llmstxt.org/) giving LLM agents a condensed guide to § notation, the MCP tools, the CLI subcommands, and the hook. ([#12](https://github.com/rcrsr/mcp-policy-server/pull/12))
- **GitHub repository setup:** Added GitHub Actions CI workflows, automated releases, nightly SDK checks, issue taxonomy, and security scanning. ([#10](https://github.com/rcrsr/mcp-policy-server/pull/10))
- **Test coverage:** New suites for configuration loading, shared operations, the CLI runner, the hook pipeline, the MCP server over an in-memory transport, and built-binary smoke tests. Line coverage rose from 55% to 97% (branch coverage 89%). ([#9](https://github.com/rcrsr/mcp-policy-server/pull/9))
- **list-sections subcommand:** New `policy-cli` subcommand exposing per-section index as JSON. ([#8](https://github.com/rcrsr/mcp-policy-server/pull/8))

### Changed

- **Documentation accuracy:** Corrected the Node.js requirement (22.12+), the hook's allow/deny response shapes, subsection stopping rules (`{§END}` does not end a subsection), the CLI subcommand list (`list-sections`, `check`), full-form subsection ranges, config path resolution, and the scope of file watching (MCP server only). Fixed the broken CI validation loop in Best Practices and replaced stale JSON-array agent examples. ([#12](https://github.com/rcrsr/mcp-policy-server/pull/12))
- **Package scripts:** Renamed to the `check:*` / `fix:*` convention (`check:types`, `check:lint`, `check:format`, `check:deps`, `fix:lint`, `fix:format`) with a single `npm run check` gate. Added `test:watch`, `build:watch`, and `pretest` build so binary smoke tests always run against fresh output. `knip` now guards unused exports and dependencies. Lefthook runs format, lint, and typecheck on staged files at pre-commit and the full gate at pre-push. ([#9](https://github.com/rcrsr/mcp-policy-server/pull/9))
- **Code organization:** Extracted shared logic (reference expansion, extraction, validation, source listing) into `operations.ts`; split the CLI and hook binaries into thin entry points plus testable `cli-runner.ts` and `hook-runner.ts`; moved MCP tool definitions and dispatch into `server.ts`. `list_sources` output now also lists available prefixes, and the CLI's `list-sources` subcommand gains a matching `## Format` section. Removed dead code (`getBasePrefix`, unused error classes, duplicated extraction helpers in the indexer). ([#9](https://github.com/rcrsr/mcp-policy-server/pull/9))
- **Dependency and toolchain upgrade:** Bumped all dependencies to latest majors, replaced ESLint/Prettier with oxlint/oxfmt, and resolved all npm audit findings. ([#7](https://github.com/rcrsr/mcp-policy-server/pull/7))

## [0.6.4] - 2026-01-26

### Fixed

- Plugin namespace extraction from versioned paths (was using version instead of plugin name)

## [0.6.3] - 2026-01-26

### Changed

- Replaced Jest with Vitest for testing (4.0.18)
- Updated dependencies to current versions

### Removed

- `jest`, `@types/jest`, `ts-jest` dev dependencies

## [0.6.2] - 2026-01-26

### Added

- Multiple `--agents-dir` flags in `policy-hook` for searching multiple directories
- Auto-discovery of project and plugin directories when no explicit config provided:
  - Agent directories: `$CLAUDE_PROJECT_DIR/.claude/agents` then `$CLAUDE_PLUGIN_ROOT/agents`
  - Policy directories: `$CLAUDE_PROJECT_DIR/.claude/policies/*.md` then `$CLAUDE_PLUGIN_ROOT/policies/*.md`
  - Missing directories are skipped; project directories take precedence

## [0.6.0] - 2026-01-08

### Added

- `policy-cli check <file>` subcommand for validating policy file structure
  - Checks section header format, heading levels, code fence matching
  - Detects orphan subsections and numbering gaps
  - Error codes: `MALFORMED_SECTION`, `WRONG_HEADING_LEVEL`, `UNCLOSED_FENCE`, `ORPHAN_SUBSECTION`, `NUMBERING_GAP`, `MIXED_PREFIX`

## [0.5.3] - 2026-01-08

### Added

- `--debug <file>` flag for hook diagnostic output
- Prefix supersession: `§META` supersedes `§META.2`, `§META.3` before expansion
- Error blocking: hook returns `permissionDecision: "deny"` on resolution failure

### Fixed

- Plugin agent resolution via `$CLAUDE_PLUGIN_ROOT`
- Code fence preservation: `{§END}` inside fenced blocks no longer terminates extraction
- Inline reference handling: pattern now matches only actual headers
- Prompt formatting: blank lines around `<policies>` tags

## [0.5.2] - 2026-01-06

### Changed

- Documentation restructured with Plugin method as recommended approach
- Consistent four-method structure (Plugin, Hook, MCP Server, CLI) across all docs

## [0.5.1] - 2026-01-06

### Fixed

- Test import path in `cli.test.ts` (was importing from wrong module)

## [0.5.0] - 2026-01-06

### Added

- `policy-hook` binary for Claude Code PreToolUse integration
- `policy-cli` binary with subcommands: `fetch-policies`, `validate-references`, `extract-references`, `list-sources`, `resolve-references`

### Changed

- **BREAKING:** CLI restructured into separate binaries
  - `policy-fetch <file>` → `policy-cli fetch-policies <file>`
  - `policy-fetch --hook` → `policy-hook`
- `policy-fetch` remains as backwards-compatible alias for `policy-hook`

### Security

- Updated `qs` dependency from 6.14.0 to 6.14.1

## [0.4.3] - 2025-12-15

### Fixed

- Hook JSON schema validation: `decision` field renamed to `permissionDecision`

## [0.4.2] - 2025-12-15

### Fixed

- Subagent invocation syntax in docs: `@policy-agent` → `@agent-policy-agent`

## [0.4.1] - 2025-12-15

### Fixed

- `policy-fetch` CLI execution via npx (symlink recognition)

## [0.4.0] - 2025-12-15

### Added

- `policy-fetch` CLI tool with file mode and hook mode
- Claude Code hook integration via `--hook` flag
- Prefix-only references (`§TS`, `§PY`) expand to all matching sections

### Fixed

- Excluded `§END` from prefix-only matching

### Security

- Updated dependencies

## [0.3.2] - 2025-12-04

### Security

- Package updates for dependencies with known vulnerabilities

## [0.3.1] - 2025-12-04

### Added

- Prefix-only notation (`§PREFIX`) to fetch all sections from a document

## [0.3.0] - 2025-11-10

### Changed

- Moved to @rcrsr namespace and repo

## [0.2.4] - 2025-11-07

### Changed

- Improved tool instructions and descriptions for clarity
- Enhanced README with better command syntax examples

## [0.2.2] - 2025-11-01

### Changed

- Optimized MCP tool descriptions for token efficiency
- Enhanced Windows installation instructions

### Removed

- Unused `inspect_context` tool handler
- 136 lines of unused code

## [0.2.1] - 2025-10-31

### Fixed

- npx compatibility on Windows (added scoped package name to bin entries)

## [0.2.0] - 2025-10-30

### Added

- Section indexing with O(1) lookups
- Automatic file watching with lazy refresh
- Glob pattern support (`*`, `**`, `{a,b}`)
- Three configuration formats: direct glob, JSON file, inline JSON

### Changed

- **BREAKING:** Configuration format changed from `stems` object to `files` array
  - Old: `{"stems": {"APP": "policy-application"}}`
  - New: `{"files": ["./policies/*.md"]}`

## [0.1.1] - 2025-10-25

### Fixed

- Fenced code block detection with language identifiers
- Handling of unclosed fenced blocks
- Reference chain tracking in error messages

## [0.1.0] - 2025-10-24

### Added

- Initial release of MCP Policy Server

[0.8.3]: https://github.com/rcrsr/mcp-policy-server/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/rcrsr/mcp-policy-server/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/rcrsr/mcp-policy-server/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/rcrsr/mcp-policy-server/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/rcrsr/mcp-policy-server/compare/v0.6.4...v0.7.0
[0.6.4]: https://github.com/rcrsr/mcp-policy-server/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/rcrsr/mcp-policy-server/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/rcrsr/mcp-policy-server/compare/v0.6.0...v0.6.2
[0.6.0]: https://github.com/rcrsr/mcp-policy-server/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/rcrsr/mcp-policy-server/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/rcrsr/mcp-policy-server/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/rcrsr/mcp-policy-server/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/rcrsr/mcp-policy-server/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/rcrsr/mcp-policy-server/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/rcrsr/mcp-policy-server/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/rcrsr/mcp-policy-server/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/rcrsr/mcp-policy-server/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/rcrsr/mcp-policy-server/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/rcrsr/mcp-policy-server/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rcrsr/mcp-policy-server/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/rcrsr/mcp-policy-server/compare/v0.2.2...v0.2.4
[0.2.2]: https://github.com/rcrsr/mcp-policy-server/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/rcrsr/mcp-policy-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rcrsr/mcp-policy-server/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rcrsr/mcp-policy-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rcrsr/mcp-policy-server/releases/tag/v0.1.0
