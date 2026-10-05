# Configuration Reference

Complete reference for configuring the MCP Policy Server across all integration methods.

## Overview

The MCP Policy Server supports four integration methods, each with its own configuration:

| Method | Configuration Location | Key Options |
|--------|----------------------|-------------|
| **Plugin** | Claude Code plugin system | Policy files in `.claude/policies/` |
| **Hook** | `.claude/settings.json` | `--config` |
| **MCP Server** | `.mcp.json` or `claude mcp add` | `MCP_POLICY_CONFIG` env var |
| **CLI** | Command-line arguments | `--config`, `<subcommand>` |

---

## Plugin Configuration

The plugin method uses Claude Code's plugin system with automatic hook configuration.

### Installation

```
/plugin marketplace add rcrsr/claude-plugins
/plugin install policies@rcrsr
```

### Policy File Location

Place policy files in `.claude/policies/` within your project directory:

```
project/
├── .claude/
│   ├── policies/
│   │   ├── design.md
│   │   ├── coding.md
│   │   └── api.md
│   └── agents/
│       └── my-agent.md
```

### Default Behavior

- **Policy path**: `.claude/policies/*.md`
- **Hooks**: Configured automatically by the plugin
- **No manual configuration required**

### Customization

The plugin uses the same hook mechanism as the Hook method. To customize behavior, uninstall the plugin and configure hooks manually (see Hook Configuration below).

---

## Hook Configuration

Manual hook configuration for custom policy paths or behavior. Use this when the Plugin method's default `.claude/policies/*.md` path doesn't fit your project structure.

Configure hooks in your project's `.claude/settings.json`.

