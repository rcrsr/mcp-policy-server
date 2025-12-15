# MCP Policy Server

**Give your Claude Code subagents instant, token-efficient access to your team's standards, guidelines, and best practices.**

Stop copying entire policy documents into prompts. Reference specific sections with compact § notation and let subagents fetch exactly what they need, when they need it.

## Why Use This?

### The Problem

Teams document standards in markdown files (coding guidelines, architecture principles, deployment procedures). When you want Claude Code subagents to follow these standards, you're stuck with imperfect options:

- **Put everything in memory like CLAUDE.md or rules files**: Signal loss, high token costs due to implicit context that may not be needed for all tasks
- **Reference entire documents**: Wastes tokens, hits context limits
- **Maintain each subagent separately**: Unnecessary duplication, hard to keep consistent

### The Solution

Reference sections with notation like `§PREFIX.1` or `§PREFIX.2.3-5`. Policies are fetched on demand. Your standards stay in markdown files. Subagents always get current content without token waste.

### Key Benefits

- **No wasted context**: Fetch only needed sections, not entire documents
- **Always current**: Update files, changes appear automatically
- **Automatic resolution**: Reference one section, get it plus any sections it references
- **Fast lookups**: O(1) retrieval via section indexing
- **Per-project policies**: Same installation, different policy sets per project

## Three Integration Methods

| Method | Best For | How It Works |
|--------|----------|--------------|
| **[Hook](#method-1-claude-code-hook-recommended)** | Claude Code subagents | Policies injected automatically via PreToolUse hook |
| **[MCP Server](#method-2-mcp-server)** | Other MCP clients, dynamic policy selection | Subagents call `fetch_policies` tool explicitly |
| **[CLI](#method-3-cli)** | Scripts, CI/CD, non-MCP tools | Command-line policy extraction |

Choose **Hook** for Claude Code projects. Choose **MCP Server** when subagents need to dynamically select policies based on prompt criteria, or when using other MCP-compatible clients. Choose **CLI** for automation scripts or non-MCP integrations.

## Quick Start: Create a Policy File

All methods require policy files with § notation. Create a policies directory and sample file:

**`./policies/policy-example.md`:**
```markdown
## {§DESIGN.1} YAGNI (You Aren't Gonna Need It)

Build what you need now. Add features when needed, not in anticipation.

**Guidelines:**
- No speculative generalization
- No placeholder code for "future features"
- No abstraction without 3+ concrete use cases
- Delete unused code immediately

## {§DESIGN.2} Keep It Simple

See also §DESIGN.1 for related principles.
```

---

## Method 1: Claude Code Hook (Recommended)

Policies are injected automatically into subagent prompts via PreToolUse hooks. No MCP connection required.

### Step 1: Configure the Hook

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

Make sure to restart Claude Code after updating settings.

### Step 2: Create a Subagent with Policy References

The actual format does not matter as long as the policy references are not code-fenced. For example:

**`.claude/agents/code-reviewer.md`:**
```markdown
---
name: code-reviewer
description: Reviews code for compliance with standards
---

Required policies: §DESIGN.1, §DESIGN.2

You are a code reviewer following our team standards.
Apply the policies above when reviewing code.
```

### Step 3: Run the Subagent

```
> @agent-code-reviewer review this PR
```

**What happens:**
1. Hook detects Task tool call with agent file
2. `policy-fetch` extracts all § references from agent file (§DESIGN.1, §DESIGN.2)
3. Policies are injected into the agent prompt wrapped in `<policies>` tags
4. Subagent receives policies automatically—no explicit tool call needed

**Note:** References inside code fences are ignored, allowing you to document examples without triggering extraction.

### Prefix-Only References

Use prefix-only notation to fetch all sections with a given prefix:

```markdown
Required: §DESIGN, §API
```

This expands `§DESIGN` to all `§DESIGN.*` sections and `§API` to all `§API.*` sections.

---

## Method 2: MCP Server

Subagents call `fetch_policies` tool explicitly. Use this when:
- Subagents need to dynamically select policies based on prompt content
- You're using MCP-compatible clients other than Claude Code
- You need validation tools (`validate_references`, `extract_references`)

### Step 1: Install the MCP Server

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

### Step 2: Create a Subagent with Explicit Tool Call

**`.claude/agents/code-reviewer.md`:**
```markdown
---
name: code-reviewer
description: Reviews code for compliance with standards
tools: mcp__policy-server__fetch_policies, Read, Glob
---

You are a code reviewer following our team standards.

**Before reviewing code:** call `mcp__policy-server__fetch_policies` with `{"sections": ["§DESIGN.1", "§DESIGN.2"]}`
```

### Step 3: Test and Run

1. Restart Claude Code
2. Accept prompts to enable the MCP server
3. Run `/mcp` to verify "policy-server" shows "connected"
4. Run `@agent-code-reviewer review this file`

See [Installation Guide](docs/INSTALLATION.md) for detailed setup.

---

## Method 3: CLI

Use `policy-fetch` directly for scripts, CI/CD, or non-MCP integrations.

### Extract Policies from a File

```bash
npx -p @rcrsr/mcp-policy-server policy-fetch document.md --config "./policies/*.md"
```

Extracts § references from `document.md`, fetches matching policies, outputs to stdout.

### Use in Scripts

```bash
# Inject policies into a prompt template
POLICIES=$(npx -p @rcrsr/mcp-policy-server policy-fetch agent.md --config "./policies/*.md")
echo "Follow these policies: $POLICIES" | your-llm-tool
```

---

## MCP Server Tools

These tools are available when using [Method 2: MCP Server](#method-2-mcp-server).

| Tool | Purpose |
|------|---------|
| `fetch_policies` | Retrieve sections with automatic reference resolution |
| `validate_references` | Check that § references exist before using them |
| `extract_references` | Scan a file for § references |
| `list_sources` | List configured policy files and available prefixes |
| `resolve_references` | Map sections to source files |

**Example usage:**
```json
{"sections": ["§PREFIX.1", "§PREFIX.2"]}
```

## Use Cases

- **Code Review**: Reference coding standards, style guides, architecture principles
- **Deployment**: Reference procedures, security checklists, rollback protocols
- **Documentation**: Reference standards, templates, review processes
- **Testing**: Reference coverage requirements, mocking patterns, integration setup

## Documentation

- [Getting Started](docs/GETTING_STARTED.md) - Step-by-step setup for all three methods
- [Installation Guide](docs/INSTALLATION.md) - Detailed installation options
- [Configuration Reference](docs/CONFIGURATION_REFERENCE.md) - Config options for hooks, MCP, and CLI
- [Policy Reference](docs/POLICY_REFERENCE.md) - § notation syntax
- [Best Practices](docs/BEST_PRACTICES.md) - Patterns and strategies

## License

[GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.en.html)
