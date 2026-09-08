# MCP Policy Server

MCP server and CLI for policy documentation via § notation. Provides automatic reference resolution, range expansion, and section validation.

## Commands

```bash
npm run build              # Compile TypeScript
npm test                   # Run Vitest tests
npm start                  # Start MCP server
npm run check              # types, lint, format, coverage, knip (full CI gate)
npm run fix:format && npm run fix:lint   # auto-fix format and lint
```

**Binaries:**
- `policy-hook` - Claude Code PreToolUse hook (reads stdin JSON, outputs hook response)
- `policy-cli` - CLI with subcommands: fetch-policies, validate-references, extract-references, list-sources, list-sections, resolve-references, check

## Architecture

```
src/
  index.ts       - MCP server stdio entry (load config, build index, connect)
  server.ts      - createServer(): tool/prompt definitions and request dispatch
  cli.ts         - policy-cli entry; maps runCli() result to stdout/stderr/exit code
  cli-runner.ts  - CLI arg parsing and subcommands, returns { exitCode, stdout, stderr }
  hook.ts        - policy-hook entry; argv, stdin, debug file, calls runHook()
  hook-runner.ts - Hook pipeline: agent lookup, config discovery, prompt injection
  operations.ts  - Shared logic for handlers/CLI/hook: expand, extract, validate, fetch
  handlers.ts    - MCP tool request handlers, chunking logic
  checker.ts     - Policy file format checker (structure, numbering, code fences)
  config.ts      - Configuration loading, path resolution
  indexer.ts     - Section indexing, file watching, per-section details
  parser.ts      - § notation parsing, range expansion, section extraction
  resolver.ts    - Recursive reference resolution
  validator.ts   - Duplicate detection
  types.ts       - Type definitions
```

Entry points (`index.ts`, `cli.ts`, `hook.ts`) hold process glue only. Put behaviour in the
runner/operations modules so it stays testable in-process. Logic shared by more than one entry
point belongs in `operations.ts`.

## Testing

- `npm test` runs Vitest; `npm run test:coverage` enforces 80% thresholds on `src/`.
- `tests/binaries.test.ts` spawns the built binaries and is skipped until `npm run build` has run.
- MCP transport tests use `InMemoryTransport` from the SDK (`tests/mcp-server.test.ts`).

## Key Behaviors

- Section extraction: whole sections (§DOC.4) stop at next same-prefix section, {§END}, or EOF
- Subsections (§DOC.4.1) stop at the next `##`/`###` heading starting with `{§`, or EOF; `{§END}` does not stop them
- Recursive resolution follows embedded § references until exhausted
- Parent-child deduplication: §DOC.4 supersedes §DOC.4.1
- Response chunking at section boundaries (10000 token limit, MCP `fetch_policies` only)
- File watching and lazy index rebuild apply to the MCP server only; hook and CLI rebuild the index per invocation
- `llms.txt` at the root mirrors the tool surface; update it when tools, subcommands, or notation change
