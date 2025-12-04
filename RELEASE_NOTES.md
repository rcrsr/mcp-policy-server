# Release Notes

## v0.3.2 (2025-12-04)

### Security

- Updated @modelcontextprotocol/sdk from 1.20.2 to 1.24.3 (fixes DNS rebinding vulnerability)
- Updated transitive dependencies to fix 5 additional vulnerabilities:
  - body-parser 2.2.0 → 2.2.1 (DoS via url encoding)
  - glob 10.4.5 → 10.5.0, 11.0.3 → 11.1.0 (command injection in CLI)
  - js-yaml 3.14.1 → 3.14.2, 4.1.0 → 4.1.1 (prototype pollution)

---

## v0.3.1 (2025-12-04)

### Features

- Added prefix-only notation support (`§PREFIX`) to fetch all sections from a document
  - `§FE` expands to all `§FE.*` sections
  - `§APP-HOOK` expands to all `§APP-HOOK.*` sections
  - Works with `fetch`, `resolve_references`, and `validate_references` tools

### Testing

- Added 22 new tests for prefix-only notation
- Total test count: 262 tests

---

## v0.3.0 (2025-11-10)

### Documentation

- Moved to @rcrsr namespace and repo

## v0.2.4 (2025-11-07)

### Documentation

- Improved tool instructions and descriptions in server configuration for clarity
- Enhanced README documentation with better command syntax examples
- Fixed formatting and removed redundant statements

---

## v0.2.2 (2025-11-01)

### Improvements

- Removed unused `inspect_context` tool handler (simplified codebase)
- Optimized MCP tool descriptions for token efficiency
- Enhanced Windows installation instructions with platform-specific guidance
- Improved configuration examples in documentation

### Code Quality

- Reduced tool prompt complexity (69 lines to 33 lines in src/index.ts)
- Removed 136 lines of unused code across handlers and tests
- Streamlined tool registration logic

---

## v0.2.1 (2025-10-31)

### Bug Fixes

- Fixed npx compatibility on Windows by adding scoped package name to bin entries
- Package now registers both `@rcrsr/mcp-policy-server` and `mcp-policy-server` as executables
- Resolves "is not recognized as an internal or external command" error when using npx on Windows

---

## v0.2.0 (2025-10-30)

### ⚠️ BREAKING CHANGES

Configuration format changed from `stems` object to `files` array with glob pattern support. Manual migration required.

- **Old:** `{"stems": {"APP": "policy-application"}}`
- **New:** `{"files": ["./policies/*.md"]}` or `export MCP_POLICY_CONFIG="./policies/*.md"`

See docs/CONFIGURATION_REFERENCE.md for migration guide.

### Changes

- Section indexing with O(1) lookups (replaced O(n) file scanning)
- Automatic file watching with lazy refresh (policy changes appear on next tool call, no restart needed)
- Glob pattern support for flexible file matching (`*`, `**`, `{a,b}`)
- Three configuration formats: direct glob via env var, JSON file, inline JSON
- Added fast-glob dependency

---

## v0.1.1 (2025-10-25)

### Bug Fixes

- Fixed fenced code block detection with language identifiers (`` ```markdown ``, `` ```typescript ``)
- Fixed handling of unclosed fenced blocks in extracted sections
- Added reference chain tracking to error messages (shows which section referenced which)
- Updated regex pattern in `src/parser.ts` and `src/validator.ts`

### Documentation

- Clarified agent instructions with explicit tool call examples
- Updated installation instructions with platform-specific guidance
- Added documentation for code block handling in policy files
- Enhanced troubleshooting section in Getting Started guide

### Testing

- Added 189 new tests (62 parser, 127 validator)
- Added test fixtures for edge cases
- Total test count: 260 tests

---

## v0.1.0 (2025-10-24)

Initial release of MCP Policy Server.
