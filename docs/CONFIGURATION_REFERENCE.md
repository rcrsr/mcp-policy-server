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
| `--config <pattern>` | No | Glob pattern for policy files (defaults to `MCP_POLICY_CONFIG` env var or `./policies.json`) |
| `--agents-dir <path>` | No | Agent files directory (can be specified multiple times; directories searched in order; defaults to `$CLAUDE_PROJECT_DIR/.claude/agents`) |
| `--debug <file>` | No | Write debug output to file for troubleshooting |

### Multiple Agent Directories

Specify multiple `--agents-dir` flags to search across directories:

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
2. Hook extracts the agent file path from `tool_input.subagent_type`
3. Hook reads the agent file and extracts all § references (ignoring code-fenced content)
4. Policies are fetched and injected into the prompt via `hookSpecificOutput.updatedInput.prompt`
5. If no policies found or agent already uses `mcp__policy-server__fetch_policies` tool, hook outputs `{"decision": "allow"}`

### Agent File Format

Add § references anywhere in your agent file. The hook extracts all references automatically:

```markdown
---
name: my-agent
description: Agent description
---

Follow §DESIGN.1 and §DESIGN.2 when working.
All §API policies apply to this agent.

Your agent instructions here...
```

**Key points:**
- § references can appear anywhere—no special format required
- References inside code fences are ignored (for documenting examples)
- Prefix-only references like `§API` expand to all `§API.*` sections

---

## MCP Server Configuration

Configure via `MCP_POLICY_CONFIG` environment variable using one of three formats:

1. **Direct glob** (simplest): `./policies/*.md`
2. **JSON file**: Path to `policies.json`
3. **Inline JSON**: `{"files": ["./policies/*.md"]}`

**Default:** If `MCP_POLICY_CONFIG` is not set, the server loads `./policies.json` from the working directory.

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

| Subcommand | Description |
|------------|-------------|
| `fetch-policies <file>` | Fetch policy content for § references in a file |
| `validate-references <ref>...` | Validate that § references exist and are unique |
| `extract-references <file>` | Extract § references from a file |
| `list-sources` | List available policy files and prefixes |
| `resolve-references <ref>...` | Map § references to source files |

### Common Options

| Option | Description |
|--------|-------------|
| `-c, --config <pattern>` | Glob pattern for policy files (defaults to `MCP_POLICY_CONFIG` env var or `./policies.json`) |
| `-h, --help` | Show help for command or subcommand |

### Usage Examples

```bash
# Fetch policies from a file
policy-cli fetch-policies document.md --config "./policies/*.md"

# Validate references exist
policy-cli validate-references §DOC.1 §DOC.2 --config "./policies/*.md"

# Extract references from a file
policy-cli extract-references agent.md

# List available sources
policy-cli list-sources --config "./policies/*.md"
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

Policy file changes reload automatically. No restart needed.

**Restart required for:**
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
- Check path resolution rules above

### "Invalid JSON"
- Validate JSON syntax (no trailing commas)
- Ensure `files` is an array

### Changes not appearing
- Edit policy file to trigger reload
- Check server logs for `[WATCH]` events
- Restart server if needed

### Duplicate sections
- Same section ID in multiple files
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
