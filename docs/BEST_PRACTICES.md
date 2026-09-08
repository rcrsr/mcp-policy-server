# Best Practices

Patterns and strategies for using the MCP Policy Server effectively.

## Choosing an Integration Method

### Plugin and Hook Methods (Recommended for Claude Code)

The Plugin method installs the hook for you with `.claude/policies/*.md` as the policy path. The Hook method is the same mechanism with a hand-written `.claude/settings.json` entry for custom paths. Everything below applies to both.

**Use when:**
- Building Claude Code subagents with known policy requirements
- Policies are determined by the agent type, not prompt content
- You want simpler agent files without explicit tool calls

**Agent file pattern:**
```markdown
---
name: code-reviewer
description: Reviews code for compliance
---

Follow §CODE.1-5 and all §API policies when reviewing.

You are a code reviewer. Apply the policies above.
```

§ references can appear anywhere in the file—no special format required. References inside code fences are ignored.

### MCP Server Method

**Use when:**
- Subagents need to dynamically select policies based on prompt content
- Using MCP-compatible clients other than Claude Code
- You need validation tools (`validate_references`, `extract_references`)
- Policies depend on file types, languages, or other runtime factors

**Agent file pattern:**
```markdown
---
name: code-reviewer
tools: mcp__policy-server__fetch_policies, Read
---

1. Analyze the code to determine languages/frameworks
2. Fetch relevant policies:
   - Python: `{"sections": ["§CODE-PY.1-5"]}`
   - JavaScript: `{"sections": ["§CODE-JS.1-5"]}`
3. Review against fetched policies
```

### CLI Method

**Use when:**
- Integrating with CI/CD pipelines
- Building custom tooling around policies
- Validating policy references in scripts
- Non-MCP integrations

**Example:**
```bash
# Lint every policy file
for policy in ./policies/*.md; do
  npx -p @rcrsr/mcp-policy-server policy-cli check "$policy" || exit 1
done

# Validate that every agent file references existing policies
for agent in .claude/agents/*.md; do
  refs=$(npx -p @rcrsr/mcp-policy-server policy-cli extract-references "$agent" | jq -r '.[]')
  [ -z "$refs" ] && continue
  npx -p @rcrsr/mcp-policy-server policy-cli validate-references $refs \
    --config "./policies/*.md" || echo "Failed: $agent"
done
```

`extract-references` prints a JSON array, so pipe it through `jq -r '.[]'` before passing the references as arguments. `validate-references` requires at least one reference, hence the empty check.

### Combining Methods

You can use multiple methods in the same project:
- Hook for standard subagents with fixed policy requirements
- MCP Server for advanced subagents with dynamic policy selection
- CLI for validation and automation

**Note:** The hook automatically skips injection when an agent has `mcp__policy-server__fetch_policies` in its tools list, preventing duplication.

---

## Policy Organization

### File Structure

**Domain-based organization:**
```
policies/
  policy-coding.md       # General coding standards
  policy-api.md          # API design patterns
  policy-security.md     # Security requirements
  policy-database.md     # Data layer patterns
```

**When to split vs. consolidate:**
- Split when file exceeds 500 lines or domains have distinct owners
- Consolidate when sections frequently reference each other
- Use subsections before creating new files

### Naming Conventions

**Prefixes:**
- Uppercase letters, digits allowed after the first character (CODE, API, SEC, CODE2)
- 2-6 characters for readability
- Hyphenated for specialization (CODE-JS, CODE-PY)

**Section numbering:**
- Sequential (§CODE.1, §CODE.2, §CODE.3)
- Use subsections for related content (§CODE.2.1, §CODE.2.2)
- Avoid renumbering existing sections to preserve references

**Files:**
- Consistent patterns: `policy-*.md`
- Descriptive names: `policy-api-rest.md` not `api.md`
- Lowercase, hyphens only

### Subsections

Use hierarchical organization:

```markdown
## {§API.3} Authentication

### {§API.3.1} Token Validation
...

### {§API.3.2} Session Management
...
```

**Benefits:**
- Fetch parent (§API.3) gets all content
- Fetch child (§API.3.1) gets granular content

**Avoid over-nesting:** Two levels (§PREFIX.N.N) keep references readable. Deeper levels are supported, but range notation only expands whole sections and first-level subsections, and `policy-cli check` does not verify numbering below the first subsection level.

## Version Control

### Commit Strategy

Separate policy and subagent changes:
```bash
# Good
git commit -m "Add §API.4 for rate limiting"
git commit -m "Update api-designer subagent to use §API.4"
```

### Breaking Changes

Deprecate first, remove later:

```markdown
## {§CODE.5} Logging Standards (DEPRECATED)
**Moved to §OBS.2**

See §OBS.2 for current requirements.
```

