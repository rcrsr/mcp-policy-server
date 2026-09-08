/**
 * PreToolUse hook logic
 *
 * Pure functions behind the policy-hook binary. Everything that touches
 * process state (argv, stdin, stdout, exit) stays in hook.ts; this module
 * takes explicit inputs and returns the hook response as data.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config.js';
import { buildSectionIndex } from './indexer.js';
import { findEmbeddedReferences } from './parser.js';
import { dedupeSupersededReferences, fetchPoliciesForReferences } from './operations.js';
import { SectionIndex } from './types.js';

/**
 * Shape of the PreToolUse payload the hook reads from stdin
 */
interface HookInput {
  tool_input?: {
    subagent_type?: string;
    prompt?: string;
    [key: string]: unknown;
  };
}

/**
 * Hook response payloads
 */
export type HookOutput =
  | { permissionDecision: 'allow' }
  | {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'allow';
        updatedInput: { prompt: string; [key: string]: unknown };
      };
    }
  | {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'deny';
        permissionDecisionReason: string;
      };
    };

/**
 * Environment the hook runs in, passed explicitly for testability
 */
export interface HookEnvironment {
  /** Project directory ($CLAUDE_PROJECT_DIR, falling back to cwd) */
  projectDir: string;
  /** Plugin root ($CLAUDE_PLUGIN_ROOT) when running inside a plugin */
  pluginRoot?: string;
  /** Value of $MCP_POLICY_CONFIG, if set */
  policyConfigEnv?: string;
}

/**
 * Options controlling a hook run
 */
export interface HookRunOptions {
  /** Explicit --config value */
  configPath?: string;
  /** Explicit --agents-dir values, in search order */
  agentsDirs?: string[];
  /** Environment description */
  env: HookEnvironment;
  /** Debug logger. When absent, config loading noise on stderr is suppressed. */
  log?: (message: string) => void;
}

/** Response that lets the tool call through unchanged */
export const ALLOW_RESPONSE: HookOutput = { permissionDecision: 'allow' };

/**
 * Build a deny response
 *
 * @param reason - Explanation surfaced to the caller
 * @returns Deny payload
 */
