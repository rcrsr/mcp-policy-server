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
  denyResponse,
  discoverPolicyConfig,
  fetchPoliciesForAgent,
  findAgentFile,
  HookEnvironment,
  pluginNamespace,
  resolveAgentsDirs,
  runHook,
} from '../src/hook-runner.js';
import { buildSectionIndex } from '../src/indexer.js';

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
  return JSON.stringify({ tool_input: { subagent_type: subagentType, prompt, ...extra } });
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
    it('wraps policies in a policies block after a blank line', () => {
      expect(buildInjectedPrompt('Prompt', 'POLICY')).toBe(
        'Prompt\n\n<policies>\n\nPOLICY\n\n</policies>'
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
      expect(runHook(JSON.stringify({ tool_input: { subagent_type: 'a' } }), { env })).toEqual(
        ALLOW_RESPONSE
      );
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

      const output = runHook(hookInput('bot', 'Original', { model: 'x' }), { env, log });
      expect('hookSpecificOutput' in output).toBe(true);
      if (
        'hookSpecificOutput' in output &&
        output.hookSpecificOutput.permissionDecision === 'allow'
      ) {
        const { updatedInput } = output.hookSpecificOutput;
        expect(updatedInput.model).toBe('x');
        expect(updatedInput.subagent_type).toBe('bot');
        expect(updatedInput.prompt.startsWith('Original\n\n<policies>\n\n## {§A.2}')).toBe(true);
        expect(updatedInput.prompt.endsWith('\n\n</policies>')).toBe(true);
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

      const output = runHook(hookInput('ns:worker'), { env: { ...env, pluginRoot } });
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
});
