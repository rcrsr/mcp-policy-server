#!/usr/bin/env node
/**
 * CLI tool to extract and fetch policy references from a file
 *
 * Modes:
 *   File mode:  mcp-policy-fetch <file> [--config <path>]
 *   Hook mode:  mcp-policy-fetch --hook [--config <path>] [--agents-dir <path>]
 *
 * Output:
 *   File mode: Writes fetched policy content to stdout
 *   Hook mode: Writes Claude Code hook JSON response to stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, ServerConfig } from './config.js';
import { expandSectionsWithIndex } from './handlers.js';
import { buildSectionIndex } from './indexer.js';
import { findEmbeddedReferences } from './parser.js';
import { fetchSectionsWithIndex } from './resolver.js';
import { SectionNotation, SectionIndex } from './types.js';

interface ParsedArgs {
  mode: 'file' | 'hook';
  inputFile?: string;
  configPath?: string;
  agentsDir?: string;
}

interface HookInput {
  tool_input?: {
    subagent_type?: string;
    prompt?: string;
  };
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: string;
    updatedInput?: {
      subagent_type?: string;
      prompt: string;
    };
  };
  decision?: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const isHookMode = args.includes('--hook');

  let inputFile: string | undefined;
  let configPath: string | undefined;
  let agentsDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--hook') {
      continue;
    } else if (arg === '--config' || arg === '-c') {
      configPath = args[++i];
      if (!configPath) {
        console.error('Error: --config requires a path argument');
        process.exit(1);
      }
    } else if (arg === '--agents-dir' || arg === '-a') {
      agentsDir = args[++i];
      if (!agentsDir) {
        console.error('Error: --agents-dir requires a path argument');
        process.exit(1);
      }
    } else if (!arg.startsWith('-')) {
      inputFile = arg;
    } else {
      console.error(`Error: Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (isHookMode) {
    return { mode: 'hook', configPath, agentsDir };
  }

  if (!inputFile) {
    console.error('Error: Input file required (or use --hook mode)');
    printUsage();
    process.exit(1);
  }

  return { mode: 'file', inputFile, configPath };
}

/**
 * Print usage information to stderr
 */
function printUsage(): void {
  console.error(`
Usage: policy-fetch <file> [options]
       policy-fetch --hook [options]

Extract § references from a file and fetch the referenced policy content.

Modes:
  <file>              File mode: scan file for § references
  --hook              Hook mode: read Claude Code hook JSON from stdin

Options:
  -c, --config <path>     Path to policies.json or glob pattern
                          (defaults to MCP_POLICY_CONFIG env var or ./policies.json)
  -a, --agents-dir <path> Agent files directory (hook mode only)
                          (defaults to $CLAUDE_PROJECT_DIR/.claude/agents)
  -h, --help              Show this help message

Examples:
  # File mode
  npx -p @rcrsr/mcp-policy-server policy-fetch document.md
  npx -p @rcrsr/mcp-policy-server policy-fetch document.md --config "./policies/*.md"

  # Hook mode (for Claude Code PreToolUse hooks)
  npx -p @rcrsr/mcp-policy-server policy-fetch --hook --config "./policies/*.md"

Hook Configuration (cross-platform):
  {
    "hooks": {
      "PreToolUse": [{
        "matcher": "Task",
        "hooks": [{
          "type": "command",
          "command": "npx -p @rcrsr/mcp-policy-server policy-fetch --hook --config \\"./policies/*.md\\""
        }]
      }]
    }
  }
`);
}

/**
 * Read all stdin as string
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * Check if agent file has MCP policy tool in frontmatter
 * Agents with this tool should fetch policies themselves
 *
 * Matches both direct and plugin-namespaced tools:
 * - mcp__policy-server__fetch_policies
 * - mcp__plugin_xyz_policy-server__fetch_policies
 */
export function agentHasPolicyTool(content: string): boolean {
  // Check for YAML frontmatter
  if (!content.startsWith('---')) {
    return false;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return false;
  }

  const frontmatter = content.slice(3, endIndex);

  // Look for tools line containing policy-server__fetch_policies
  // Handles both mcp__policy-server__ and mcp__plugin_*_policy-server__
  const toolsMatch = frontmatter.match(/^tools:\s*(.+)$/m);
  if (!toolsMatch) {
    return false;
  }

  return /mcp__(?:\w+_)*policy-server__fetch_policies/.test(toolsMatch[1]);
}

