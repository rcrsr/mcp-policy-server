# Release Notes

## v0.6.1 (2026-01-25)

### Features

- **Multiple agent directories** - `policy-hook` now accepts multiple `--agents-dir` flags
  - Directories are searched in order until the agent file is found
  - Enables shared agent libraries across projects
  - Example: `policy-hook -a ./project-agents -a ./shared-agents`

---

## v0.6.0 (2026-01-08)

### Features

- **Policy file format checker** - New `policy-cli check <file>` subcommand validates policy file structure
  - Section header format (`{§PREFIX.NUMBER}`)
  - Heading level correctness (`##` for sections, `###` for subsections)
  - Code fence matching (all opened blocks closed)
  - Orphan subsections (subsections without parent section)
  - Contiguous section numbering (no gaps, starts at 1)
  - Mixed prefix detection (warning only)

### Error Codes

| Code | Severity | Description |
|------|----------|-------------|
| `MALFORMED_SECTION` | error | Invalid `{§...}` header format |
| `WRONG_HEADING_LEVEL` | error | Incorrect heading depth for section type |
| `UNCLOSED_FENCE` | error | Code block never closed |
| `ORPHAN_SUBSECTION` | error | Subsection without parent whole section |
| `NUMBERING_GAP` | error | Non-contiguous or not starting at 1 |
| `MIXED_PREFIX` | warning | Different base prefixes in same file |

### Usage

```bash
policy-cli check policy-app.md
```

Example output:
```
✗ policy-app.md
  ✗ Line 7: [NUMBERING_GAP] Gap in §APP numbering: missing 2-3 before 4
  ✗ Line 26: [NUMBERING_GAP] Gap in §APP numbering: missing 5-6 before 7

  2 error(s), 0 warning(s)
```

Exit codes: 0 (no errors), 1 (errors found)

---

## v0.5.3 (2026-01-08)

### Features

- **Hook debugging** - New `--debug <file>` flag writes diagnostic output to file
  - Shows environment variables, resolved paths, references found, and resolution steps
  - Outputs preview of injected prompt for verification

- **Prefix supersession** - Prefix-only references supersede specific references
  - `§META` now supersedes `§META.2`, `§META.3`, etc. before expansion
  - Reduces duplicate processing and ensures complete policy coverage

- **Error blocking** - Hook blocks with error message on resolution failure
  - Returns `permissionDecision: "deny"` with `permissionDecisionReason` containing error details
  - Surfaces policy configuration issues to the user instead of silent failure

### Bug Fixes

- **Plugin agent resolution** - Hook now resolves plugin-namespaced agents
  - `policies:policy-reviewer` resolves to `${CLAUDE_PLUGIN_ROOT}/agents/policy-reviewer.md`
  - Only resolves agents matching the plugin's own namespace (derived from directory name)
  - Non-matching namespaces pass through (Claude Code limitation: plugins cannot resolve paths of other installed plugins)

- **Code fence preservation** - Section extraction now ignores stop patterns inside code blocks
  - `{§END}` inside fenced code blocks no longer terminates extraction prematurely
  - Preserves complete markdown including template examples

- **Inline reference handling** - Fixed `SECTION_MARKER_PATTERN` to only match actual headers
  - Pattern changed from `/\{§/` to `/^##?#? \{§/`
  - Inline references like `` `{§PREFIX.X}` `` no longer terminate subsection extraction

- **Prompt formatting** - Added blank lines around `<policies>` tags for better readability

---

## v0.5.2 (2026-01-06)

### Documentation

- Added Plugin method to all documentation as the recommended installation approach
  - INSTALLATION.md: Added Plugin Installation section, updated method table
  - GETTING_STARTED.md: Added Plugin Setup section with step-by-step guide
  - CONFIGURATION_REFERENCE.md: Added Plugin Configuration section
- Updated Hook method description across all docs to clarify it's for custom policy paths
- Added Plugin troubleshooting sections to all relevant docs
- Consistent four-method structure (Plugin, Hook, MCP Server, CLI) across all documentation

---

## v0.5.1 (2026-01-06)

### Bug Fixes

- Fixed test import path in `cli.test.ts`
  - Test file imported `agentHasPolicyTool` from `src/cli` instead of `src/hook`
  - Caused TypeScript compilation error during test run

---

## v0.5.0 (2026-01-06)

### ⚠️ BREAKING CHANGES

CLI tool restructured into separate binaries:

- **Old:** `policy-fetch <file>` for file mode, `policy-fetch --hook` for hook mode
- **New:** `policy-cli <subcommand>` for CLI operations, `policy-hook` for hooks

