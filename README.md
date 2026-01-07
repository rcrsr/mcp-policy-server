# MCP Policy Server

**Give your Claude Code subagents instant, token-efficient access to your team's standards, guidelines, and best practices.**

Stop polluting your context by putting all your agent guidelines into CLAUDE.md or each subagent definition. Reference specific rules with compact § notation and let subagents fetch exactly what they need, when they need it.

## Why Use This?

### The Problem

Teams document standards in markdown files (coding guidelines, architecture principles, deployment procedures). When you want Claude Code subagents to follow these standards, you're stuck with imperfect options:

- **Put everything in memory like CLAUDE.md or rules files**: Signal loss, high token costs due to implicit context that may not be needed for all tasks
- **Reference entire documents**: Unreliable, wastes tokens, hits context limits
- **Maintain each subagent separately**: Unnecessary duplication, hard to keep consistent

### The Solution

Reference sections with notation like `§PREFIX.1` or `§PREFIX.2.3-5`. Policies are fetched on demand. Your standards stay in markdown files. Subagents always get current content without token waste.

### Key Benefits

- **No wasted context**: Fetch only needed sections, not entire documents
- **Always current**: Update files, changes appear automatically
- **Automatic resolution**: Reference one section, get it plus any sections it references
- **Fast lookups**: O(1) retrieval via section indexing
- **Per-project policies**: Same installation, different policy sets per project

## Setup Methods

| Method | Best For | How It Works |
|--------|----------|--------------|
| **[Plugin](#method-1-claude-code-plugin-recommended)** | Claude Code subagents | One command install, policies injected automatically |
| **[Hook](#method-2-claude-code-hook)** | Custom hook configuration | Manual hook setup for non-standard policy paths |
| **[MCP Server](#method-3-mcp-server)** | Other MCP clients, dynamic policy selection | Subagents call `fetch_policies` tool explicitly |
| **[CLI](#method-4-cli)** | Scripts, CI/CD, non-MCP tools | Command-line policy extraction |

Choose **Plugin** for Claude Code projects (simplest). Choose **Hook** if you need custom policy paths or hook behavior. Choose **MCP Server** when subagents need to dynamically select policies based on prompt criteria, or when using other MCP-compatible clients. Choose **CLI** for automation scripts or non-MCP integrations.

## Quick Start: Create a Policy File

All methods require policy files with § notation. Create a policies directory and sample file:

**`.claude/policies/policy-example.md`** (for Plugin method) or **`./policies/policy-example.md`** (for other methods):
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

## Method 1: Claude Code Plugin (Recommended)

Install the policies plugin and create policy files. The plugin configures hooks automatically.

### Step 1: Install the Plugin

Inside Claude Code, run this once:

```
/plugin marketplace add rcrsr/claude-plugins
```

Then install the policies plugin:

```
/plugin install policies@rcrsr
```

The policies files should be placed in `.claude/policies/` within your project directory.

### Step 2: Create Policy Files

Add policy files to `.claude/policies/`:

**`.claude/policies/design.md`:**
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

### Step 3: Reference Policies in Subagents

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

### Step 4: Run the Subagent

```
> @agent-code-reviewer review this PR
```

The plugin intercepts Task tool calls, extracts § references from the agent file, and injects matching policies automatically.

**Note:** References inside code fences are ignored, allowing you to document examples without triggering extraction.

---

## Method 2: Claude Code Hook

Manual hook configuration for custom policy paths or behavior. Use this when the Plugin method's default `.claude/policies/*.md` path doesn't fit your project structure.

### Step 1: Configure the Hook

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
2. `policy-hook` extracts all § references from agent file (§DESIGN.1, §DESIGN.2)
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

## Method 3: MCP Server

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

## Method 4: CLI

Use `policy-cli` for scripts, CI/CD, or non-MCP integrations.

### Available Subcommands

```bash
policy-cli fetch-policies <file>        # Fetch policies for § refs in a file
policy-cli validate-references <ref>... # Validate § refs exist
policy-cli extract-references <file>    # Extract § refs from a file
policy-cli list-sources                 # List available policy files
policy-cli resolve-references <ref>...  # Map § refs to source files
```

### Extract Policies from a File

```bash
npx -p @rcrsr/mcp-policy-server policy-cli fetch-policies document.md --config "./policies/*.md"
```

Extracts § references from `document.md`, fetches matching policies, outputs to stdout.

### Use in Scripts

```bash
# Inject policies into a prompt template
POLICIES=$(npx -p @rcrsr/mcp-policy-server policy-cli fetch-policies agent.md --config "./policies/*.md")
echo "Follow these policies: $POLICIES" | your-llm-tool

# Validate references before use
npx -p @rcrsr/mcp-policy-server policy-cli validate-references §DOC.1 §DOC.2 --config "./policies/*.md"
```

---

## MCP Server Tools

These tools are available when using [Method 3: MCP Server](#method-3-mcp-server).

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

- [Getting Started](docs/GETTING_STARTED.md) - Step-by-step setup for all four methods
- [Installation Guide](docs/INSTALLATION.md) - Detailed installation options
- [Configuration Reference](docs/CONFIGURATION_REFERENCE.md) - Config options for hooks, MCP, and CLI
- [Policy Reference](docs/POLICY_REFERENCE.md) - § notation syntax
- [Best Practices](docs/BEST_PRACTICES.md) - Patterns and strategies

## License

[GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.en.html)
