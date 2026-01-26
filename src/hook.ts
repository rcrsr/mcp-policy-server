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
  agentsDirs: string[];
  debugFile?: string;
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
  const agentsDirs: string[] = [];
  let debugFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Accept --hook for backwards compat but ignore it (hook mode is implied)
    if (arg === '--hook') {
      continue;
    } else if (arg === '--debug' || arg === '-d') {
      debugFile = args[++i];
      if (!debugFile) {
        console.error('Error: --debug requires a file path argument');
        process.exit(1);
      }
    } else if (arg === '--config' || arg === '-c') {
      configPath = args[++i];
      if (!configPath) {
        console.error('Error: --config requires a path argument');
        process.exit(1);
      }
    } else if (arg === '--agents-dir' || arg === '-a') {
      const dir = args[++i];
      if (!dir) {
        console.error('Error: --agents-dir requires a path argument');
        process.exit(1);
      }
      agentsDirs.push(dir);
    } else if (!arg.startsWith('-')) {
      // Ignore positional arguments for backwards compat
      continue;
    } else {
      console.error(`Error: Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  return { configPath, agentsDirs, debugFile };
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
  -a, --agents-dir <path> Agent files directory (can be specified multiple times)
                          Directories are searched in order until agent file is found
                          (defaults to $CLAUDE_PROJECT_DIR/.claude/agents)
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

type FetchResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Fetch policies from a file, returning content or error
 */
function fetchPoliciesFromFile(
  filePath: string,
  config: ServerConfig,
  index: SectionIndex,
  debug: boolean
): FetchResult {
  if (!fs.existsSync(filePath)) {
    debugLog(debug, `fetchPoliciesFromFile: file not found: ${filePath}`);
    return { ok: true, content: '' };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const rawReferences = findEmbeddedReferences(content);
  debugLog(debug, `fetchPoliciesFromFile: found ${rawReferences.length} raw references`);

  if (rawReferences.length === 0) {
    return { ok: true, content: '' };
  }

  // Deduplicate and let prefix-only refs (§META) supersede specific refs (§META.2)
  const uniqueRaw = Array.from(new Set(rawReferences));
  const prefixOnlyRefs = uniqueRaw.filter((r) => /^§[A-Z][A-Z0-9-]*$/.test(r));
  const references = uniqueRaw.filter((ref) => {
    // Keep prefix-only refs
    if (prefixOnlyRefs.includes(ref)) return true;
    // Filter out specific refs if their prefix is already covered
    const refPrefix = ref.match(/^§([A-Z][A-Z0-9-]*)\./)?.[1];
    if (refPrefix && prefixOnlyRefs.includes(`§${refPrefix}`)) {
      debugLog(debug, `fetchPoliciesFromFile: ${ref} superseded by §${refPrefix}`);
      return false;
    }
    return true;
  });
  debugLog(debug, `fetchPoliciesFromFile: ${references.length} references after prefix dedup`);

  try {
    const expandedRefs = expandSectionsWithIndex(references, index);
    debugLog(debug, `fetchPoliciesFromFile: expanded to ${expandedRefs.length} refs`);
    const uniqueRefs = Array.from(new Set(expandedRefs)).sort() as SectionNotation[];
    debugLog(debug, `fetchPoliciesFromFile: fetching ${uniqueRefs.length} unique refs`);

    const result = fetchSectionsWithIndex(uniqueRefs, index, config.baseDir);
    debugLog(debug, `fetchPoliciesFromFile: fetched ${result.length} chars`);
    return { ok: true, content: result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    debugLog(debug, `fetchPoliciesFromFile: ERROR - ${error}`);
    return { ok: false, error };
  }
}

/**
 * Output simple allow response for hooks
 */
function outputHookAllow(): void {
  process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
}

/**
 * Output block response with error message for hooks
 */
function outputHookBlock(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

/**
 * Debug logger - outputs to stderr or file when debug mode is enabled
 */
let debugFileHandle: number | null = null;

function debugLog(debug: boolean, message: string): void {
  if (debug) {
    const line = `[policy-hook] ${message}\n`;
    if (debugFileHandle !== null) {
      fs.writeSync(debugFileHandle, line);
    } else {
      process.stderr.write(line);
    }
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const debug = !!args.debugFile;

  // Open debug file if specified
  if (args.debugFile) {
    try {
      debugFileHandle = fs.openSync(args.debugFile, 'a');
    } catch (e) {
      console.error(`Failed to open debug file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  debugLog(debug, '=== policy-hook debug output ===');
  debugLog(debug, `timestamp: ${new Date().toISOString()}`);
  debugLog(debug, `CLAUDE_PROJECT_DIR: ${process.env.CLAUDE_PROJECT_DIR ?? '(not set)'}`);
  debugLog(debug, `CLAUDE_PLUGIN_ROOT: ${process.env.CLAUDE_PLUGIN_ROOT ?? '(not set)'}`);
  debugLog(debug, `cwd: ${process.cwd()}`);
  debugLog(debug, `configPath arg: ${args.configPath ?? '(not set)'}`);
  debugLog(
    debug,
    `agentsDirs arg: ${args.agentsDirs.length > 0 ? args.agentsDirs.join(', ') : '(not set)'}`
  );

  // Determine agents directories - resolve paths and add default if none specified
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const resolvedAgentsDirs: string[] =
    args.agentsDirs.length > 0
      ? args.agentsDirs.map((dir) => (path.isAbsolute(dir) ? dir : path.resolve(projectDir, dir)))
      : [path.join(projectDir, '.claude', 'agents')];

  debugLog(debug, `resolved agentsDirs: ${resolvedAgentsDirs.join(', ')}`);

  // Read and parse stdin
  const stdinData = await readStdin();
  debugLog(debug, `stdin length: ${stdinData.length} chars`);

  let input: HookInput;
  try {
    input = JSON.parse(stdinData);
  } catch (e) {
    debugLog(debug, `EXIT: invalid JSON - ${e instanceof Error ? e.message : String(e)}`);
    outputHookAllow();
    return;
  }

  // Extract subagent type and prompt
  const subagentType = input.tool_input?.subagent_type;
  const prompt = input.tool_input?.prompt;

  debugLog(debug, `subagent_type: ${subagentType ?? '(not set)'}`);
  debugLog(debug, `prompt length: ${prompt?.length ?? 0} chars`);

  if (!subagentType || !prompt) {
    debugLog(debug, 'EXIT: missing subagent_type or prompt');
    outputHookAllow();
    return;
  }

  // Find agent file - handle plugin-namespaced agents (e.g., "policies:policy-reviewer")
  let agentPath: string | null = null;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  // Derive our plugin namespace from CLAUDE_PLUGIN_ROOT directory name
  const ourNamespace = pluginRoot ? path.basename(pluginRoot) : null;

  if (subagentType.includes(':')) {
    const [namespace, agentName] = subagentType.split(':');
    debugLog(debug, `plugin agent detected: namespace=${namespace}, name=${agentName}`);
    debugLog(debug, `our namespace: ${ourNamespace ?? '(unknown)'}`);

    // Only resolve agents from our own plugin namespace
    if (!pluginRoot || namespace !== ourNamespace) {
      debugLog(debug, `EXIT: cannot resolve agent from namespace "${namespace}" (not ours)`);
      outputHookAllow();
      return;
    }

    agentPath = path.join(pluginRoot, 'agents', `${agentName}.md`);
    debugLog(debug, `agent file: ${agentPath}`);
    debugLog(debug, `agent exists: ${fs.existsSync(agentPath)}`);
  } else {
    // Project agent: search through all agent directories in order
    const agentFileName = `${subagentType}.md`;
    for (const dir of resolvedAgentsDirs) {
      const candidatePath = path.join(dir, agentFileName);
      debugLog(debug, `checking agent path: ${candidatePath}`);
      if (fs.existsSync(candidatePath)) {
        agentPath = candidatePath;
        debugLog(debug, `agent found: ${agentPath}`);
        break;
      }
    }
    if (!agentPath) {
      debugLog(debug, `agent file not found in any of: ${resolvedAgentsDirs.join(', ')}`);
    }
  }

  if (!agentPath || !fs.existsSync(agentPath)) {
    debugLog(debug, 'EXIT: agent file not found');
    outputHookAllow();
    return;
  }

  // Read agent file content
  const agentContent = fs.readFileSync(agentPath, 'utf8');
  debugLog(debug, `agent content: ${agentContent.length} chars`);

  // Skip injection if agent has MCP policy tool - it will fetch policies itself
  if (agentHasPolicyTool(agentContent)) {
    debugLog(debug, 'EXIT: agent has MCP policy tool, skipping injection');
    outputHookAllow();
    return;
  }

  // Check for references in agent file before loading config
  const references = findEmbeddedReferences(agentContent);
  debugLog(debug, `references in agent: ${JSON.stringify(references)}`);

  if (references.length === 0) {
    debugLog(debug, 'EXIT: no § references in agent file');
    outputHookAllow();
    return;
  }

  // Suppress info logging unless in debug mode
  const originalConsoleError = console.error;
  if (!debug) {
    console.error = (): void => {};
  }

  // Load config and build index
  let config: ServerConfig;
  let index: SectionIndex;
  try {
    debugLog(debug, 'loading config...');
    config = loadConfig(args.configPath);
    debugLog(debug, `config loaded: ${config.files.length} files`);
    debugLog(
      debug,
      `policy files: ${config.files.slice(0, 5).join(', ')}${config.files.length > 5 ? '...' : ''}`
    );
    debugLog(debug, 'building section index...');
    index = buildSectionIndex(config);
    debugLog(debug, `index built: ${index.sectionCount} sections`);
  } catch (e) {
    console.error = originalConsoleError;
    debugLog(debug, `EXIT: config/index error - ${e instanceof Error ? e.message : String(e)}`);
    outputHookAllow();
    return;
  }

  console.error = originalConsoleError;

  // Fetch policies from agent file
  debugLog(debug, 'fetching policies...');
  const fetchResult = fetchPoliciesFromFile(agentPath, config, index, debug);

  if (!fetchResult.ok) {
    debugLog(debug, `BLOCK: ${fetchResult.error}`);
    outputHookBlock(`Policy resolution failed: ${fetchResult.error}`);
    return;
  }

  debugLog(debug, `policies fetched: ${fetchResult.content.length} chars`);

  if (!fetchResult.content) {
    debugLog(debug, 'EXIT: no policies resolved');
    outputHookAllow();
    return;
  }

  debugLog(debug, 'SUCCESS: injecting policies into prompt');

  // Build modified prompt with blank line before policies block
  const newPrompt = `${prompt}

<policies>

${fetchResult.content}

</policies>`;

  debugLog(debug, `injected prompt preview (first 600 chars):\n${newPrompt.slice(0, 600)}`);

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
  main()
    .catch((error) => {
      console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    })
    .finally(() => {
      if (debugFileHandle !== null) {
        fs.closeSync(debugFileHandle);
      }
    });
}
