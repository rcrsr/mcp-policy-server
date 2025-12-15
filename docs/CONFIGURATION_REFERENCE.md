# Configuration Reference

Complete reference for configuring the MCP Policy Server across all integration methods.

## Overview

The MCP Policy Server supports three integration methods, each with its own configuration:

| Method | Configuration Location | Key Options |
|--------|----------------------|-------------|
| **Hook** | `.claude/settings.json` | `--config`, `--hook` |
| **MCP Server** | `.mcp.json` or `claude mcp add` | `MCP_POLICY_CONFIG` env var |
| **CLI** | Command-line arguments | `--config`, `<file>` |

---

## Hook Configuration

Configure hooks in your project's `.claude/settings.json`.

### Basic Configuration

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

### CLI Options for Hook Mode

| Option | Required | Description |
|--------|----------|-------------|
| `--hook` | Yes | Enable hook mode (reads JSON from stdin, outputs JSON to stdout) |
| `--config <pattern>` | No | Glob pattern for policy files (defaults to `MCP_POLICY_CONFIG` env var or `./policies.json`) |

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

The CLI uses command-line arguments for configuration.

### CLI Options

| Option | Description |
|--------|-------------|
| `<file>` | File to extract § references from (positional argument) |
| `-c, --config <pattern>` | Glob pattern for policy files (defaults to `MCP_POLICY_CONFIG` env var or `./policies.json`) |
| `--hook` | Enable hook mode for Claude Code integration |
| `-a, --agents-dir <path>` | Agent files directory (hook mode only, defaults to `$CLAUDE_PROJECT_DIR/.claude/agents`) |

### Usage Examples

```bash
# Extract policies from a file
policy-fetch document.md --config "./policies/*.md"

# Use in hook mode
echo '{"tool_name":"Task",...}' | policy-fetch --hook --config "./policies/*.md"
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

- Use direct glob for simple cases
- Use JSON file for complex patterns
- Keep consistent file naming
- Ensure section IDs are unique
