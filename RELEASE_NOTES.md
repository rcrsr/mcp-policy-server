# Release Notes

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
