/**
 * Tests for hook-runner.ts
 * Agent detection and the PreToolUse hook pipeline
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  agentHasPolicyTool,
  ALLOW_RESPONSE,
  buildInjectedPrompt,
  buildPolicyDigest,
  DEFAULT_DIGEST_OPTIONS,
  DigestOptions,
  denyResponse,
  discoverPolicyConfig,
  fetchPoliciesForAgent,
  findAgentFile,
  HookEnvironment,
  pluginNamespace,
  resolveAgentsDirs,
  runHook,
} from '../src/hook-runner.js';
import { buildSectionIndex, findTaggedSections } from '../src/indexer.js';
import { resolvePolicyInventory } from '../src/operations.js';
import { SectionNotation } from '../src/types.js';

const mocks = vi.hoisted(() => ({ failTagged: false }));
vi.mock('../src/indexer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer.js')>();
  return {
    ...actual,
    findTaggedSections: (...args: Parameters<typeof actual.findTaggedSections>) => {
      if (mocks.failTagged) throw new Error('Failed to read policy file (simulated)');
      return actual.findTaggedSections(...args);
    },
  };
});

describe('agentHasPolicyTool', () => {
  it('should return true for direct MCP policy tool', () => {
    const content = `---
name: test-agent
tools: Read, Write, mcp__policy-server__fetch_policies
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should return true for plugin-namespaced policy tool', () => {
    const content = `---
name: test-agent
tools: Read, mcp__plugin_para_policy-server__fetch_policies, Write
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should return true for multi-segment plugin namespace', () => {
    const content = `---
name: test-agent
tools: mcp__plugin_foo_bar_policy-server__fetch_policies
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should return false when no policy tool present', () => {
    const content = `---
name: test-agent
tools: Read, Write, Edit, Grep, Bash
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false for other MCP tools', () => {
    const content = `---
name: test-agent
tools: mcp__other-server__some_tool
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false when no frontmatter', () => {
    const content = `# Agent without frontmatter
Some content here`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false when no tools in frontmatter', () => {
    const content = `---
name: test-agent
description: No tools defined
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false for unclosed frontmatter', () => {
    const content = `---
name: test-agent
tools: mcp__policy-server__fetch_policies
# Missing closing delimiter`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should reject adversarial non-matching tool lines without catastrophic backtracking', () => {
    const exponential = `---
tools: mcp__${'a_'.repeat(40)}
---`;
    const repeatedPrefix = `---
tools: ${'mcp__a'.repeat(50000)}
---`;
    const start = Date.now();
    expect(agentHasPolicyTool(exponential)).toBe(false);
    expect(agentHasPolicyTool(repeatedPrefix)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('should detect policy tool in a bracketed list', () => {
    const content = `---
tools: [Read, mcp__policy-server__fetch_policies]
---`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should detect policy tool in quoted lists', () => {
    const double = `---
tools: ["mcp__policy-server__fetch_policies"]
---`;
    const single = `---
tools: 'mcp__policy-server__fetch_policies'
---`;
    expect(agentHasPolicyTool(double)).toBe(true);
    expect(agentHasPolicyTool(single)).toBe(true);
  });

  it('should handle policy tool as only tool', () => {
    const content = `---
tools: mcp__policy-server__fetch_policies
---`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should not match partial tool names', () => {
    const content = `---
tools: mcp__policy-server__validate_references
---`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });
});

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');

const POLICY_A = `# A

## {§A.1} First

Alpha content referencing §B.1.

## {§A.2} Second

Beta content.

{§END}
`;

const POLICY_B = `# B

## {§B.1} Only

Bravo content.

{§END}
`;

/** Build a project layout with .claude/agents and .claude/policies */
function makeProject(root: string): { agentsDir: string; policiesDir: string } {
  const agentsDir = path.join(root, '.claude', 'agents');
  const policiesDir = path.join(root, '.claude', 'policies');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(policiesDir, { recursive: true });
  fs.writeFileSync(path.join(policiesDir, 'policy-a.md'), POLICY_A);
  fs.writeFileSync(path.join(policiesDir, 'policy-b.md'), POLICY_B);
  return { agentsDir, policiesDir };
}

/** Build a plugin layout at <root>/plugins/<ns>/1.0.0 */
function makePlugin(root: string, ns: string): string {
  const pluginRoot = path.join(root, 'plugins', ns, '1.0.0');
  fs.mkdirSync(path.join(pluginRoot, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'policies'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'policies', 'policy-b.md'), POLICY_B);
  return pluginRoot;
}

function hookInput(subagentType: string, prompt = 'Do the task', extra = {}): string {
  return JSON.stringify({
    tool_input: { subagent_type: subagentType, prompt, ...extra },
  });
}

