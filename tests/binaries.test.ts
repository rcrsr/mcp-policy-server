/**
 * Smoke tests for the built binaries (dist/cli.js, dist/hook.js, dist/index.js)
 *
 * These run the compiled entry points as subprocesses. They are skipped when
 * dist/ has not been built; `npm run build` first to include them.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'sample-policies');
const META_GLOB = path.join(FIXTURES_DIR, 'policy-meta.md').split(path.sep).join('/');

function run(
  script: string,
  args: string[],
  options: { input?: string; env?: Record<string, string>; cwd?: string } = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(DIST, script), ...args], {
    input: options.input,
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, MCP_POLICY_CONFIG: '', ...options.env },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!fs.existsSync(path.join(DIST, 'cli.js')))('built binaries', () => {
  describe('policy-cli', () => {
    it('prints usage with exit 1 when called without arguments', () => {
      const { status, stdout, stderr } = run('cli.js', []);
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('Usage: policy-cli <subcommand>');
    });

    it('prints help with exit 0', () => {
      expect(run('cli.js', ['--help']).status).toBe(0);
      expect(run('cli.js', ['check', '-h']).stderr).toContain('Usage: policy-cli check');
    });

    it('runs a subcommand and writes JSON to stdout', () => {
      const { status, stdout } = run('cli.js', ['validate-references', '§META.1', '-c', META_GLOB]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ valid: true, checked: 1 });
    });

    it('propagates failure exit codes', () => {
      const { status, stderr } = run('cli.js', [
        'list-sources',
        '-c',
        '/nonexistent/policies.json',
      ]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/^Error: Policy configuration file not found/);
    });
  });

  describe('policy-hook', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-bin-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('prints help with exit 0', () => {
      const { status, stderr } = run('hook.js', ['--help']);
      expect(status).toBe(0);
      expect(stderr).toContain('Usage: policy-hook [options]');
    });

    it('rejects unknown options and missing option values', () => {
      expect(run('hook.js', ['--bogus']).status).toBe(1);
      expect(run('hook.js', ['--config']).stderr).toContain('--config requires a path argument');
    });

    it('allows on non-JSON stdin with a plain allow response', () => {
      const { status, stdout } = run('hook.js', ['--hook', 'positional'], { input: 'nope' });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ permissionDecision: 'allow' });
    });

    it('injects policies and writes a debug log file', () => {
      const agentsDir = path.join(tmpDir, 'agents');
      fs.mkdirSync(agentsDir);
      fs.writeFileSync(path.join(agentsDir, 'bot.md'), 'Follow §META.1');
      const debugFile = path.join(tmpDir, 'debug.log');
      const input = JSON.stringify({ tool_input: { subagent_type: 'bot', prompt: 'Hi' } });

      const { status, stdout } = run(
        'hook.js',
        ['-c', META_GLOB, '-a', 'agents', '-d', debugFile],
        { input, env: { CLAUDE_PROJECT_DIR: tmpDir } }
      );

      expect(status).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(output.hookSpecificOutput.updatedInput.prompt).toContain('## {§META.1}');

      const log = fs.readFileSync(debugFile, 'utf8');
      expect(log).toContain('[policy-hook] === policy-hook debug output ===');
      expect(log).toContain('SUCCESS: injecting policies into prompt');
    });
  });

  describe('mcp-policy-server', () => {
    it('exits 1 with a fatal error when configuration cannot be loaded', () => {
      const { status, stderr } = run('index.js', [], {
        env: { MCP_POLICY_CONFIG: '/nonexistent/policies.json' },
      });
      expect(status).toBe(1);
      expect(stderr).toContain('Fatal error during startup');
    });

    it('answers an MCP initialize request over stdio', async () => {
      const initialize = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '0.0.0' },
        },
      });

      const child = spawn(process.execPath, [path.join(DIST, 'index.js')], {
        cwd: ROOT,
        env: { ...process.env, MCP_POLICY_CONFIG: META_GLOB },
      });

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => (stderr += chunk));

      // The server stays alive on file watchers, so read one line then kill it
      const firstLine = new Promise<string>((resolve, reject) => {
        let buffered = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffered += chunk;
          const newline = buffered.indexOf('\n');
          if (newline !== -1) resolve(buffered.slice(0, newline));
        });
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`exited early with ${code}: ${stderr}`)));
      });

      child.stdin.write(initialize + '\n');
      try {
        const response = JSON.parse(await firstLine);
        expect(response.id).toBe(1);
        expect(response.result.serverInfo.name).toBe('policy-server');
        expect(response.result.capabilities).toMatchObject({ tools: {}, prompts: {} });
        expect(stderr).toContain('running on stdio');
      } finally {
        child.kill();
      }
    });
  });
});
