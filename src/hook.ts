#!/usr/bin/env node
/**
 * Hook binary for Claude Code PreToolUse integration
 *
 * Reads JSON from stdin, extracts § references from agent files,
 * injects policies into the prompt, outputs hook response JSON.
 *
 * Usage:
 *   policy-hook [--config <path>] [--agents-dir <path>] [--debug <file>]
 *
 * Note: 'policy-fetch' is supported as an alias for backwards compatibility.
 * The --hook flag is accepted but ignored (hook mode is always implied).
 */

import * as fs from 'fs';
import { runHook } from './hook-runner.js';

interface ParsedArgs {
  configPath?: string;
  agentsDirs: string[];
  debugFile?: string;
}

const USAGE = `
Usage: policy-hook [options]

Hook mode for Claude Code PreToolUse integration.
Reads JSON from stdin, injects policies into prompts, outputs hook response.

Options:
  -c, --config <pattern>  Path to policies.json or glob pattern
                          (defaults to MCP_POLICY_CONFIG env var, or auto-discovers
                          $CLAUDE_PROJECT_DIR/.claude/policies/*.md and
                          $CLAUDE_PLUGIN_ROOT/policies/*.md)
  -a, --agents-dir <path> Agent files directory (can be specified multiple times)
                          Directories are searched in order until agent file is found
                          (defaults to $CLAUDE_PROJECT_DIR/.claude/agents and
                          $CLAUDE_PLUGIN_ROOT/agents if directories exist)
  -d, --debug <file>      Write debug output to file
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

Plugin authors: When bundling mcp-policy-server in a plugin, call policy-hook without
arguments. It auto-discovers agents and policies from both $CLAUDE_PLUGIN_ROOT and
$CLAUDE_PROJECT_DIR, enabling zero-config setup for end users.

Note: 'policy-fetch' is supported as an alias for backwards compatibility.
`;

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): ParsedArgs {
  if (args.includes('--help') || args.includes('-h')) {
    console.error(USAGE);
    process.exit(0);
  }

  let configPath: string | undefined;
  const agentsDirs: string[] = [];
  let debugFile: string | undefined;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (!value) {
      console.error(`Error: ${flag} requires a path argument`);
      process.exit(1);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--hook') {
      // Accepted for backwards compat; hook mode is implied
      continue;
    } else if (arg === '--debug' || arg === '-d') {
      debugFile = requireValue('--debug', args[++i]);
    } else if (arg === '--config' || arg === '-c') {
      configPath = requireValue('--config', args[++i]);
    } else if (arg === '--agents-dir' || arg === '-a') {
      agentsDirs.push(requireValue('--agents-dir', args[++i]));
    } else if (!arg.startsWith('-')) {
      // Ignore positional arguments for backwards compat
      continue;
    } else {
      console.error(`Error: Unknown option: ${arg}`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  return { configPath, agentsDirs, debugFile };
}

/**
 * Read all stdin as string
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let debugFileHandle: number | null = null;
  if (args.debugFile) {
    try {
      debugFileHandle = fs.openSync(args.debugFile, 'a');
    } catch (e) {
      console.error(`Failed to open debug file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const log = args.debugFile
    ? (message: string): void => {
        const line = `[policy-hook] ${message}\n`;
        if (debugFileHandle !== null) {
          fs.writeSync(debugFileHandle, line);
        } else {
          process.stderr.write(line);
        }
      }
    : undefined;

  const env = {
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
    policyConfigEnv: process.env.MCP_POLICY_CONFIG,
  };

  log?.('=== policy-hook debug output ===');
  log?.(`timestamp: ${new Date().toISOString()}`);
  log?.(`CLAUDE_PROJECT_DIR: ${process.env.CLAUDE_PROJECT_DIR ?? '(not set)'}`);
  log?.(`CLAUDE_PLUGIN_ROOT: ${env.pluginRoot ?? '(not set)'}`);
  log?.(`cwd: ${process.cwd()}`);
  log?.(`configPath arg: ${args.configPath ?? '(not set)'}`);
  log?.(`agentsDirs arg: ${args.agentsDirs.length > 0 ? args.agentsDirs.join(', ') : '(not set)'}`);

  try {
    const stdinData = await readStdin();
    log?.(`stdin length: ${stdinData.length} chars`);

    const output = runHook(stdinData, {
      configPath: args.configPath,
      agentsDirs: args.agentsDirs,
      env,
      log,
    });
    process.stdout.write(JSON.stringify(output));
  } finally {
    if (debugFileHandle !== null) {
      fs.closeSync(debugFileHandle);
    }
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