export function denyResponse(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Check if agent file has MCP policy tool in frontmatter
 * Agents with this tool should fetch policies themselves
 *
 * Matches both direct and plugin-namespaced tools:
 * - mcp__policy-server__fetch_policies
 * - mcp__plugin_xyz_policy-server__fetch_policies
 *
 * @param content - Agent file content
 * @returns True when the agent declares the fetch_policies tool
 */
export function agentHasPolicyTool(content: string): boolean {
  if (!content.startsWith('---')) {
    return false;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return false;
  }

  const frontmatter = content.slice(3, endIndex);
  const toolsMatch = frontmatter.match(/^tools:\s*(.+)$/m);
  if (!toolsMatch) {
    return false;
  }

  return /mcp__(?:\w+_)*policy-server__fetch_policies/.test(toolsMatch[1]);
}

/**
 * Resolve the agent directories to search
 *
 * Explicit directories are resolved against the project directory.
 * Without explicit directories, the project's .claude/agents and the
 * plugin's agents directory are used when they exist, project first.
 *
 * @param explicitDirs - Directories from --agents-dir flags
 * @param env - Hook environment
 * @returns Absolute directories in search order
 */
export function resolveAgentsDirs(explicitDirs: string[], env: HookEnvironment): string[] {
  if (explicitDirs.length > 0) {
    return explicitDirs.map((dir) =>
      path.isAbsolute(dir) ? dir : path.resolve(env.projectDir, dir)
    );
  }

  const candidates = [path.join(env.projectDir, '.claude', 'agents')];
  if (env.pluginRoot) {
    candidates.push(path.join(env.pluginRoot, 'agents'));
  }
  return candidates.filter((dir) => fs.existsSync(dir));
}

/**
 * Derive this plugin's namespace from its root path
 *
 * Plugin roots follow .../{namespace}/{version}, so the namespace is the
 * parent directory name.
 *
 * @param pluginRoot - $CLAUDE_PLUGIN_ROOT
 * @returns Namespace, or null when not running as a plugin
 */
export function pluginNamespace(pluginRoot: string | undefined): string | null {
  return pluginRoot ? path.basename(path.dirname(pluginRoot)) : null;
}

/**
 * Locate the agent file for a subagent type
 *
 * Namespaced types ("plugin:agent") resolve only inside this plugin's own
 * agents directory. Plain types are searched across agentsDirs in order.
 *
 * @param subagentType - Value of tool_input.subagent_type
 * @param agentsDirs - Directories to search for plain agent names
 * @param env - Hook environment
 * @param log - Debug logger
 * @returns Absolute path to an existing agent file, or null
 */
export function findAgentFile(
  subagentType: string,
  agentsDirs: string[],
  env: HookEnvironment,
  log: (message: string) => void
): string | null {
  if (subagentType.includes(':')) {
    const [namespace, agentName] = subagentType.split(':');
    const ourNamespace = pluginNamespace(env.pluginRoot);
    log(`plugin agent detected: namespace=${namespace}, name=${agentName}`);
    log(`our namespace: ${ourNamespace ?? '(unknown)'}`);

    if (!env.pluginRoot || namespace !== ourNamespace) {
      log(`cannot resolve agent from namespace "${namespace}" (not ours)`);
      return null;
    }

    const agentPath = path.join(env.pluginRoot, 'agents', `${agentName}.md`);
    log(`agent file: ${agentPath}`);
    return fs.existsSync(agentPath) ? agentPath : null;
  }

  const agentFileName = `${subagentType}.md`;
  for (const dir of agentsDirs) {
    const candidate = path.join(dir, agentFileName);
    log(`checking agent path: ${candidate}`);
    if (fs.existsSync(candidate)) {
      log(`agent found: ${candidate}`);
      return candidate;
    }
  }

  log(`agent file not found in any of: ${agentsDirs.join(', ')}`);
  return null;
}

/**
 * Determine the policy configuration value to pass to loadConfig
 *
 * Priority: explicit --config, then $MCP_POLICY_CONFIG (left for
 * loadConfig to read), then auto-discovered project and plugin policy
 * directories encoded as inline JSON.
 *
 * @param configPath - Explicit --config value
 * @param env - Hook environment
 * @param log - Debug logger
 * @returns Config value for loadConfig, or undefined to use its defaults
 */
export function discoverPolicyConfig(
  configPath: string | undefined,
  env: HookEnvironment,
  log: (message: string) => void
): string | undefined {
  if (configPath || env.policyConfigEnv) {
    return configPath;
  }

  const patterns: string[] = [];
  const projectPoliciesDir = path.join(env.projectDir, '.claude', 'policies');
  if (fs.existsSync(projectPoliciesDir)) {
    patterns.push(path.join(projectPoliciesDir, '*.md'));
  }
  if (env.pluginRoot) {
    const pluginPoliciesDir = path.join(env.pluginRoot, 'policies');
    if (fs.existsSync(pluginPoliciesDir)) {
      patterns.push(path.join(pluginPoliciesDir, '*.md'));
    }
  }

  if (patterns.length === 0) {
    return undefined;
  }

  log(`using default policy patterns: ${patterns.join(', ')}`);
  return JSON.stringify({ files: patterns });
}

/**
 * Append a policies block to a prompt
 *
 * @param prompt - Original prompt
 * @param policies - Fetched policy content
 * @returns Prompt with trailing <policies> block
 */
export function buildInjectedPrompt(prompt: string, policies: string): string {
  return `${prompt}

<policies>

${policies}

</policies>`;
}

type FetchResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Fetch policies for the references found in agent content
 *
 * @param agentContent - Agent file content
 * @param index - Section index
 * @param baseDir - Base directory for relative file names
 * @param log - Debug logger
 * @returns Fetched content, or the resolution error
 */
export function fetchPoliciesForAgent(
  agentContent: string,
  index: SectionIndex,
  baseDir: string,
  log: (message: string) => void
): FetchResult {
  const rawReferences = findEmbeddedReferences(agentContent);
  log(`found ${rawReferences.length} raw references`);

  if (rawReferences.length === 0) {
    return { ok: true, content: '' };
  }

  const references = dedupeSupersededReferences(rawReferences, (ref, prefix) =>
    log(`${ref} superseded by §${prefix}`)
  );
  log(`${references.length} references after prefix dedup`);

  try {
    const content = fetchPoliciesForReferences(references, index, baseDir);
    log(`fetched ${content.length} chars`);
    return { ok: true, content };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`fetch error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Run a call while console.error is muted
 */
function withMutedStderr<T>(muted: boolean, fn: () => T): T {
  if (!muted) {
    return fn();
  }
  const original = console.error;
  console.error = (): void => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

/**
 * Run the hook against a raw stdin payload
 *
 * Every early exit returns the plain allow response so the tool call is
 * never blocked by hook problems. A deny is only produced when the agent
 * references policies that fail to resolve.
 *
 * @param rawInput - Raw JSON read from stdin
 * @param options - Run options
 * @returns Hook response payload
 */
export function runHook(rawInput: string, options: HookRunOptions): HookOutput {
  const log = options.log ?? ((): void => {});
  const { env } = options;

  const agentsDirs = resolveAgentsDirs(options.agentsDirs ?? [], env);
  log(`resolved agentsDirs: ${agentsDirs.length > 0 ? agentsDirs.join(', ') : '(none found)'}`);

  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch (e) {
    log(`EXIT: invalid JSON - ${e instanceof Error ? e.message : String(e)}`);
    return ALLOW_RESPONSE;
  }

  const subagentType = input.tool_input?.subagent_type;
  const prompt = input.tool_input?.prompt;
  log(`subagent_type: ${subagentType ?? '(not set)'}`);
  log(`prompt length: ${prompt?.length ?? 0} chars`);

  if (!subagentType || !prompt) {
    log('EXIT: missing subagent_type or prompt');
    return ALLOW_RESPONSE;
  }

  const agentPath = findAgentFile(subagentType, agentsDirs, env, log);
  if (!agentPath) {
    log('EXIT: agent file not found');
    return ALLOW_RESPONSE;
  }

  const agentContent = fs.readFileSync(agentPath, 'utf8');
  log(`agent content: ${agentContent.length} chars`);

  if (agentHasPolicyTool(agentContent)) {
    log('EXIT: agent has MCP policy tool, skipping injection');
    return ALLOW_RESPONSE;
  }

  const references = findEmbeddedReferences(agentContent);
  log(`references in agent: ${JSON.stringify(references)}`);
  if (references.length === 0) {
    log('EXIT: no § references in agent file');
    return ALLOW_RESPONSE;
  }

  const effectiveConfigPath = discoverPolicyConfig(options.configPath, env, log);

  let config;
  let index;
  try {
    ({ config, index } = withMutedStderr(!options.log, () => {
      log('loading config...');
      const loaded = loadConfig(effectiveConfigPath);
      log(`config loaded: ${loaded.files.length} files`);
      log('building section index...');
      const built = buildSectionIndex(loaded);
      log(`index built: ${built.sectionCount} sections`);
      return { config: loaded, index: built };
    }));
  } catch (e) {
    log(`EXIT: config/index error - ${e instanceof Error ? e.message : String(e)}`);
    return ALLOW_RESPONSE;
  }

  log('fetching policies...');
  const fetchResult = fetchPoliciesForAgent(agentContent, index, config.baseDir, log);

  if (!fetchResult.ok) {
    log(`BLOCK: ${fetchResult.error}`);
    return denyResponse(`Policy resolution failed: ${fetchResult.error}`);
  }

  if (!fetchResult.content) {
    log('EXIT: no policies resolved');
    return ALLOW_RESPONSE;
  }

  log('SUCCESS: injecting policies into prompt');
  const newPrompt = buildInjectedPrompt(prompt, fetchResult.content);
  log(`injected prompt preview (first 600 chars):\n${newPrompt.slice(0, 600)}`);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...input.tool_input,
        prompt: newPrompt,
      },
    },
  };
}
