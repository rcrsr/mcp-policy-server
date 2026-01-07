# Installation Guide

This guide covers installing the MCP Policy Server for all three integration methods.

## Prerequisites

- Node.js 18 or later
- Claude Code (for Hook and MCP methods) or other MCP-compatible client

## Choose Your Method

| Method | When to Use | What to Install |
|--------|-------------|-----------------|
| **[Hook](#hook-installation)** | Claude Code subagents (recommended) | Configure `.claude/settings.json` |
| **[MCP Server](#mcp-server-installation)** | Dynamic policy selection, other MCP clients | Configure `.mcp.json` or use `claude mcp add` |
| **[CLI](#cli-installation)** | Scripts, CI/CD, non-MCP tools | Just run with `npx` |

All methods use the same npm package: `@rcrsr/mcp-policy-server`

---

## Hook Installation

The hook method injects policies automatically into subagent prompts via Claude Code's PreToolUse hooks.

### Step 1: Create Your Policies Directory

```bash
mkdir -p ./policies
```

Add policy files with § notation (see [Getting Started](GETTING_STARTED.md#step-1-create-policy-files)).

### Step 2: Configure the Hook

Add to your project's `.claude/settings.json`:

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

### Step 3: Restart Claude Code

Restart Claude Code to load the new hook configuration.

### Verify Installation

Test the hook manually:

```bash
echo '{"tool_name":"Task","tool_input":{"prompt":"test","subagent_type":"my-agent"}}' | \
  npx -p @rcrsr/mcp-policy-server policy-hook --config "./policies/*.md"
```

You should see JSON output. If policies are found, they appear in `hookSpecificOutput.updatedInput.prompt`.

---

## MCP Server Installation

The MCP server provides tools that subagents call explicitly to fetch policies.

### Option A: Using Claude CLI (Recommended)

**Linux/macOS:**
```bash
claude mcp add-json policy-server '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@rcrsr/mcp-policy-server"],
  "env": {"MCP_POLICY_CONFIG": "./policies/*.md"}}' \
  --scope project
```

**Windows:**
```powershell
claude mcp add-json policy-server ('{' `
  '"type": "stdio", "command": "cmd",' + `
  '"args": ["/c", "npx", "-y", "@rcrsr/mcp-policy-server"], ' + `
  '"env": {"MCP_POLICY_CONFIG": "./policies/*.md"}}') `
  --scope project
```

### Option B: Manual .mcp.json Configuration

Create `.mcp.json` in your project root:

**Linux/macOS:**
```json
{
  "mcpServers": {
    "policy-server": {
      "command": "npx",
      "args": ["-y", "@rcrsr/mcp-policy-server"],
      "env": {
        "MCP_POLICY_CONFIG": "./policies/*.md"
      }
    }
  }
}
```

**Windows:**
```json
{
  "mcpServers": {
    "policy-server": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@rcrsr/mcp-policy-server"],
      "env": {
        "MCP_POLICY_CONFIG": "./policies/*.md"
      }
    }
  }
}
```

### Verify Installation

1. Restart Claude Code
2. Run `/mcp` to check server status
3. Look for "policy-server" with "connected" status

**Troubleshooting:**
- "failed" status: Check that `MCP_POLICY_CONFIG` path is correct
- Server not listed: Verify `.mcp.json` syntax (use a JSON validator)
- Connection errors: Check Node.js is installed (`node --version`)

### For Other MCP Clients

Consult your client's documentation for MCP server configuration. Use the same configuration format as shown above.

---

## CLI Installation

The CLI requires no installation—just run with `npx`.

### Basic Usage

```bash
# Extract policies referenced in a file
npx -p @rcrsr/mcp-policy-server policy-cli fetch-policies document.md --config "./policies/*.md"
```

### Global Installation (Optional)

For frequent use, install globally:

```bash
npm install -g @rcrsr/mcp-policy-server

# Then use without npx
policy-cli fetch-policies document.md --config "./policies/*.md"
policy-cli validate-references §DOC.1 §DOC.2 --config "./policies/*.md"
policy-cli list-sources --config "./policies/*.md"
```

---

## Development Installation

For development, local testing, or modifying the server code:

### Step 1: Clone and Build

```bash
git clone https://github.com/rcrsr/mcp-policy-server.git
cd mcp-policy-server
npm install
npm run build
```

### Step 2: Configure for Development

**For MCP Server:**

Create `.mcp.json` pointing to the local build:

```json
{
  "mcpServers": {
    "policy-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-policy-server/dist/index.js"],
      "env": {
        "MCP_POLICY_CONFIG": "./policies/*.md"
      }
    }
  }
}
```

**For Hook:**

Update `.claude/settings.json` to use local hook binary:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Task",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/mcp-policy-server/dist/hook.js --config \"./policies/*.md\""
      }]
    }]
  }
}
```

**Important:**
- Point to `dist/index.js` (MCP server), `dist/hook.js` (hook), or `dist/cli.js` (CLI)
- Run `npm run build` after making changes

---

## Configuration Notes

- `MCP_POLICY_CONFIG`: Glob pattern or path to policy files
- Glob patterns recommended: `./policies/*.md`, `./policies/**/*.md`
- Windows: Use forward slashes in JSON paths
- Restart Claude Code after configuration changes

See [Configuration Reference](CONFIGURATION_REFERENCE.md) for detailed options.

## Next Steps

1. **Create policy files** - See [Getting Started](GETTING_STARTED.md#step-1-create-policy-files)
2. **Create subagents** - See [Getting Started](GETTING_STARTED.md) for your chosen method
3. **Test the setup** - Verify policies are fetched correctly

For troubleshooting, see [Getting Started](GETTING_STARTED.md#troubleshooting).