Because the stub references §OBS.2, any agent that still fetches §CODE.5 receives the current content automatically.

Don't renumber sections - breaks subagent references. Leaving a gap works at runtime but `policy-cli check` reports it as `NUMBERING_GAP`, so keep a deprecated stub in place rather than deleting the section.

## Performance

### Efficient Fetching

Use range notation:
```markdown
# Efficient - 1 call
fetch_policies(["§CODE.1-5"])

# Inefficient - 5 calls
fetch_policies(["§CODE.1"])
fetch_policies(["§CODE.2"])
...
```

### Automatic Resolution

Design policies to leverage recursive resolution:

```markdown
## {§CODE.2} Error Handling
See §CODE.5 for logging and §SEC.3 for security.
```

Fetching §CODE.2 automatically includes §CODE.5 and §SEC.3.

## Workflow Patterns

### Policy-First Development

1. Define standards as policies
2. Create subagents that reference policies
3. Implement according to fetched standards
4. Review against policies

### Subagent Instructions

**Hook method (simpler):**
```markdown
Follow §CODE.1-5 when reviewing code.
Cite specific sections in feedback.
```

**MCP method (explicit tool calls):**
```markdown
1. Fetch §CODE.1-5 using mcp__policy-server__fetch_policies
2. Review code against fetched standards
3. Cite specific sections in feedback
```

**Avoid vague references:**
```markdown
# Weak - subagent doesn't know what standards are
Review code according to standards.

# Strong - policies are explicit
Follow §CODE.1-5 when reviewing code.
Cite specific sections in feedback.
```

### Policy Bundles

Create bundles that reference related policies:

```markdown
## {§BACKEND.1} Backend Standards

Follow:
- §CODE.1-5 (coding standards)
- §API.1-3 (API design)
- §DATA.1-2 (database patterns)
- §SEC.1-4 (security)
```

Subagents fetch one bundle, get all dependencies automatically.

### Language-Specific Standards

Use hyphenated prefixes:

```markdown
# policy-coding.md
## {§CODE.1} General principles

# policy-coding-python.md
## {§CODE-PY.1} Python type hints

# policy-coding-javascript.md
## {§CODE-JS.1} JavaScript modules
```

Keep one base prefix per file. `policy-cli check` warns with `MIXED_PREFIX` when a file mixes unrelated prefixes; `CODE` and `CODE-PY` in one file are fine.

Configure: `"files": ["./policies/policy-coding*.md"]`

Subagents request: `§CODE.1-3, §CODE-PY.1-2`

## Production

### Configuration

**Use absolute paths:**
```json
{
  "files": ["/etc/company/policies/policy-*.md"]
}
```

**Multi-team setup:**
```json
{
  "files": [
    "/shared/policies/policy-*.md",
    "/team-a/team-a-*.md"
  ]
}
```

### Repository Structure

Centralized policy repository:
```
company-policies/  # Standalone repo
  policies.json
  policies/
    policy-coding.md
    policy-api.md
```

Project repositories with policies as sub-repo:
```
project-a/
  company-policies/  # Git submodule or subtree
    policies.json
    policies/
      policy-coding.md
      policy-api.md
  .mcp.json  # Points to ./company-policies/policies/*.md
  .claude/
    agents/
      code-reviewer.md  # References §CODE.*, §API.* from company policies
```

Team workflow:
1. Update policies via PR to company-policies repo
2. Review and merge
3. Pull submodule updates in project repos
4. All projects' subagents auto-use updates (the hook reads files on every run; a running MCP server picks up edits to existing files without restart)

### Monitoring

The MCP Policy Server logs to stderr with basic startup, file watching, and indexing events:
- `[STARTUP]` - Server initialization
- `[WATCH]` - File change detection
- `[INDEX]` - Section index rebuilds
- `[WARN]` - Duplicate section IDs found during indexing
- `[ERROR]` - Files that could not be read or parsed
- `[DEBUG]` - Chunking decisions for large `fetch_policies` responses

The hook is silent unless run with `--debug <file>`, which appends a full trace of each invocation.

For tool usage analytics (frequently fetched sections, failed lookups), you would need to:
1. Enable logging in your MCP client (Claude Code)
2. Parse client logs for `mcp__policy-server__fetch_policies` calls
3. Extract section parameters from tool invocations

**Note:** The server itself does not currently log individual tool calls or maintain usage metrics.

## Reference

- [Getting Started](GETTING_STARTED.md) - Initial setup
- [Configuration Reference](CONFIGURATION_REFERENCE.md) - Config options
- [Policy Reference](POLICY_REFERENCE.md) - § notation syntax