### Basic Configuration

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Task",
      "hooks": [{
        "type": "command",
        "command": "npx -p @rcrsr/mcp-policy-server policy-hook --config \"./policies/*.md\""
      }]
    }]
  }
}
```

### policy-hook Options

| Option | Required | Description |
|--------|----------|-------------|
| `-c, --config <value>` | No | Glob pattern, `policies.json` path, or inline JSON (see Default Discovery below) |
| `-a, --agents-dir <path>` | No | Agent files directory (can be specified multiple times; see Default Discovery below) |
| `-d, --debug <file>` | No | Append a trace of each run to `<file>` for troubleshooting |
| `--mode <digest\|full>` | No | `full` (default) injects all referenced policy text except `[PROFORMA]` sections (see the note below). `digest` injects a digest block, then the full text of `[IMPORTANT]` sections, then a footer |
| `--digest-depth <n>` | No | Deepest nested section level listed in the digest (default 2, minimum 2; `§D.4` is level 1, `§D.4.1` is level 2). Nested sections tagged important are listed even when deeper |
| `--digest-line-chars <n>` | No | Maximum characters per digest line, excluding the full-text marker (default 200) |
| `--digest-minimal` | No | Every digest line shows only `§ID Title`, with no body sentence |
| `--fetch-instructions <text>` | No | Replaces the whole default footer statement |
| `-h, --help` | No | Print usage and exit |

Digest flags are accepted and ignored in full mode. An invalid flag or value exits 1. `--digest-depth` and `--digest-line-chars` need a positive integer; `--digest-depth` has a minimum of 2.

#### Digest mode layout

1. Digest block: one line per section, `§ID Title: first sentence of the body`. `: sentence` is omitted when the body is empty; `§ID: sentence` when there is no title. `[IMPORTANT]` sections are listed too, marked `(full text below)`.
2. Full-text block: only the `[IMPORTANT]` sections (including important nested sections).
3. Footer: by default, a statement that the content above is a digest and how to fetch full text: `policy-cli fetch-policies --config '<absolute active config>' §ID ...`. The `--config '...'` part is omitted when no config value is in effect, and an inline JSON config is quoted as given, not made absolute. Use `--fetch-instructions` to replace it.

Full mode output is unchanged by these options. Both modes omit `[PROFORMA]` sections (and their nested subsections): they get no digest line and no full text. `policy-cli fetch-policies` still returns them. If the policy files cannot be re-read to look up section tags, the hook denies with `Policy resolution failed:` in both modes.

`policy-fetch` remains as an alias for `policy-hook`. The `--hook` flag and positional arguments are accepted and ignored for backwards compatibility.

### Default Discovery (Plugin-Friendly)

When no explicit `--config` or `--agents-dir` is provided, `policy-hook` auto-discovers directories. `MCP_POLICY_CONFIG`, when set, takes precedence over policy auto-discovery.

**Agents** (searched in order):
1. `$CLAUDE_PROJECT_DIR/.claude/agents` (project agents)
2. `$CLAUDE_PLUGIN_ROOT/agents` (plugin agents, if env var is set)

**Policies** (searched in order):
1. `$CLAUDE_PROJECT_DIR/.claude/policies/*.md` (project policies)
2. `$CLAUDE_PLUGIN_ROOT/policies/*.md` (plugin policies, if env var is set)

Directories that don't exist are skipped. Project directories take precedence over plugin directories. If neither policies directory exists, the hook falls back to `./policies.json` in the working directory.

**Plugin authors:** This auto-discovery means your plugin's hooks can simply call `policy-hook` without arguments. The hook will find your plugin's agents and policies automatically via `$CLAUDE_PLUGIN_ROOT`, while also picking up any project-level customizations. No user configuration required.

### Multiple Agent Directories

Specify multiple `--agents-dir` flags to override default discovery:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Task",
      "hooks": [{
        "type": "command",
        "command": "npx -p @rcrsr/mcp-policy-server policy-hook -a ./project-agents -a ./shared-agents --config \"./policies/*.md\""
      }]
    }]
  }
}
```

Directories are searched in order. The first matching agent file is used.

### How Hook Mode Works

1. Claude Code calls the hook with JSON on stdin containing `tool_name` and `tool_input`
2. Hook extracts the agent name from `tool_input.subagent_type` (e.g., `"code-reviewer"`)
3. Hook locates the agent file by searching `--agents-dir` directories for `<agent-name>.md`
4. Hook reads the agent file and extracts all § references (ignoring code-fenced and inline-code content)
5. Policies are fetched and injected into the prompt via `hookSpecificOutput.updatedInput.prompt`, placed before the original prompt inside `<policies>` tags, with the original prompt wrapped in `<task>` tags

**Hook responses:**

| Situation | Response |
|-----------|----------|
| Policies resolved | `hookSpecificOutput.updatedInput.prompt` with policies placed before the task; `permissionDecision: "allow"` |
| Agent file not found, no § references, agent declares `mcp__policy-server__fetch_policies` in `tools`, invalid stdin, or config error | `{"permissionDecision": "allow"}` (tool call proceeds unchanged) |
| A referenced section is missing or defined in more than one file, or a prefix-only reference (in the agent file or embedded in a fetched policy) matches no section or covers a duplicated one | `permissionDecision: "deny"` with `permissionDecisionReason` naming the failed reference |

The deny response is deliberate: a subagent that expects a policy should not run without it. Fix the reference or the policy file, then retry.

**Plugin-namespaced agents:** A `subagent_type` of the form `namespace:agent` resolves only inside `$CLAUDE_PLUGIN_ROOT/agents` when `namespace` matches the plugin's own directory name. Other namespaces are ignored.

**Why `--agents-dir` matters:** The hook receives only the agent name (e.g., `"code-reviewer"`), not the file path. It must locate the actual `.md` file to scan for § references. The `--agents-dir` option tells the hook where to find agent files. Without it, the hook uses auto-discovery (see Default Discovery above).

### Agent File Format

Add § references anywhere in your agent file. The hook extracts all references automatically:

```markdown
---
name: my-agent
description: Agent description
policy-mode: digest
---

Follow §DESIGN.1 and §DESIGN.2 when working.
All §API policies apply to this agent.

Your agent instructions here...
```

**Key points:**
- § references can appear anywhere—no special format required
- References inside code fences are ignored (for documenting examples)
- Prefix-only references like `§API` expand to all `§API.*` sections. They fail when no section matches the prefix or a covered section is duplicated

**`policy-mode` frontmatter (optional):**

| Value | Effect |
|-------|--------|
| `full` | Inject full text of every referenced non-proforma section |
| `digest` | Digest mode, never title-only (overrides `--digest-minimal`) |
| `digest-minimal` | Same as `--mode digest --digest-minimal` (title-only lines) |

- Precedence: agent frontmatter, then `--mode`/`--digest-minimal`, then `full`. An agent without the key behaves as before
- `--digest-depth`, `--digest-line-chars`, and `--fetch-instructions` still apply from the CLI
- An invalid value returns `permissionDecision: "deny"` with a reason naming the agent file and the bad value
- When the mode comes from frontmatter and `tools:` is declared without `Bash`, a digest mode falls back to `full`, because the footer's fetch command needs Bash
- `--debug` logs the resolved mode and its source (`frontmatter`, `flag`, or `default`), and the Bash fallback

---

## MCP Server Configuration

Configure via `MCP_POLICY_CONFIG` environment variable using one of three formats:

1. **Direct glob** (simplest): `./policies/*.md`
2. **JSON file**: Path to `policies.json`
3. **Inline JSON**: `{"files": ["./policies/*.md"]}`

**Default:** If `MCP_POLICY_CONFIG` is not set, the server loads `./policies.json` from the working directory.

The same three formats are accepted by `policy-hook --config` and `policy-cli --config`.

### Format Detection and Path Resolution

| Value | Detected as | Relative paths resolve against |
|-------|-------------|-------------------------------|
| Ends with `.json` | Path to a manifest file | The manifest file's directory |
| Starts with `{` and ends with `}` | Inline JSON manifest | The working directory |
| Anything else | A single glob pattern | The working directory |

Each pattern that matches zero files logs a warning to stderr. If the combined list is empty, startup fails. Every matched file must exist, be a regular file, be readable, and end in `.md` (case-sensitive). Dotfiles are not matched by `*`.

### JSON Structure

```json
{
  "files": [
    "./policies/policy-*.md",
    "./policies/**/*.md"
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `files` | Yes | Array of file paths or glob patterns (all must be `.md`) |