describe('hook-runner', () => {
  let tmpDir: string;
  let env: HookEnvironment;
  let logs: string[];
  const log = (m: string): number => logs.push(m);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-hook-'));
    env = { projectDir: tmpDir };
    logs = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveAgentsDirs', () => {
    it('resolves explicit directories against the project directory', () => {
      expect(resolveAgentsDirs(['agents', '/abs/agents'], env)).toEqual([
        path.join(tmpDir, 'agents'),
        '/abs/agents',
      ]);
    });

    it('returns only existing default directories, project first', () => {
      expect(resolveAgentsDirs([], env)).toEqual([]);

      const { agentsDir } = makeProject(tmpDir);
      const pluginRoot = makePlugin(tmpDir, 'myplug');
      expect(resolveAgentsDirs([], { ...env, pluginRoot })).toEqual([
        agentsDir,
        path.join(pluginRoot, 'agents'),
      ]);
    });
  });

  describe('pluginNamespace', () => {
    it('uses the parent directory of the versioned plugin root', () => {
      expect(pluginNamespace('/x/plugins/conduct/1.2.3')).toBe('conduct');
      expect(pluginNamespace(undefined)).toBeNull();
    });
  });

  describe('findAgentFile', () => {
    it('searches directories in order for plain agent names', () => {
      const first = path.join(tmpDir, 'first');
      const second = path.join(tmpDir, 'second');
      fs.mkdirSync(first);
      fs.mkdirSync(second);
      fs.writeFileSync(path.join(second, 'bot.md'), '# bot');

      expect(findAgentFile('bot', [first, second], env, log)).toBe(path.join(second, 'bot.md'));
      expect(findAgentFile('missing', [first, second], env, log)).toBeNull();
      expect(logs.some((l) => l.includes('not found in any of'))).toBe(true);
    });

    it('resolves namespaced agents only from our own plugin', () => {
      const pluginRoot = makePlugin(tmpDir, 'ours');
      const agentPath = path.join(pluginRoot, 'agents', 'worker.md');
      fs.writeFileSync(agentPath, '# worker');
      const pluginEnv = { ...env, pluginRoot };

      expect(findAgentFile('ours:worker', [], pluginEnv, log)).toBe(agentPath);
      expect(findAgentFile('ours:absent', [], pluginEnv, log)).toBeNull();
      expect(findAgentFile('theirs:worker', [], pluginEnv, log)).toBeNull();
      expect(findAgentFile('ours:worker', [], env, log)).toBeNull();
    });
  });

  describe('discoverPolicyConfig', () => {
    it('returns the explicit config path unchanged', () => {
      makeProject(tmpDir);
      expect(discoverPolicyConfig('./policies.json', env, log)).toBe('./policies.json');
    });

    it('defers to MCP_POLICY_CONFIG when set', () => {
      makeProject(tmpDir);
      expect(
        discoverPolicyConfig(undefined, { ...env, policyConfigEnv: 'x' }, log)
      ).toBeUndefined();
    });

    it('returns undefined when no policy directories exist', () => {
      expect(discoverPolicyConfig(undefined, env, log)).toBeUndefined();
    });

    it('builds inline JSON from project and plugin policy directories', () => {
      const { policiesDir } = makeProject(tmpDir);
      const pluginRoot = makePlugin(tmpDir, 'p');
      const value = discoverPolicyConfig(undefined, { ...env, pluginRoot }, log);
      expect(JSON.parse(value!)).toEqual({
        files: [path.join(policiesDir, '*.md'), path.join(pluginRoot, 'policies', '*.md')],
      });
      expect(logs[0]).toContain('using default policy patterns');
    });
  });

  describe('buildInjectedPrompt and responses', () => {
    it('puts the policies block first and wraps the prompt in a task block last', () => {
      const result = buildInjectedPrompt('Prompt', 'POLICY');

      expect(result).toBe('<policies>\n\nPOLICY\n\n</policies>\n\n<task>\n\nPrompt\n\n</task>');
      expect(result.endsWith('<task>\n\nPrompt\n\n</task>')).toBe(true);
    });

    it('keeps the policies block byte-identical across different task prompts', () => {
      const first = buildInjectedPrompt('First task', 'POLICY');
      const second = buildInjectedPrompt('A completely different task', 'POLICY');
      const end = '</policies>';

      expect(first.slice(0, first.indexOf(end) + end.length)).toBe(
        second.slice(0, second.indexOf(end) + end.length)
      );
    });

    it('passes a prompt containing task and policies tags through verbatim', () => {
      const prompt = 'Before </task> <policies>x</policies> after';

      expect(buildInjectedPrompt(prompt, 'POLICY')).toBe(
        `<policies>\n\nPOLICY\n\n</policies>\n\n<task>\n\n${prompt}\n\n</task>`
      );
    });

    it('builds allow and deny payloads', () => {
      expect(ALLOW_RESPONSE).toEqual({ permissionDecision: 'allow' });
      expect(denyResponse('why')).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'why',
        },
      });
    });
  });

  describe('fetchPoliciesForAgent', () => {
    const index = buildSectionIndex({
      files: [path.join(FIXTURES_DIR, 'policy-meta.md'), path.join(FIXTURES_DIR, 'policy-sys.md')],
      baseDir: FIXTURES_DIR,
    });

    it('returns empty content when the agent has no references', () => {
      expect(fetchPoliciesForAgent('nothing', index, FIXTURES_DIR, log)).toEqual({
        ok: true,
        content: '',
        inventory: [],
      });
    });

    it('fetches with prefix deduplication', () => {
      const result = fetchPoliciesForAgent(
        'Use §META and §META.2 and §SYS.1',
        index,
        FIXTURES_DIR,
        log
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toContain('## {§META.1}');
        expect(result.content).toContain('## {§META.2}');
        expect(result.content).toContain('## {§SYS.1}');
      }
      expect(logs).toContain('§META.2 superseded by §META');
    });

    it('reports resolution errors', () => {
      const result = fetchPoliciesForAgent('Use §META.99', index, FIXTURES_DIR, log);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('§META.99');
      }
    });
  });

  describe('runHook', () => {
    it('allows on invalid JSON', () => {
      expect(runHook('not json', { env, log })).toEqual(ALLOW_RESPONSE);
      expect(logs.some((l) => l.startsWith('EXIT: invalid JSON'))).toBe(true);
    });

    it('allows when subagent_type or prompt is missing', () => {
      expect(runHook(JSON.stringify({ tool_input: { prompt: 'x' } }), { env })).toEqual(
        ALLOW_RESPONSE
      );
      expect(
        runHook(JSON.stringify({ tool_input: { subagent_type: 'a' } }), {
          env,
        })
      ).toEqual(ALLOW_RESPONSE);
      expect(runHook('{}', { env })).toEqual(ALLOW_RESPONSE);
    });

    it('allows when the agent file does not exist', () => {
      makeProject(tmpDir);
      expect(runHook(hookInput('ghost'), { env, log })).toEqual(ALLOW_RESPONSE);
      expect(logs).toContain('EXIT: agent file not found');
    });

    it('allows when the agent declares the MCP policy tool', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(
        path.join(agentsDir, 'self.md'),
        '---\ntools: mcp__policy-server__fetch_policies\n---\nUse §A.1'
      );
      expect(runHook(hookInput('self'), { env, log })).toEqual(ALLOW_RESPONSE);
      expect(logs).toContain('EXIT: agent has MCP policy tool, skipping injection');
    });

    it('allows when the agent has no references', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(agentsDir, 'plain.md'), '# No refs');
      expect(runHook(hookInput('plain'), { env, log })).toEqual(ALLOW_RESPONSE);
      expect(logs).toContain('EXIT: no § references in agent file');
    });

    it('allows when no policy configuration can be loaded', () => {
      const agentsDir = path.join(tmpDir, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Use §A.1');
      // No policies dir, no config: loadConfig falls back to ./policies.json in cwd
      vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      expect(runHook(hookInput('bot'), { env, log })).toEqual(ALLOW_RESPONSE);
      expect(logs.some((l) => l.startsWith('EXIT: config/index error'))).toBe(true);
    });

    it('injects resolved policies into the prompt using auto-discovered config', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Follow §A.2 please.');

      const output = runHook(hookInput('bot', 'Original', { model: 'x' }), {
        env,
        log,
      });
      expect('hookSpecificOutput' in output).toBe(true);
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'allow'
      ) {
        const { updatedInput } = output.hookSpecificOutput;
        expect(updatedInput.model).toBe('x');
        expect(updatedInput.subagent_type).toBe('bot');
        expect(updatedInput.prompt.startsWith('<policies>\n\n## {§A.2}')).toBe(true);
        expect(updatedInput.prompt.endsWith('</policies>\n\n<task>\n\nOriginal\n\n</task>')).toBe(
          true
        );
        expect(updatedInput.prompt).not.toContain('{§A.1}');
      }
      expect(logs).toContain('SUCCESS: injecting policies into prompt');
    });

    it('follows embedded references across project and plugin policies', () => {
      const { agentsDir, policiesDir } = makeProject(tmpDir);
      fs.rmSync(path.join(policiesDir, 'policy-b.md'));
      const pluginRoot = makePlugin(tmpDir, 'ns');
      fs.writeFileSync(path.join(pluginRoot, 'agents', 'worker.md'), 'See §A.1');
      fs.writeFileSync(path.join(agentsDir, 'local.md'), 'See §A.1');

      const output = runHook(hookInput('ns:worker'), {
        env: { ...env, pluginRoot },
      });
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'allow'
      ) {
        expect(output.hookSpecificOutput.updatedInput.prompt).toContain('## {§A.1}');
        expect(output.hookSpecificOutput.updatedInput.prompt).toContain('## {§B.1}');
      } else {
        throw new Error(`unexpected output ${JSON.stringify(output)}`);
      }
    });

    it('uses an explicit --config value and explicit agents dirs', () => {
      const agentsDir = path.join(tmpDir, 'custom-agents');
      fs.mkdirSync(agentsDir);
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'See §META.1');
      const configPath = path.join(FIXTURES_DIR, 'policy-meta.md').split(path.sep).join('/');

      const output = runHook(hookInput('bot'), {
        env,
        configPath,
        agentsDirs: ['custom-agents'],
      });
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'allow'
      ) {
        expect(output.hookSpecificOutput.updatedInput.prompt).toContain('## {§META.1}');
      } else {
        throw new Error(`unexpected output ${JSON.stringify(output)}`);
      }
    });

    it('denies when a referenced section cannot be resolved', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Follow §A.9.');

      const output = runHook(hookInput('bot'), { env, log });
      expect(output).toEqual(
        denyResponse(expect.stringContaining('Policy resolution failed') as unknown as string)
      );
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'deny'
      ) {
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('§A.9');
      }
      expect(logs.some((l) => l.startsWith('BLOCK:'))).toBe(true);
    });

    it('denies a prefix-only reference whose sections are duplicated', () => {
      const { agentsDir, policiesDir } = makeProject(tmpDir);
      for (const name of ['policy-duplicate1.md', 'policy-duplicate2.md']) {
        fs.copyFileSync(path.join(FIXTURES_DIR, name), path.join(policiesDir, name));
      }
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Use §DUP');

      const output = runHook(hookInput('bot'), { env, log });
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'deny'
      ) {
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
          'Policy resolution failed'
        );
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('§DUP.1');
      } else {
        throw new Error(`expected deny, got ${JSON.stringify(output)}`);
      }
      expect(logs.some((l) => l.startsWith('BLOCK:'))).toBe(true);
    });

    it('denies when an embedded reference cannot be resolved', () => {
      const { agentsDir, policiesDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(policiesDir, 'policy-e.md'), '## {§E.1} T\nSee §NOPE here.\n');
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Follow §E.1');

      const output = runHook(hookInput('bot'), { env, log });
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'deny'
      ) {
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('NOPE');
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain('§E.1');
      } else {
        throw new Error(`expected deny, got ${JSON.stringify(output)}`);
      }
    });

    it('mutes config logging when no logger is supplied', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Follow §A.2.');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      runHook(hookInput('bot'), { env });
      expect(errorSpy).not.toHaveBeenCalled();

      runHook(hookInput('bot'), { env, log });
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('runHook modes', () => {
    const MODE_POLICY = `## {§M.1} [IMPORTANT] Core
Core rule applies always. More words.

## {§M.2} Plain
Plain body. More words.
{§END}
`;

    function setup(): {
      prompt: (opts: Partial<Parameters<typeof runHook>[1]>, task?: string) => string;
    } {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Follow §M.1 and §M.2.');
      fs.writeFileSync(path.join(tmpDir, 'policy-m.md'), MODE_POLICY);
      return {
        prompt: (opts, task = 'Original') => {
          const output = runHook(hookInput('bot', task), {
            env,
            log,
            configPath: path.join(tmpDir, 'policy-m.md'),
            ...opts,
          });
          if (
            'hookSpecificOutput' in output &&
            output.hookSpecificOutput.permissionDecision === 'allow'
          ) {
            return output.hookSpecificOutput.updatedInput.prompt;
          }
          throw new Error(`unexpected output ${JSON.stringify(output)}`);
        },
      };
    }

    it('gives a byte-identical prompt when no mode is set and ignores digest options in full mode', () => {
      const { prompt } = setup();
      const inventory = resolvePolicyInventory(
        ['§M.1', '§M.2'],
        buildSectionIndex({
          files: [path.join(tmpDir, 'policy-m.md')],
          baseDir: tmpDir,
        }),
        tmpDir
      );
      const expected = buildInjectedPrompt(
        'Original',
        inventory.map((section) => section.content).join('\n')
      );

      expect(prompt({})).toBe(expected);
      expect(
        prompt({
          mode: 'full',
          digest: { minimal: true, fetchInstructions: 'x' },
        })
      ).toBe(expected);
    });

    it.each(['full', 'digest'] as const)(
      'keeps the text up to </policies> identical across prompts in %s mode',
      (mode) => {
        const { prompt } = setup();
        const end = '</policies>';
        const first = prompt({ mode }, 'First task');
        const second = prompt({ mode }, 'A completely different task');

        expect(first).not.toBe(second);
        expect(first.slice(0, first.indexOf(end) + end.length)).toBe(
          second.slice(0, second.indexOf(end) + end.length)
        );
      }
    );

    it('gives a digest block, then the full block of important sections, then the footer', () => {
      const { prompt } = setup();
      const result = prompt({ mode: 'digest' });
      const body = result.slice(
        result.indexOf('<policies>\n\n') + '<policies>\n\n'.length,
        result.lastIndexOf('\n\n</policies>')
      );
      const [digestBlock, fullBlock, footer] = body.split('\n\n');

      expect(result.startsWith('<policies>\n\n')).toBe(true);
      expect(result.endsWith('\n\n<task>\n\nOriginal\n\n</task>')).toBe(true);
      expect(digestBlock).toBe(
        '§M.1 Core: Core rule applies always. (full text below)\n§M.2 Plain: Plain body.'
      );
      expect(fullBlock).toContain('## {§M.1} [IMPORTANT] Core');
      expect(fullBlock).not.toContain('{§M.2}');
      expect(footer).toContain('policy-cli fetch-policies');
    });

    it('quotes the absolute active config value in the default footer', () => {
      const { prompt } = setup();
      vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const result = prompt({ mode: 'digest', configPath: './policy-m.md' });

      expect(result).toContain(
        `policy-cli fetch-policies --config '${path.join(tmpDir, 'policy-m.md')}' §ID ...`
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('prints a config taken from MCP_POLICY_CONFIG explicitly in the default footer', () => {
      const { prompt } = setup();
      const configPath = path.join(tmpDir, 'policy-m.md');
      vi.stubEnv('MCP_POLICY_CONFIG', configPath);

      const result = prompt({
        mode: 'digest',
        configPath: undefined,
        env: { ...env, policyConfigEnv: configPath },
      });

      expect(result).toContain(`--config '${configPath}'`);
    });

    it('passes inline JSON config as-is in the default footer', () => {
      const { prompt } = setup();
      const json = JSON.stringify({
        files: [path.join(tmpDir, 'policy-m.md')],
      });

      const result = prompt({ mode: 'digest', configPath: json });

      expect(result).toContain(`--config '${json}' §ID ...`);
      expect(result).not.toContain(path.join(process.cwd(), '{'));
    });

    it('denies in digest mode when the policy file is unreadable at digest time', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Follow §M.1 and §M.2.');
      const policyFile = path.join(tmpDir, 'policy-m.md');
      fs.writeFileSync(policyFile, MODE_POLICY);
      mocks.failTagged = true;

      const output = runHook(hookInput('bot', 'Original'), {
        env,
        log,
        configPath: policyFile,
        mode: 'digest',
      });

      mocks.failTagged = false;
      expect(JSON.stringify(output)).toContain('Policy resolution failed');
      expect('hookSpecificOutput' in output && output.hookSpecificOutput.permissionDecision).toBe(
        'deny'
      );
    });

    it('replaces the default statement with --fetch-instructions text', () => {
      const { prompt } = setup();
      const result = prompt({
        mode: 'digest',
        digest: { fetchInstructions: 'HOST FETCH TEXT' },
      });

      expect(result).toContain('\n\nHOST FETCH TEXT\n\n</policies>');
      expect(result).not.toContain('policy-cli fetch-policies');
    });

    it('writes the inventory, full text and digest debug lines', () => {
      const { prompt } = setup();
      prompt({ mode: 'digest' });

      expect(logs).toContain('inventory: 2 sections');
      expect(logs.some((l) => /^full text: \d+ chars$/.test(l))).toBe(true);
      expect(logs.some((l) => /^digest: \d+ chars \(2 summarized, 1 full\)$/.test(l))).toBe(true);
    });

    it('delivers an untagged same-level descendant of a tagged ### section in full', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(path.join(agentsDir, 'xx-engineer.md'), 'Follow §XX.');
      const policyFile = path.join(tmpDir, 'policy-xx.md');
      fs.writeFileSync(
        policyFile,
        [
          '## {§XX.1} Untagged Parent',
          'Parent first sentence about the parent.',
          '',
          '### {§XX.1.1} [IMPORTANT] Tagged Child',
          'Tagged child first sentence. CHILD-BODY-MARKER.',
          '',
          '### {§XX.1.1.1} Grandchild At Level Three',
          'Grandchild first sentence. GRANDCHILD-L3-MARKER.',
          '',
          '{§END}',
          '',
        ].join('\n')
      );

      const output = runHook(hookInput('xx-engineer'), {
        env,
        log,
        configPath: policyFile,
        mode: 'digest',
      });

      const text = JSON.stringify(output);
      expect(text.split('CHILD-BODY-MARKER').length - 1).toBe(1);
      expect(text.split('GRANDCHILD-L3-MARKER').length - 1).toBe(1);
    });
  });

  describe('runHook policy-mode frontmatter', () => {
    const MODE_POLICY = `## {§M.1} [IMPORTANT] Core
Core rule applies always. More words.

## {§M.2} Plain
Plain body. More words.
{§END}
`;

    function run(
      frontmatter: string[],
      opts: Partial<Parameters<typeof runHook>[1]> = {}
    ): ReturnType<typeof runHook> {
      const { agentsDir } = makeProject(tmpDir);
      const agentFile = path.join(agentsDir, 'bot.md');
      fs.writeFileSync(
        agentFile,
        ['---', 'name: bot', ...frontmatter, '---', 'Follow §M.1 and §M.2.'].join('\n')
      );
      const policyFile = path.join(tmpDir, 'policy-m.md');
      fs.writeFileSync(policyFile, MODE_POLICY);
      return runHook(hookInput('bot'), { env, log, configPath: policyFile, ...opts });
    }

    function promptOf(output: ReturnType<typeof runHook>): string {
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'allow'
      ) {
        return output.hookSpecificOutput.updatedInput.prompt;
      }
      throw new Error(`unexpected output ${JSON.stringify(output)}`);
    }

    it('lets frontmatter digest override a full flag', () => {
      const prompt = promptOf(run(['policy-mode: digest'], { mode: 'full' }));

      expect(prompt).toContain('§M.2 Plain: Plain body.');
      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('lets frontmatter full override a digest flag', () => {
      const prompt = promptOf(run(['policy-mode: full'], { mode: 'digest' }));

      expect(prompt).toContain('## {§M.2} Plain');
    });

    it('gives title-only lines for digest-minimal and keeps other digest options', () => {
      const prompt = promptOf(
        run(['policy-mode: digest-minimal'], { digest: { fetchInstructions: 'HOST FETCH' } })
      );

      expect(prompt).toContain('§M.2 Plain\n');
      expect(prompt).not.toContain('Plain body.');
      expect(prompt).toContain('§M.1 Core (full text below)');
      expect(prompt).toContain('HOST FETCH');
    });

    it('forces minimal off for frontmatter digest even when the flag asks for minimal', () => {
      const prompt = promptOf(run(['policy-mode: digest'], { digest: { minimal: true } }));

      expect(prompt).toContain('§M.2 Plain: Plain body.');
    });

    it('denies an invalid value naming the agent file and the value', () => {
      const output = run(['policy-mode: summary']);

      expect('hookSpecificOutput' in output && output.hookSpecificOutput.permissionDecision).toBe(
        'deny'
      );
      const text = JSON.stringify(output);
      expect(text).toContain('summary');
      expect(text).toContain(
        'Policy resolution failed: invalid policy-mode \\"summary\\" in bot.md'
      );
      expect(text).not.toContain(tmpDir);
    });

    it('caps a long invalid value in the deny reason', () => {
      const output = run([`policy-mode: ${'x'.repeat(100)}`]);

      const text = JSON.stringify(output);
      expect(text).toContain('x'.repeat(40));
      expect(text).not.toContain('x'.repeat(41));
    });

    it('denies an invalid value even when the agent has the fetch_policies tool', () => {
      const output = run(['tools: mcp__policy-server__fetch_policies', 'policy-mode: bogus']);

      expect('hookSpecificOutput' in output && output.hookSpecificOutput.permissionDecision).toBe(
        'deny'
      );
    });

    it('denies an invalid value even when the agent has no § references', () => {
      const { agentsDir } = makeProject(tmpDir);
      fs.writeFileSync(
        path.join(agentsDir, 'bot.md'),
        '---\nname: bot\npolicy-mode: bogus\n---\nNo references here.'
      );

      const output = runHook(hookInput('bot'), { env, log });

      expect('hookSpecificOutput' in output && output.hookSpecificOutput.permissionDecision).toBe(
        'deny'
      );
    });

    it('ignores a trailing YAML comment on policy-mode', () => {
      const prompt = promptOf(run(['policy-mode: digest # compact']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('accepts a quoted policy-mode value with CRLF line endings', () => {
      const prompt = promptOf(run(['policy-mode: "digest"\r']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('treats an empty policy-mode as absent', () => {
      const prompt = promptOf(run(['policy-mode:']));

      expect(prompt).toContain('## {§M.2} Plain');
    });

    it('reads policy-mode after a value containing ---', () => {
      const prompt = promptOf(run(['description: a --- b', 'policy-mode: digest']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('ignores a trailing YAML comment on tools', () => {
      const prompt = promptOf(run(['tools: Read # Bash', 'policy-mode: digest']));

      expect(prompt).toContain('## {§M.2} Plain');
    });

    it('falls back to full when tools are declared without Bash', () => {
      const prompt = promptOf(run(['tools: Read, Write', 'policy-mode: digest']));

      expect(prompt).toContain('## {§M.2} Plain');
      expect(prompt).not.toContain('policy-cli fetch-policies');
      expect(logs.some((l) => l.includes('no Bash'))).toBe(true);
    });

    it('keeps digest when tools include Bash', () => {
      const prompt = promptOf(run(['tools: Read, Bash', 'policy-mode: digest']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('keeps digest when Bash is scoped', () => {
      const prompt = promptOf(run(['tools: Read, Bash(git:*), Grep', 'policy-mode: digest']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('keeps digest when a block-style tools list includes Bash', () => {
      const prompt = promptOf(run(['tools:', '  - Read', '  - Bash', 'policy-mode: digest']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('falls back to full when a block-style tools list lacks Bash', () => {
      const prompt = promptOf(run(['tools:', '  - Read', '  - Write', 'policy-mode: digest']));

      expect(prompt).toContain('## {§M.2} Plain');
      expect(prompt).not.toContain('policy-cli fetch-policies');
    });

    it('falls back to full when an inline list lacks Bash', () => {
      const prompt = promptOf(run(['tools: [Read, Write]', 'policy-mode: digest']));

      expect(prompt).toContain('## {§M.2} Plain');
    });

    it('keeps digest when a CRLF block-style tools list includes Bash', () => {
      const prompt = promptOf(run(['tools:\r\n  - Read\r\n  - Bash\r\npolicy-mode: digest']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('does not apply the guard when tools is empty', () => {
      const prompt = promptOf(run(['tools:', 'policy-mode: digest']));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('does not apply the Bash guard to a mode taken from the flag', () => {
      const prompt = promptOf(run(['tools: Read'], { mode: 'digest' }));

      expect(prompt).toContain('policy-cli fetch-policies');
    });

    it('behaves as before when the key is absent', () => {
      const withKey = promptOf(run([], { mode: 'digest' }));
      const plain = promptOf(run([]));

      expect(withKey).toContain('policy-cli fetch-policies');
      expect(plain).toContain('## {§M.2} Plain');
    });

    it('logs the resolved mode and its source', () => {
      run(['policy-mode: digest']);
      expect(logs).toContain('mode: digest, source: frontmatter');

      run([], { mode: 'digest' });
      expect(logs).toContain('mode: digest, source: flag');

      run([]);
      expect(logs).toContain('mode: full, source: default');
    });

    it('logs the frontmatter-fallback source when digest is ignored for lack of Bash', () => {
      run(['tools: Read', 'policy-mode: digest']);

      expect(logs).toContain('mode: full, source: frontmatter-fallback');
    });
  });
});

describe('buildPolicyDigest', () => {
  const DIGEST_POLICY = `## {§D.1} [IMPORTANT] Core
Core rule applies always. Second sentence stays out.

### {§D.1.1} Child
Child body here.

## {§D.2} Plain
See §D.3 for more. Extra words.

### {§D.2.1} [IMPORTANT] Hidden gem
Gem text is vital.

## {§D.3} Third
Third body.
{§END}
`;

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-digest-'));
    fs.writeFileSync(path.join(tmpDir, 'policy-d.md'), DIGEST_POLICY);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function digestFor(refs: string[], options: Partial<DigestOptions> = {}) {
    const index = buildSectionIndex({
      files: [path.join(tmpDir, 'policy-d.md')],
      baseDir: tmpDir,
    });
    const inventory = resolvePolicyInventory(refs, index, tmpDir);
    const tagged = findTaggedSections(
      inventory.map((section) => section.id),
      index
    );
    const digest = buildPolicyDigest(inventory, tagged, {
      ...DEFAULT_DIGEST_OPTIONS,
      ...options,
    });
    return { inventory, digest };
  }

  /** Digest lines are the text before the first blank line */
  function digestLines(text: string): string[] {
    return text.split('\n\n')[0].split('\n');
  }

  it('emits a tagged nested section with deeper children once in the full block', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'policy-d.md'),
      [
        '## {§D.1} Plain',
        'Plain intro.',
        '',
        '### {§D.1.1} [IMPORTANT] Tagged',
        'Tagged body.',
        '',
        '#### {§D.1.1.1} Grandchild',
        'Grandchild body.',
        '{§END}',
        '',
      ].join('\n')
    );

    const { digest } = digestFor(['§D.1']);

    const fullBlock = digest.text.split('\n\n').slice(1).join('\n\n');
    expect(fullBlock.split('Grandchild body.')).toHaveLength(2);
    expect(digest.full).toBe(1);
    expect(digestLines(digest.text).map((line) => line.split(/[ :]/)[0])).toEqual([
      '§D.1',
      '§D.1.1',
      '§D.1.1.1',
    ]);
  });

  it('detects important sections in CRLF policy files', () => {
    fs.writeFileSync(path.join(tmpDir, 'policy-d.md'), DIGEST_POLICY.replace(/\n/g, '\r\n'));

    const { digest } = digestFor(['§D.1']);

    expect(digestLines(digest.text)[0]).toContain('(full text below)');
    expect(digest.full).toBe(1);
  });

  it('lists every inventory id including a transitively referenced section', () => {
    const { inventory, digest } = digestFor(['§D.2']);
    const lineIds = digestLines(digest.text).map((line) => line.split(/[ :]/)[0]);

    expect(inventory.map((s) => s.id)).toContain('§D.3');
    for (const section of inventory) {
      expect(lineIds).toContain(section.id);
    }
    expect(digest.summarized).toBe(digestLines(digest.text).length);
  });

  it('puts the full text of a child referenced alone under a tagged parent in the full block', () => {
    const { digest } = digestFor(['§D.1.1']);

    const fullBlock = digest.text.split('\n\n').slice(1).join('\n\n');
    expect(fullBlock).toContain('### {§D.1.1} Child\nChild body here.');
    expect(digestLines(digest.text)[0]).toBe('§D.1.1 Child: Child body here. (full text below)');
  });

  it('puts the full text of a tagged nested child in an untagged entry in the full block', () => {
    const { digest } = digestFor(['§D.2']);

    const [digestBlock] = digest.text.split('\n\n');
    const fullBlock = digest.text.slice(digestBlock.length + 2);
    expect(fullBlock.startsWith('### {§D.2.1} [IMPORTANT] Hidden gem\nGem text is vital.\n')).toBe(
      true
    );
    expect(fullBlock).not.toContain('Extra words');
    expect(digest.full).toBe(1);
    expect(digestBlock).toContain('§D.2.1 Hidden gem: Gem text is vital. (full text below)');
    expect(digestBlock).toContain('§D.2 Plain: See §D.3 for more.');
    expect(digestBlock).not.toContain('§D.2 Plain: See §D.3 for more. (full text');
  });

  it('places the digest block before the full block and marks important lines', () => {
    const { digest } = digestFor(['§D.1']);

    const lines = digestLines(digest.text);
    expect(lines[0]).toBe('§D.1 Core: Core rule applies always. (full text below)');
    expect(lines[1]).toBe('§D.1.1 Child: Child body here. (full text below)');
    expect(digest.text.indexOf('§D.1 Core')).toBeLessThan(digest.text.indexOf('## {§D.1}'));
    expect(digest.full).toBe(1);
  });

  it('renders titles only in minimal mode, keeping every id', () => {
    const { inventory, digest } = digestFor(['§D.2'], { minimal: true });

    const lines = digestLines(digest.text);
    for (const section of inventory) {
      expect(lines.some((line) => line.startsWith(section.id))).toBe(true);
    }
    expect(lines).toContain('§D.3 Third');
    expect(digest.text).not.toContain('Third body');
    expect(digestLines(digest.text)).toContain('§D.2.1 Hidden gem (full text below)');
  });

  it('keeps sentences when minimal is off, however long the digest', () => {
    const { digest } = digestFor(['§D.2']);

    expect(digest.text).toContain('Third body');
  });

  it('respects lineChars without cutting the id', () => {
    const { digest } = digestFor(['§D.3'], { lineChars: 12 });

    const [line] = digestLines(digest.text);
    expect(line.startsWith('§D.3 ')).toBe(true);
    expect(line.length).toBe(12);
  });

  it('never shows the tag in a digest line', () => {
    const { digest } = digestFor(['§D.1', '§D.2']);

    for (const line of digestLines(digest.text)) {
      expect(line).not.toContain('[IMPORTANT]');
    }
  });

  it('replaces the default statement with fetchInstructions', () => {
    const { digest } = digestFor(['§D.3'], {
      fetchInstructions: 'Ask the host.',
      configValue: 'c',
    });

    expect(digest.text.endsWith('\n\nAsk the host.')).toBe(true);
    expect(digest.text).not.toContain('policy-cli');
  });

  it('writes the default statement with the quoted config value', () => {
    const { digest } = digestFor(['§D.3'], { configValue: "/a b/it's.json" });

    expect(digest.text).toContain(
      "policy-cli fetch-policies --config '/a b/it'\\''s.json' §ID ..."
    );
  });

  it('throws when a file holding a requested id cannot be read', () => {
    const index = buildSectionIndex({
      files: [path.join(tmpDir, 'policy-d.md')],
      baseDir: tmpDir,
    });
    fs.rmSync(path.join(tmpDir, 'policy-d.md'));

    expect(() => findTaggedSections(['§D.3' as SectionNotation], index)).toThrow('Failed to read');
  });

  it('finds tagged ids through the file of an ancestor and ignores unrelated files', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'policy-e.md'),
      '## {§E.1} [IMPORTANT] Other\nBody.\n{§END}\n'
    );
    const index = buildSectionIndex({
      files: [path.join(tmpDir, 'policy-d.md'), path.join(tmpDir, 'policy-e.md')],
      baseDir: tmpDir,
    });

    const tagged = findTaggedSections(['§D.1.1' as SectionNotation], index);
    expect([...tagged].sort()).toEqual(['§D.1', '§D.2.1']);
    expect(findTaggedSections([], index).size).toBe(0);
  });

  it('honours options.depth for untagged nested headings', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'policy-g.md'),
      '## {§G.1} Top\nTop body.\n\n### {§G.1.1} Mid\nMid body.\n\n### {§G.1.2} Other\nOther body.\n{§END}\n'
    );
    const index = buildSectionIndex({
      files: [path.join(tmpDir, 'policy-g.md')],
      baseDir: tmpDir,
    });
    const inventory = resolvePolicyInventory(['§G.1'], index, tmpDir);
    const at = (depth: number) =>
      digestLines(
        buildPolicyDigest(inventory, new Set(), {
          ...DEFAULT_DIGEST_OPTIONS,
          depth,
        }).text
      );

    expect(at(1)).toEqual(['§G.1 Top: Top body.']);
    expect(at(2)).toEqual([
      '§G.1 Top: Top body.',
      '§G.1.1 Mid: Mid body.',
      '§G.1.2 Other: Other body.',
    ]);
  });

  it('lists a tagged nested heading deeper than depth so the full block is never unlisted', () => {
    const { digest } = digestFor(['§D.2'], { depth: 1 });

    const [digestBlock] = digest.text.split('\n\n');
    expect(digestBlock).toContain('§D.2.1 Hidden gem: Gem text is vital. (full text below)');
    expect(digest.text).toContain('### {§D.2.1} [IMPORTANT] Hidden gem\nGem text is vital.');
  });

  it('honours options.depth inside a tagged entry', () => {
    const { digest } = digestFor(['§D.1'], { depth: 1 });

    const [digestBlock] = digest.text.split('\n\n');
    expect(digestLines(digestBlock)).toEqual([
      '§D.1 Core: Core rule applies always. (full text below)',
    ]);
    expect(digest.text).toContain('### {§D.1.1} Child\nChild body here.');
  });

  it('falls back to slicing a deep nested important heading the extractor cannot find', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'policy-h.md'),
      '## {§H.1} Top\nTop body.\n\n#### {§H.1.1} [IMPORTANT] Deep\nDeep body.\n{§END}\n'
    );
    const index = buildSectionIndex({
      files: [path.join(tmpDir, 'policy-h.md')],
      baseDir: tmpDir,
    });
    const inventory = resolvePolicyInventory(['§H.1'], index, tmpDir);
    const digest = buildPolicyDigest(
      inventory,
      new Set(['§H.1.1' as SectionNotation]),
      DEFAULT_DIGEST_OPTIONS
    );

    expect(digest.text).not.toContain('\n\n\n');
    expect(digest.full).toBe(1);
    expect(digest.text).toContain('#### {§H.1.1} [IMPORTANT] Deep\nDeep body.');
    expect(digest.text).toContain('§H.1.1 Deep: Deep body. (full text below)');
  });

  it('keeps the body of a deeper child inside a tagged #### heading exactly once', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'policy-h.md'),
      [
        '## {§H.1} Top',
        'Top body.',
        '',
        '#### {§H.1.1.1} [IMPORTANT] Deep',
        'Deep body.',
        '',
        '##### {§H.1.1.1.1} Deeper',
        'Deeper body.',
        '',
        '{§END}',
        '',
      ].join('\n')
    );
    const index = buildSectionIndex({
      files: [path.join(tmpDir, 'policy-h.md')],
      baseDir: tmpDir,
    });
    const inventory = resolvePolicyInventory(['§H.1'], index, tmpDir);
    const digest = buildPolicyDigest(
      inventory,
      new Set(['§H.1.1.1' as SectionNotation]),
      DEFAULT_DIGEST_OPTIONS
    );

    expect(digest.text.split('##### {§H.1.1.1.1} Deeper\nDeeper body.')).toHaveLength(2);
    expect(digest.text.split('#### {§H.1.1.1} [IMPORTANT] Deep\nDeep body.')).toHaveLength(2);
  });

  it('follows the line-format and first-sentence rules', () => {
    const body = [
      '## {§F.1} Multi',
      'First line of para',
      'continues here. Second sentence.',
      '',
      'Other paragraph.',
      '',
      '## {§F.2} Empty',
      '',
      '## {§F.3}',
      'Untitled sentence! More.',
      '',
      '## {§F.4} Skips',
      '### Plain heading',
      '---',
      '| a | b |',
      '```',
      'Fenced text.',
      '```',
      '> - quoted item ends? Yes',
      '',
      '## {§F.5} Stops',
      'Until next heading',
      '## {§F.6} Next',
      '* Bullet.',
      '{§END}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'policy-f.md'), body);
    const index = buildSectionIndex({
      files: [path.join(tmpDir, 'policy-f.md')],
      baseDir: tmpDir,
    });
    const inventory = resolvePolicyInventory(
      ['§F.1', '§F.2', '§F.3', '§F.4', '§F.5', '§F.6'],
      index,
      tmpDir
    );
    const lines = digestLines(buildPolicyDigest(inventory, new Set(), DEFAULT_DIGEST_OPTIONS).text);

    expect(lines).toEqual([
      '§F.1 Multi: First line of para continues here.',
      '§F.2 Empty',
      '§F.3: Untitled sentence!',
      '§F.4 Skips: quoted item ends?',
      '§F.5 Stops: Until next heading',
      '§F.6 Next: Bullet.',
    ]);
  });

  it('returns empty text for an empty inventory', () => {
    const tagged = new Set<SectionNotation>();
    expect(buildPolicyDigest([], tagged, DEFAULT_DIGEST_OPTIONS).text).toBe('');
  });
});
