#!/usr/bin/env node
/**
 * Hook binary for Claude Code PreToolUse integration
 *
 * Reads JSON from stdin, extracts § references from agent files,
 * injects policies into the prompt, outputs hook response JSON.
 *
 * Usage:
 *   policy-hook [--config <path>] [--agents-dir <path>]
 *
 * Note: 'policy-fetch' is supported as an alias for backwards compatibility.
 * The --hook flag is accepted but ignored (hook mode is always implied).
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
  permissionDecision?: string;
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

  let configPath: string | undefined;
  let agentsDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Accept --hook for backwards compat but ignore it (hook mode is implied)
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
      // Ignore positional arguments for backwards compat
      continue;
    } else {
      console.error(`Error: Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  return { configPath, agentsDir };
}

/**
 * Print usage information to stderr
 */
function printUsage(): void {
  console.error(`
Usage: policy-hook [options]

Hook mode for Claude Code PreToolUse integration.
Reads JSON from stdin, injects policies into prompts, outputs hook response.

Options:
  -c, --config <path>     Path to policies.json or glob pattern
                          (defaults to MCP_POLICY_CONFIG env var or ./policies.json)
  -a, --agents-dir <path> Agent files directory
                          (defaults to $CLAUDE_PROJECT_DIR/.claude/agents)
  -h, --help              Show this help message

Example hook configuration:
  {
    "hooks": {
      "PreToolUse": [{
        "matcher": "Task",
        "hooks": [{
          "type": "command",
          "command": "npx -p @rcrsr/mcp-policy-server policy-hook --config \\"./policies/*.md\\""
        }]
      }]
    }
  }

Note: 'policy-fetch' is supported as an alias for backwards compatibility.
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
 * Output simple allow response for hooks
 */
function outputHookAllow(): void {
  process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs();

  // Determine agents directory
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const resolvedAgentsDir = args.agentsDir
    ? path.isAbsolute(args.agentsDir)
      ? args.agentsDir
      : path.resolve(projectDir, args.agentsDir)
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
    config = loadConfig(args.configPath);
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

// Only run main when executed directly, not when imported for testing
const isDirectRun =
  process.argv[1]?.endsWith('hook.js') ||
  process.argv[1]?.endsWith('hook.ts') ||
  process.argv[1]?.endsWith('policy-hook') ||
  process.argv[1]?.endsWith('policy-fetch');

if (isDirectRun) {
  main().catch((error) => {
    console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