### Configuration Methods

#### 1. Direct Glob (Recommended)

Simplest approach—use glob pattern directly:

```json
{
  "env": {
    "MCP_POLICY_CONFIG": "./policies/*.md"
  }
}
```

Supports multiple directories:
```json
{
  "env": {
    "MCP_POLICY_CONFIG": "./{policies,docs}/*.md"
  }
}
```

#### 2. JSON File

For complex patterns or multiple directories:

**policies.json:**
```json
{
  "files": [
    "./policies/core/*.md",
    "./policies/guides/*.md"
  ]
}
```

**Config:**
```json
{
  "env": {
    "MCP_POLICY_CONFIG": "./policies/policies.json"
  }
}
```

#### 3. Inline JSON

For testing:

```json
{
  "env": {
    "MCP_POLICY_CONFIG": "{\"files\": [\"./policies/*.md\"]}"
  }
}
```

---

## CLI Configuration

The `policy-cli` binary provides subcommands for policy operations.

### Subcommands

| Subcommand | Description | Needs config | Exit code 1 when |
|------------|-------------|--------------|------------------|
| `fetch-policies <ref>...` or `fetch-policies <file>` | Fetch policy content for § references given as arguments (each starting with `§`; do not mix with a file) or found in a file | Yes | A reference fails to resolve |
| `validate-references <ref>...` | Validate that § references exist and are unique; prints JSON | Yes | Any reference is invalid |
| `extract-references <file>` | Extract § references from a file as a sorted JSON array | No | File not found |
| `list-sources` | List available policy files, index statistics, and prefixes | Yes | Config error |
| `list-sections` | List every section as JSON: `id`, `prefix`, `file`, `byteLength`, `refs`, `important`, `proforma` | Yes | Any section could not be read |
| `resolve-references <ref>...` | Map § references to source files as JSON | Yes | A reference fails to resolve |
| `check <file>` | Lint one policy file: header format, heading levels, code fences, orphan subsections, numbering gaps | No | Any error-level issue |

