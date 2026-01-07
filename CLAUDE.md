# MCP Policy Server

MCP server and CLI for policy documentation via § notation. Provides automatic reference resolution, range expansion, and section validation.

## Commands

```bash
npm run build              # Compile TypeScript
npm test                   # Run Jest tests
npm start                  # Start MCP server
npm run pre-commit:fix     # Format, lint, typecheck
```

**Binaries:**
- `policy-hook` - Claude Code PreToolUse hook (reads stdin JSON, outputs hook response)
- `policy-cli` - CLI with subcommands: fetch-policies, validate-references, extract-references, list-sources, resolve-references

## Architecture

```
src/
  index.ts    - MCP server entry, tool definitions
  hook.ts     - Hook binary for PreToolUse integration
  cli.ts      - CLI binary with subcommands
  config.ts   - Configuration loading, path resolution
  handlers.ts - Tool request handlers, chunking logic
  indexer.ts  - Section indexing, file watching
  parser.ts   - § notation parsing, range expansion
  resolver.ts - Recursive reference resolution
  validator.ts - Duplicate detection
  types.ts    - Type definitions
```

## Key Behaviors

- Section extraction: whole sections (§DOC.4) stop at next same-prefix section, {§END}, or EOF
- Subsections (§DOC.4.1) stop at any next § marker
- Recursive resolution follows embedded § references until exhausted
- Parent-child deduplication: §DOC.4 supersedes §DOC.4.1
- Response chunking at section boundaries (10000 token limit)
