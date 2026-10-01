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
import { buildSectionIndex, findTaggedSections } from './indexer.js';
import {
  collectSectionHeadings,
  extractSectionFromLines,
  findEmbeddedReferences,
  isImportantSection,
  parseSectionHeading,
} from './parser.js';
import { joinInventory, resolvePolicyInventory } from './operations.js';
import { InventorySection, SectionIndex, SectionNotation } from './types.js';

/**
 * Shape of the PreToolUse payload the hook reads from stdin
 */
interface HookInput {
  tool_input?: {
    subagent_type?: unknown;
    prompt?: unknown;
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
  /** Injection mode: full policy text (default) or a digest plus important sections */
  mode?: 'full' | 'digest';
  /** Digest rendering overrides, used only in digest mode */
  digest?: Partial<DigestOptions>;
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

/** Anchored per-token match for the fetch_policies MCP tool name */
const POLICY_TOOL_PATTERN = /^mcp__(?:\w+_)?policy-server__fetch_policies$/;

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

  return toolsMatch[1].split(/[\s,[\]"']+/).some((token) => POLICY_TOOL_PATTERN.test(token));
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
 * Prepend a policies block to a prompt
 *
 * @param prompt - Original prompt
 * @param policies - Fetched policy content
 * @returns Policies block first, then the original prompt wrapped in <task>;
 *   the policies form a stable prefix so they can be prompt-cached
 */
export function buildInjectedPrompt(prompt: string, policies: string): string {
  return `<policies>

${policies}

</policies>

<task>

${prompt}

</task>`;
}

type FetchResult =
  | { ok: true; content: string; inventory: InventorySection[] }
  | { ok: false; error: string };

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
    return { ok: true, content: '', inventory: [] };
  }

  try {
    const inventory = resolvePolicyInventory(rawReferences, index, baseDir, (ref, prefix) =>
      log(`${ref} superseded by §${prefix}`)
    );
    const content = joinInventory(inventory);
    log(`fetched ${content.length} chars`);
    return { ok: true, content, inventory };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`fetch error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Options controlling digest rendering
 */
export interface DigestOptions {
  /** Deepest nested section level listed (§DOC.4 is level 1, §DOC.4.1 is level 2) */
  depth: number;
  /** Maximum characters per digest line, excluding the full-text marker */
  lineChars: number;
  /** Render every digest line as id and title only */
  minimal: boolean;
  /** Host text that replaces the whole default footer statement */
  fetchInstructions?: string;
  /** Active config value quoted in the default footer */
  configValue?: string;
}

/** Digest defaults: depth 2, 200 chars per line, full lines */
export const DEFAULT_DIGEST_OPTIONS: DigestOptions = {
  depth: 2,
  lineChars: 200,
  minimal: false,
};

/**
 * Rendered digest with counts
 */
export interface PolicyDigest {
  /** Digest block, full-text block and footer */
  text: string;
  /** Number of digest lines */
  summarized: number;
  /** Number of sections rendered in full */
  full: number;
}

const FULL_TEXT_MARKER = ' (full text below)';
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

interface DigestEntry {
  id: SectionNotation;
  title: string;
  sentence: string;
  important: boolean;
}

/** First sentence of the first paragraph of prose following a heading, up to the next § heading */
function firstSentence(lines: string[], headingIndex: number): string {
  const paragraph: string[] = [];
  let inFence = false;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (parseSectionHeading(line)) break;
    const trimmed = line.trim();
    if (trimmed === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#+(\s|$)/.test(trimmed) || HORIZONTAL_RULE.test(line) || trimmed.startsWith('|'))
      continue;
    const text = trimmed
      .replace(/^(?:>\s?)+/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .trim();
    if (text) paragraph.push(text);
  }
  const joined = paragraph.join(' ');
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(joined);
  return (match ? match[0] : joined).trim();
}

function digestLine(entry: DigestEntry, options: DigestOptions, titleOnly: boolean): string {
  const sentence = titleOnly ? '' : entry.sentence;
  let rest = '';
  if (entry.title) rest += ` ${entry.title}`;
  if (sentence) rest += `: ${sentence}`;
  const room = Math.max(0, options.lineChars - entry.id.length);
  if (rest.length > room) {
    rest = room > 1 ? `${rest.slice(0, room - 1)}…` : rest.slice(0, room);
  }
  return `${entry.id}${rest}${entry.important ? FULL_TEXT_MARKER : ''}`;
}

/** True when a proper ancestor of id (below the entry itself) is important, so its block already covers id */
function isInheritedImportant(
  id: SectionNotation,
  tagged: ReadonlySet<SectionNotation>,
  entryId: SectionNotation
): boolean {
  let parent = id.substring(0, id.lastIndexOf('.'));
  while (parent.includes('.') && parent !== entryId) {
    if (isImportantSection(parent as SectionNotation, tagged)) return true;
    parent = parent.substring(0, parent.lastIndexOf('.'));
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Render a policy digest: one line per inventory section, then the full text
 * of important sections, then a footer on how to fetch the rest
 *
 * Nested § headings inside an entry whose level is within options.depth get
 * their own lines. Nested headings that are themselves inventory entries are
 * not repeated. With options.minimal every line is its id and title only.
 *
 * @param inventory - Resolved sections in output order
 * @param tagged - Ids of headings tagged important
 * @param options - Rendering options
 * @returns Digest text and counts
 */
export function buildPolicyDigest(
  inventory: InventorySection[],
  tagged: ReadonlySet<SectionNotation>,
  options: DigestOptions
): PolicyDigest {
  const inventoryIds = new Set(inventory.map((section) => section.id));
  const entries: DigestEntry[] = [];
  const fullBlocks: string[] = [];

  for (const section of inventory) {
    const lines = section.content.split('\n');
    const headings = collectSectionHeadings(lines);
    const own = headings.find((heading) => heading.id === section.id);
    const entryImportant = isImportantSection(section.id, tagged);
    entries.push({
      id: section.id,
      title: own?.title ?? '',
      sentence: own ? firstSentence(lines, own.lineIndex) : '',
      important: entryImportant,
    });
    if (entryImportant) fullBlocks.push(section.content);

    for (const heading of headings) {
      if (heading.id === section.id || inventoryIds.has(heading.id)) continue;
      const important = isImportantSection(heading.id, tagged);
      const level = heading.id.split('.').length - 1;
      if (level <= options.depth || (important && !entryImportant)) {
        entries.push({
          id: heading.id,
          title: heading.title,
          sentence: firstSentence(lines, heading.lineIndex),
          important,
        });
      }
      if (important && !entryImportant && !isInheritedImportant(heading.id, tagged, section.id)) {
        const num = heading.id.slice(heading.id.indexOf('.') + 1);
        const headingPrefix = heading.id.slice(1, heading.id.indexOf('.'));
        const extracted = extractSectionFromLines(lines, headingPrefix, num);
        if (extracted) {
          fullBlocks.push(extracted);
        } else {
          // Extractor only matches ## and ### headings; slice deeper headings directly
          // Stop at the first heading that is not a descendant of this one
          const next = headings.find(
            (other) => other.lineIndex > heading.lineIndex && !other.id.startsWith(`${heading.id}.`)
          );
          const end = next ? next.lineIndex : lines.length;
          fullBlocks.push(lines.slice(heading.lineIndex, end).join('\n').replace(/\s+$/, ''));
        }
      }
    }
  }

  if (entries.length === 0) {
    return { text: '', summarized: 0, full: 0 };
  }

  const digestLines = entries.map((entry) => digestLine(entry, options, options.minimal));

  const footer =
    options.fetchInstructions ??
    `The policy list above is a digest. Fetch the full text of any section before relying on it: policy-cli fetch-policies${
      options.configValue === undefined ? '' : ` --config ${shellQuote(options.configValue)}`
    } §ID ...`;

  const blocks = [digestLines.join('\n')];
  if (fullBlocks.length > 0) blocks.push(fullBlocks.join('\n'));
  blocks.push(footer);

  return {
    text: blocks.join('\n\n'),
    summarized: digestLines.length,
    full: fullBlocks.length,
  };
}

/**
 * Resolve the config value quoted in the digest footer
 *
 * Inline JSON is kept as-is; paths and globs are made absolute against cwd.
 */
function footerConfigValue(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.startsWith('{') && value.endsWith('}')) return value;
  return path.resolve(process.cwd(), value);
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
  log(`prompt length: ${typeof prompt === 'string' ? prompt.length : 0} chars`);

  if (typeof subagentType !== 'string' || typeof prompt !== 'string' || !subagentType || !prompt) {
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
      log(
        `policy files: ${loaded.files.slice(0, 5).join(', ')}${loaded.files.length > 5 ? '...' : ''}`
      );
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

  log(`inventory: ${fetchResult.inventory.length} sections`);
  log(`full text: ${fetchResult.content.length} chars`);

  let injected = fetchResult.content;
  if (options.mode === 'digest') {
    let digest: PolicyDigest;
    try {
      const tagged = findTaggedSections(
        fetchResult.inventory.map((section) => section.id),
        index
      );
      digest = buildPolicyDigest(fetchResult.inventory, tagged, {
        ...DEFAULT_DIGEST_OPTIONS,
        ...options.digest,
        configValue: footerConfigValue(effectiveConfigPath ?? env.policyConfigEnv),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`BLOCK: ${error}`);
      return denyResponse(`Policy resolution failed: ${error}`);
    }
    log(
      `digest: ${digest.text.length} chars (${digest.summarized} summarized, ${digest.full} full)`
    );
    injected = digest.text;
  }

  log('SUCCESS: injecting policies into prompt');
  const newPrompt = buildInjectedPrompt(prompt, injected);
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