`check` issue codes: `MALFORMED_SECTION`, `WRONG_HEADING_LEVEL`, `UNCLOSED_FENCE`, `ORPHAN_SUBSECTION`, `NUMBERING_GAP`, `MALFORMED_TAG`, `TAG_CONFLICT` are errors; `MIXED_PREFIX` is a warning. Warnings do not affect the exit code.

### Common Options

| Option | Description |
|--------|-------------|
| `-c, --config <value>` | Glob pattern, `policies.json` path, or inline JSON (defaults to `MCP_POLICY_CONFIG` env var or `./policies.json`) |
| `-h, --help` | Show help for command or subcommand |

Running `policy-cli` with no subcommand prints usage and exits 1. Help text, configuration logs, and index-build logs go to stderr; stdout carries only the result, so output is safe to pipe.

### Usage Examples

```bash
# Fetch policies by reference
policy-cli fetch-policies §CODE.1 §API.2.3-5 --config "./policies/*.md"

# Fetch policies from a file
policy-cli fetch-policies document.md --config "./policies/*.md"

# Validate references exist
policy-cli validate-references §DOC.1 §DOC.2 --config "./policies/*.md"

# Extract references from a file
policy-cli extract-references agent.md

# List available sources
policy-cli list-sources --config "./policies/*.md"

# Dump every section with its outbound references
policy-cli list-sections --config "./policies/*.md"

# Lint a policy file
policy-cli check ./policies/policy-api.md
```

## Glob Patterns

Basic syntax:
- `*` - Any characters (single directory)
- `**` - Recursive (all subdirectories)
- `?` - Single character
- `{a,b}` - Alternatives

Examples:
```
./policies/*.md              → All .md files
./policies/**/*.md           → All .md files recursively
./{policies,docs}/*.md       → Both directories
./policies/policy-*.md       → Files starting with policy-
```

## File Watching

Applies to the MCP server only. The hook and CLI rebuild the index on every invocation, so they always see the current files.

The MCP server watches each configured file. A change marks the index stale after a 300 ms debounce, and the next tool call rebuilds it. Unchanged files (same mtime and size) are not re-parsed.

**Server restart required for:**
- New files matching glob patterns
- Configuration changes
- New glob patterns

## Troubleshooting

### Plugin not loading
- Run `/plugin` to check status
- Restart Claude Code after installation
- Verify marketplace was added: `/plugin marketplace add rcrsr/claude-plugins`

### Policies not injected (Plugin method)
- Check policy files exist in `.claude/policies/`
- Verify files have `.md` extension
- Ensure § notation is correct: `## {§PREFIX.1}`

### "Pattern matched zero files"
- Check directory exists
- Verify file names (case-sensitive)

### "Policy file not found"
- Use absolute paths
- Check the path resolution table under MCP Server Configuration above

### "Invalid JSON"
- Validate JSON syntax (no trailing commas)
- Ensure `files` is an array

### Changes not appearing
- Edit policy file to trigger reload
- Check server logs for `[WATCH]` events
- Restart server if needed

### Duplicate sections
- Same section ID in multiple files
- Duplicated IDs are excluded from the index, so fetching them fails until fixed
- Remove duplicates from one file
- Restart server

## Policy File Format

Mark sections with § notation:

```markdown
## {§DOC.1}
Content until next section or {§END}

### {§DOC.1.1}
Subsection content
```

Prefixes extracted from section IDs automatically. No manual mapping needed.

Sections can reference others:
```markdown
## {§CODE.1}
See §CODE.2 for details.
```

Server resolves references recursively.

## Best Practices

- Use Plugin method for standard Claude Code projects
- Use Hook method for custom policy paths
- Use direct glob for simple cases (Hook/MCP/CLI)
- Use JSON file for complex patterns
- Keep consistent file naming
- Ensure section IDs are unique
