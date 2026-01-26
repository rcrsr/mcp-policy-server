# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
