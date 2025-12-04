# MCP Policy Server

**Give your Claude Code subagents instant, token-efficient access to your team's standards, guidelines, and best practices.**

Stop copying entire policy documents into prompts. Reference specific sections with compact § notation and let subagents fetch exactly what they need, when they need it.

**Designed for Claude Code subagents and commands (slash commands).** May work with other MCP-compatible clients that support agent-based workflows.

## Why Use This?

### The Problem

Teams document standards in markdown files (coding guidelines, architecture principles, deployment procedures). When you want Claude Code subagents to follow these standards, you're stuck with imperfect options:

- **Put everything in memory like CLAUDE.md**: Signal loss, high token costs due to implicit context that may not be needed for all tasks
- **Reference entire documents**: Wastes tokens, hits context limits
- **Maintain each subagent separately**: Unnecessary duplication, hard to keep consistent

### The Solution

Reference sections with notation like `§PREFIX.1` or `§PREFIX.2.3-5`. Subagents fetch referenced sections on demand. Your standards stay in markdown files. Subagents always get current content without token waste.

### Key Benefits

- **No wasted context**: Fetch only needed sections, not entire documents
- **Always current**: Update files, changes appear automatically (no restart needed for file edits; new files matching existing patterns require restart)
- **Automatic resolution**: Reference one section, server fetches it plus any sections it references
- **Fast lookups**: O(1) retrieval via section indexing
- **Per-project policies**: Same installation, different policy sets per project

## Quick Example

**Subagent file (`.claude/agents/code-reviewer.md`):**
```markdown
---
name: code-reviewer
description: Reviews code changes for compliance with policy standards
tools: mcp__policy-server__fetch_policies, Read, Glob
---

You are a code reviewer following our team standards.

**Before reviewing code:** call `mcp__policy-server__fetch_policies` with `{"sections": ["§EXAMPLE.1", "§EXAMPLE.2"]}`

This retrieves the specified policy sections from your configured files.
```

**Policy file (`policies/policy-example.md`):**
```markdown
## {§EXAMPLE.1} Sample Policy Section

Policy content goes here with your team's standards and guidelines.

See also §EXAMPLE.2 for related information.
```

**What happens:**
Subagent calls `mcp__policy-server__fetch_policies` with those sections. Server returns requested sections plus embedded references (`§EXAMPLE.2`). See [Getting Started](docs/GETTING_STARTED.md#step-6-use-the-agent) for detailed workflow.

## Installation

### Quick Start (Claude Code)

Create a policies directory in your project root (`./policies`), and add a sample policy file (`./policies/example-policy.md`):

```markdown
## {§DESIGN.1} YAGNI (You Aren't Gonna Need It)

Build what you need now. Add features when needed, not in anticipation.

**Guidelines:**
- No speculative generalization
- No placeholder code for "future features"
- No abstraction without 3+ concrete use cases
- Delete unused code immediately
```

### Install the MCP Policy Server

The following commands add the MCP Policy Server to your project in Claude Code and configure it to load policies from the `./policies` directory.

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

See [Installation Guide](docs/INSTALLATION.md) for detailed setup and development installation.

### Test the Setup

1. Restart Claude Code
2. Accept any prompts to enable the new MCP server
3. Prompt `fetch §DESIGN.1` to verify it retrieves the policy section (after allowing necessary tools permissions)

### Try it in a Subagent

Create a simple agent that uses the policy server to fetch and reference policies (for example, `./.claude/agents/policy-tester.md`):

```markdown
---
name: policy-tester
description: Display design policy
tools: mcp__policy-server__fetch_policies
---

CRITICAL: use mcp__policy-server__fetch_policies to ONLY retrieve `§DESIGN.1` before proceeding.

Summarize the key points of §DESIGN.1 in your response.
```

The first statement instructs the agent to fetch the policy section before using it. The content of `§DESIGN.1` will be retrieved from your policy file and added to the subagent's context.

The second statement directly references the section (which is now in the context) and asks the agent to summarize the fetched policy section.

Restart Claude Code, then run the `policy-tester` subagent, and it should fetch and summarize the YAGNI policy section:

```
> run @agent-policy-tester
```

## Available MCP Tools

### `mcp__policy-server__fetch_policies` - Retrieve Policy Sections
Fetch sections with automatic reference resolution:
```json
{"sections": ["§PREFIX.1", "§PREFIX.2"]}
```

### `mcp__policy-server__extract_references` - Find § References
Scan files for policy references:
```json
{"file_path": "/path/to/agent.md"}
```

### `mcp__policy-server__validate_references` - Check References Exist
Verify sections exist:
```json
{"references": ["§PREFIX.1", "§PREFIX.2"]}
```

### `mcp__policy-server__list_sources` - See Available Policies
List all configured policy files and prefixes.

### Other Tools
- `mcp__policy-server__resolve_references` - Map sections to source files

## Use Cases

- **Code Review**: Reference coding standards, style guides, architecture principles
- **Deployment**: Reference procedures, security checklists, rollback protocols
- **Documentation**: Reference standards, templates, review processes
- **Testing**: Reference coverage requirements, mocking patterns, integration setup

## Documentation

- [Installation Guide](docs/INSTALLATION.md) - Setup instructions
- [Getting Started](docs/GETTING_STARTED.md) - Creating policies and agents
- [Configuration Reference](docs/CONFIGURATION_REFERENCE.md) - Config options
- [Policy Reference](docs/POLICY_REFERENCE.md) - § notation syntax
- [Best Practices](docs/BEST_PRACTICES.md) - Patterns and strategies

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.en.html)