**Migration:**
- File extraction: `policy-fetch doc.md` → `policy-cli fetch-policies doc.md`
- Hook mode: `policy-fetch --hook` → `policy-hook` (or keep using `policy-fetch`)

### Features

- New `policy-hook` binary dedicated to Claude Code PreToolUse integration
  - Cleaner separation of concerns from CLI tool
  - `policy-fetch` remains as backwards-compatible alias
- New `policy-cli` binary with subcommands:
  - `fetch-policies <file>` - Fetch policy content for § references in a file
  - `validate-references <ref>...` - Validate § references exist
  - `extract-references <file>` - Extract § references from a file
  - `list-sources` - List available policy files and prefixes
  - `resolve-references <ref>...` - Map § references to source files
- Documentation now recommends Plugin method as primary installation approach

### Documentation

- Updated README with Plugin method as recommended setup
- Updated all docs to use new binary names (`policy-hook`, `policy-cli`)
- Simplified CLAUDE.md

### Security

- Updated `qs` dependency from 6.14.0 to 6.14.1 (Dependabot)

### Dependencies

- `@modelcontextprotocol/sdk` 1.25.0 → 1.25.1
- `@types/node` 25.0.2 → 25.0.3
- `@typescript-eslint/eslint-plugin` 8.50.0 → 8.52.0
- `@typescript-eslint/parser` 8.50.0 → 8.52.0

---

## v0.4.3 (2025-12-15)

### Bug Fixes

- Fixed hook JSON schema validation error in `policy-fetch` CLI
  - Hook output used `decision` field instead of `permissionDecision`
  - Caused "JSON validation failed: Invalid input" errors in Claude Code PreToolUse hooks

---

## v0.4.2 (2025-12-15)

### Documentation

- Fixed subagent invocation syntax in docs: `@policy-agent` → `@agent-policy-agent`
  - Corrected examples in README.md and GETTING_STARTED.md to use proper `@agent-` prefix

---

## v0.4.1 (2025-12-15)

### Bug Fixes

- Fixed `policy-fetch` CLI not executing when invoked via `npx -p @rcrsr/mcp-policy-server policy-fetch`
  - The `isDirectRun` check now recognizes the `policy-fetch` symlink created by npm

---

## v0.4.0 (2025-12-15)

### Highlights

**New `policy-fetch` CLI** - The preferred way to inject policies into Claude Code subagents.

The CLI hook approach is more reliable than the MCP server for Claude Code integration:
- Policies injected directly into agent prompts via PreToolUse hooks
- No MCP connection required - works with any Claude Code project
- Cross-platform support (Windows, macOS, Linux)
- Automatic § reference extraction from agent files

### Features

- New `policy-fetch` CLI tool for extracting and fetching policies
  - File mode: extract § references from any file, output policies to stdout
  - Hook mode: integrate with Claude Code PreToolUse hooks
- Claude Code hook integration via `--hook` flag
  - Reads hook JSON from stdin, injects policies into Task tool prompts
  - Policies wrapped in `<policies>` tags for clear context
  - Falls back gracefully when no agent file or policies found
  - Skips injection when agent has `mcp__policy-server__fetch_policies` tool (avoids duplication)
- Prefix-only references in `findEmbeddedReferences`
  - `§TS`, `§PY`, `§BE` expand to all sections with that prefix
  - Works in both CLI extraction and recursive resolution

### Bug Fixes

- Excluded `§END` from prefix-only matching (special end-of-section marker)

### Security

- Updated dependencies

### Usage

Add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Task",
      "hooks": [{
        "type": "command",
        "command": "npx -p @rcrsr/mcp-policy-server policy-fetch --hook --config \"./policies/*.md\""
      }]
    }]
  }
}
```

Agent files in `.claude/agents/` can reference policies anywhere in the file:
```markdown
Required: §TS, §PY, §BASIC.1-8
```

The hook automatically extracts these references and injects the policies into agent prompts.

**Standalone usage:**
```bash
npx -p @rcrsr/mcp-policy-server policy-fetch document.md --config "./policies/*.md"
```

---

## v0.3.2 (2025-12-04)

### Security

- Package updates for dependencies with known vulnerabilities

---

## v0.3.1 (2025-12-04)

### Features

- Added prefix-only notation support (`§PREFIX`) to fetch all sections from a document
  - `§FE` expands to all `§FE.*` sections
  - `§APP-HOOK` expands to all `§APP-HOOK.*` sections
  - Works with `fetch`, `resolve_references`, and `validate_references` tools

### Testing

- Added 22 new tests for prefix-only notation

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

---

## v0.1.0 (2025-10-24)

Initial release of MCP Policy Server.