/**
 * Fetch policies from a file, returning empty string if none found
 */
function fetchPoliciesFromFile(
  filePath: string,
  config: ServerConfig,
  index: SectionIndex
): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const references = findEmbeddedReferences(content);

  if (references.length === 0) {
    return '';
  }

  try {
    const expandedRefs = expandSectionsWithIndex(references, index);
    const uniqueRefs = Array.from(new Set(expandedRefs)).sort() as SectionNotation[];
    return fetchSectionsWithIndex(uniqueRefs, index, config.baseDir);
  } catch {
    return '';
  }
}

/**
 * Run in hook mode: read JSON from stdin, modify prompt, output hook response
 */
async function runHookMode(configPath?: string, agentsDir?: string): Promise<void> {
  // Determine agents directory
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const resolvedAgentsDir = agentsDir
    ? path.isAbsolute(agentsDir)
      ? agentsDir
      : path.resolve(projectDir, agentsDir)
    : path.join(projectDir, '.claude', 'agents');

  // Read and parse stdin
  const stdinData = await readStdin();
  let input: HookInput;
  try {
    input = JSON.parse(stdinData);
  } catch {
    // Invalid JSON, just allow
    outputHookAllow();
    return;
  }

  // Extract subagent type and prompt
  const subagentType = input.tool_input?.subagent_type;
  const prompt = input.tool_input?.prompt;

  if (!subagentType || !prompt) {
    outputHookAllow();
    return;
  }

  // Find agent file
  const agentPath = path.join(resolvedAgentsDir, `${subagentType}.md`);
  if (!fs.existsSync(agentPath)) {
    outputHookAllow();
    return;
  }

  // Read agent file content
  const agentContent = fs.readFileSync(agentPath, 'utf8');

  // Skip injection if agent has MCP policy tool - it will fetch policies itself
  if (agentHasPolicyTool(agentContent)) {
    outputHookAllow();
    return;
  }

  // Suppress info logging
  const originalConsoleError = console.error;
  console.error = (): void => {};

  // Load config and build index
  let config: ServerConfig;
  let index: SectionIndex;
  try {
    config = loadConfig(configPath);
    index = buildSectionIndex(config);
  } catch {
    console.error = originalConsoleError;
    outputHookAllow();
    return;
  }

  console.error = originalConsoleError;

  // Fetch policies from agent file
  const policies = fetchPoliciesFromFile(agentPath, config, index);

  if (!policies) {
    outputHookAllow();
    return;
  }

  // Build modified prompt
  const newPrompt = `${prompt}

<policies>
${policies}
</policies>`;

  // Output hook response with modified prompt
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...input.tool_input,
        prompt: newPrompt,
      },
    },
  };

  process.stdout.write(JSON.stringify(output));
}

/**
 * Output simple allow response for hooks
 */
function outputHookAllow(): void {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}

/**
 * Run in file mode: read file, extract refs, output policies
 */
async function runFileMode(inputFile: string, configPath?: string): Promise<void> {
  // Resolve input file path
  const resolvedInputFile = path.isAbsolute(inputFile)
    ? inputFile
    : path.resolve(process.cwd(), inputFile);

  if (!fs.existsSync(resolvedInputFile)) {
    console.error(`Error: Input file not found: ${resolvedInputFile}`);
    process.exit(1);
  }

  // Suppress info logging
  const originalConsoleError = console.error;
  console.error = (): void => {};

  let config: ServerConfig;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.error = originalConsoleError;
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const index = buildSectionIndex(config);
  console.error = originalConsoleError;

  // Read and process file
  const content = fs.readFileSync(resolvedInputFile, 'utf8');
  const references = findEmbeddedReferences(content);

  if (references.length === 0) {
    process.exit(0);
  }

  // Expand and fetch
  const expandedRefs = expandSectionsWithIndex(references, index);
  const uniqueRefs = Array.from(new Set(expandedRefs)).sort() as SectionNotation[];

  try {
    const result = fetchSectionsWithIndex(uniqueRefs, index, config.baseDir);
    process.stdout.write(result);
  } catch (error) {
    console.error(
      `Error fetching policies: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs();

  if (args.mode === 'hook') {
    await runHookMode(args.configPath, args.agentsDir);
  } else {
    await runFileMode(args.inputFile!, args.configPath);
  }
}

// Only run main when executed directly, not when imported for testing
const isDirectRun = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts');

if (isDirectRun) {
  main().catch((error) => {
    console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
