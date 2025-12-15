# Getting Started with MCP Policy Server

This guide walks you through setting up the Policy Server from scratch. You'll create policy files, configure your preferred integration method, and write your first subagent that uses policy references.

## Choose Your Integration Method

| Method | Best For | Setup Complexity |
|--------|----------|------------------|
| **[Hook](#hook-setup-recommended-for-claude-code)** | Claude Code subagents | Simple - just configure `.claude/settings.json` |
| **[MCP Server](#mcp-server-setup)** | Dynamic policy selection, other MCP clients | Medium - requires MCP server configuration |
| **[CLI](#cli-setup)** | Scripts, CI/CD, non-MCP tools | Simple - command-line only |

**Recommendation:** Start with the Hook method for Claude Code projects. Switch to MCP Server only if you need dynamic policy selection based on prompt content.

---

## Step 1: Create Policy Files

All methods require policy files with § notation. Create your first policy file:

**`policies/policy-example.md`:**
```markdown
# Example Policy Document

## {§EXAMPLE.1} First Section

This is the content for the first section of your policy documentation.

## {§EXAMPLE.2} Second Section

Content for the second section goes here.

See §EXAMPLE.3 for additional information.

## {§EXAMPLE.3} Third Section

Additional policy details and guidelines.

Refer back to §EXAMPLE.1 for context.
```

**Key points:**
- Use format `## {§PREFIX.N}` for section markers (see [Policy Reference](POLICY_REFERENCE.md) for complete syntax)
- Sections can reference other sections (§EXAMPLE.3 referenced from §EXAMPLE.2)
- Prefixes are extracted automatically from section IDs

---

## Hook Setup (Recommended for Claude Code)

The hook method injects policies automatically into subagent prompts. No MCP connection required.

### Step 2: Configure the Hook

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

**Configuration options:**
- `-c, --config` - Glob pattern for policy files (defaults to `MCP_POLICY_CONFIG` env var or `./policies.json`)
- `--hook` - Enables hook mode (reads JSON from stdin, outputs to stdout)

### Step 3: Create a Subagent with Policy References

Add § references anywhere in your agent file. The hook extracts all references automatically.

**`.claude/agents/policy-agent.md`:**
```markdown
---
name: policy-agent
description: Example agent that uses policy sections
---

Follow §EXAMPLE.1 and §EXAMPLE.2 when completing tasks.

You are an agent that follows team policies.
Cite specific policy sections when explaining your decisions.
```

**Key points:**
- § references can appear anywhere in the file—no special format required
- References inside code fences are ignored (for documenting examples)
- The hook extracts all § references and injects the policy content

### Step 4: Run the Subagent

```
> @agent-policy-agent complete the task
```

**What happens:**
1. Claude Code invokes the Task tool with the agent file
2. PreToolUse hook triggers `policy-fetch --hook`
3. Hook extracts all § references from the agent file (§EXAMPLE.1, §EXAMPLE.2)
4. Policies are fetched and injected into the prompt wrapped in `<policies>` tags
5. Subagent receives policies automatically—no explicit tool call needed
6. §EXAMPLE.3 (referenced from §EXAMPLE.2) is included automatically

### Step 5: Use Prefix-Only References

Fetch all sections with a given prefix using prefix-only notation:

```markdown
Follow all §EXAMPLE and §OTHER policies.
```

This expands `§EXAMPLE` to all `§EXAMPLE.*` sections and `§OTHER` to all `§OTHER.*` sections. Useful for fetching entire policy categories.

### Verify Hook Setup

Test that the hook works:

```bash
# Simulate hook input
echo '{"tool_name":"Task","tool_input":{"prompt":"test","subagent_type":"policy-agent"}}' | \
  npx -p @rcrsr/mcp-policy-server policy-fetch --hook --config "./policies/*.md"
```

You should see JSON output with policies in `hookSpecificOutput.updatedInput.prompt`.

---

## MCP Server Setup

Use the MCP server when subagents need to dynamically select policies based on prompt content, or when using MCP-compatible clients other than Claude Code.

### Step 2: Install the MCP Server

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

Or create `.mcp.json` manually (see [Installation Guide](INSTALLATION.md) for details).

### Step 3: Verify Installation

1. Restart Claude Code
2. Run `/mcp` to check server status
3. Look for "policy-server" with "connected" status

Test by asking Claude Code:
```
Use the MCP list_sources tool to show me available policies
```

### Step 4: Create a Subagent with Explicit Tool Call

**Key principle:** Subagents must explicitly call `mcp__policy-server__fetch_policies`. Simply mentioning § references is not enough.

**`.claude/agents/policy-agent.md`:**
````markdown
---
name: policy-agent
description: Example agent that uses policy sections
tools: mcp__policy-server__fetch_policies, Read
---

You are an agent that follows team policies.

## Process

1. **Fetch policies** by calling `mcp__policy-server__fetch_policies` with:
   ```json
   {"sections": ["§EXAMPLE.1", "§EXAMPLE.2"]}
   ```

2. **Apply the policies** to your work

3. **Cite specific sections** when explaining decisions

Always fetch policies FIRST before proceeding with the task.
````

### Step 5: Run the Subagent

```
> @agent-policy-agent complete the task
```

**What happens:**
1. Subagent reads instructions and calls `fetch_policies` tool
2. Server returns §EXAMPLE.1, §EXAMPLE.2, plus §EXAMPLE.3 (auto-resolved reference)
3. Subagent applies policies and cites specific sections

### Dynamic Policy Selection

The MCP server enables dynamic policy selection based on prompt content:

````markdown
---
name: code-reviewer
tools: mcp__policy-server__fetch_policies, Read
---

You review code for compliance with team standards.

## Process

1. **Analyze the code** to determine which languages/frameworks are used

2. **Fetch relevant policies** based on your analysis:
   - Python code: `{"sections": ["§CODE-PY.1-5"]}`
   - JavaScript code: `{"sections": ["§CODE-JS.1-5"]}`
   - API changes: `{"sections": ["§API.1-3"]}`

3. **Review against fetched policies**
````

---

## CLI Setup

Use the CLI for scripts, CI/CD pipelines, or non-MCP integrations.

### Extract Policies from a File

```bash
npx -p @rcrsr/mcp-policy-server policy-fetch document.md --config "./policies/*.md"
```

Extracts § references from `document.md`, fetches matching policies, outputs to stdout.

### Use in Scripts

```bash
# Inject policies into a prompt
POLICIES=$(npx -p @rcrsr/mcp-policy-server policy-fetch agent.md --config "./policies/*.md")
echo "Follow these policies:\n$POLICIES\n\nNow complete the task..." | your-llm-tool
```

### CI/CD Integration

```yaml
# GitHub Actions example
- name: Validate policy references
  run: |
    npx -p @rcrsr/mcp-policy-server policy-fetch .claude/agents/*.md \
      --config "./policies/*.md" > /dev/null
```

---

## Automatic Policy Updates

Policy files are watched automatically for changes. Updates appear on the next request without restart.

**How it works:**
1. Files are monitored for changes
2. When a file changes, the section index is marked stale
3. On the next request, the index rebuilds automatically

**What triggers updates:**
- File content changes (save/modify)
- File deletion
- File rename

**Limitations:**
- New files matching existing glob patterns require restart
- Configuration changes require restart
- Files on network drives or WSL may have delayed updates

---

## Expand Your Policies

Add more policy files as your standards grow:

**`policies/policy-other.md`:**
```markdown
# Additional Policies

## {§OTHER.1} First Policy

Content for another policy section.

## {§OTHER.2} Second Policy

Additional guidelines and standards.

See §EXAMPLE.1 for related information.
```

The glob pattern `./policies/*.md` automatically includes new files (restart required to detect new files).

---

## Advanced Features

- **Range notation**: `§EXAMPLE.1-3` expands to sections 1, 2, and 3
- **Prefix-only notation**: `§EXAMPLE` expands to all `§EXAMPLE.*` sections
- **Subsections**: `§EXAMPLE.1.1` for nested content organization
- **Hyphenated prefixes**: `§PREFIX-EXT.1` for category extensions
- **Automatic reference resolution**: Fetching a section also fetches any sections it references

See [Policy Reference](POLICY_REFERENCE.md) for complete § notation syntax.

---

## Troubleshooting

### Hook Issues
- **Policies not injected**: Verify `.claude/settings.json` syntax and hook configuration
- **Wrong policies**: Check the JSON array in your agent file matches available sections
- **Hook not triggering**: Ensure matcher is "Task" (case-sensitive)

### MCP Server Issues
- **Server won't start**: Check `MCP_POLICY_CONFIG` points to valid file/pattern
- **No files found**: Verify glob pattern matches `.md` files
- **Connection failed**: Run `/mcp` to check status, restart Claude Code

### Section Issues
- **Section not found**: Check format is `## {§PREFIX.1}` with curly braces
- **Duplicates warning**: Same section ID in multiple files—remove from one

### General
- **Windows paths**: Use forward slashes in JSON: `./policies/*.md`
- **Stale content**: Edit policy file to trigger reload, or restart

---

## Next Steps

- [Configuration Reference](CONFIGURATION_REFERENCE.md) - Detailed configuration options
- [Policy Reference](POLICY_REFERENCE.md) - Complete § notation syntax
- [Best Practices](BEST_PRACTICES.md) - Patterns and strategies
- See `tests/fixtures/sample-policies/` for example policy files
