/**
 * Tests for cli-runner.ts
 * Drives every policy-cli subcommand in-process
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs, runCli, SUBCOMMANDS, SUBCOMMAND_USAGE, USAGE } from '../src/cli-runner.js';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');
const AGENT_FILE = path.resolve(__dirname, 'fixtures', 'test-agent.md');
const toGlob = (p: string): string => p.split(path.sep).join('/');

/** Inline JSON config selecting a fixed set of fixture files */
function inlineConfig(names: string[]): string {
  return JSON.stringify({ files: names.map((n) => toGlob(path.join(FIXTURES_DIR, n))) });
}

/** Copy fixture files into a directory and write a policies.json manifest there */
function copyFixtures(dir: string, names: string[]): string {
  for (const name of names) {
    fs.copyFileSync(path.join(FIXTURES_DIR, name), path.join(dir, name));
  }
  const manifest = path.join(dir, 'policies.json');
  fs.writeFileSync(manifest, JSON.stringify({ files: ['./*.md'] }));
  return manifest;
}

const mocks = vi.hoisted(() => ({ skipSection: false }));
vi.mock('../src/indexer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer.js')>();
  return {
    ...actual,
    buildSectionDetails: (...args: Parameters<typeof actual.buildSectionDetails>) => {
      const result = actual.buildSectionDetails(...args);
      if (mocks.skipSection) {
        result.skipped.push({ id: '§X.1', reason: 'Failed to read (simulated)' });
      }
      return result;
    },
  };
});

const CORE_CONFIG = inlineConfig([
  'policy-test.md',
  'policy-meta.md',
  'policy-app.md',
  'policy-sys.md',
]);

describe('cli-runner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-cli-'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mocks.skipSection = false;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseArgs', () => {
    it('requests usage with exit 1 when no arguments are given', () => {
      expect(parseArgs([])).toEqual({ kind: 'help', exitCode: 1 });
    });

    it('requests usage with exit 0 for --help and -h', () => {
      expect(parseArgs(['--help'])).toEqual({ kind: 'help', exitCode: 0 });
      expect(parseArgs(['-h'])).toEqual({ kind: 'help', exitCode: 0 });
      expect(parseArgs(['bogus', '--help'])).toEqual({ kind: 'help', exitCode: 0 });
    });

    it('rejects unknown subcommands and lists the valid ones', () => {
      const parsed = parseArgs(['bogus']);
      expect(parsed.kind).toBe('error');
      if (parsed.kind === 'error') {
        expect(parsed.message).toContain('Unknown subcommand: bogus');
        expect(parsed.message).toContain(SUBCOMMANDS.join(', '));
      }
    });

    it('parses positional args and --config in any order', () => {
      expect(parseArgs(['validate-references', '§A.1', '-c', 'cfg.json', '§A.2'])).toEqual({
        kind: 'run',
        subcommand: 'validate-references',
        args: ['§A.1', '§A.2'],
        configPath: 'cfg.json',
      });
      expect(parseArgs(['list-sources', '--config', 'x'])).toMatchObject({
        kind: 'run',
        subcommand: 'list-sources',
        args: [],
        configPath: 'x',
      });
    });

    it('returns subcommand help when --help follows a subcommand', () => {
      expect(parseArgs(['check', '-h'])).toEqual({
        kind: 'help',
        subcommand: 'check',
        exitCode: 0,
      });
    });

    it('rejects --config without a value', () => {
      expect(parseArgs(['list-sources', '--config'])).toEqual({
        kind: 'error',
        message: '--config requires a path argument',
      });
    });

    it('rejects unknown options', () => {
      expect(parseArgs(['list-sources', '--verbose'])).toEqual({
        kind: 'error',
        message: 'Unknown option: --verbose',
      });
    });
  });

  describe('runCli help and errors', () => {
    it('prints general usage to stderr', () => {
      expect(runCli([])).toEqual({ exitCode: 1, stdout: '', stderr: USAGE });
      expect(runCli(['--help'])).toEqual({ exitCode: 0, stdout: '', stderr: USAGE });
    });

    it('prints subcommand usage to stderr', () => {
      for (const subcommand of SUBCOMMANDS) {
        expect(runCli([subcommand, '--help'])).toEqual({
          exitCode: 0,
          stdout: '',
          stderr: SUBCOMMAND_USAGE[subcommand],
        });
      }
    });

    it('reports parse errors with exit 1', () => {
      const result = runCli(['nope']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Error: Unknown subcommand: nope');
    });

    it('reports config loading failures with exit 1', () => {
      const result = runCli(['list-sources', '--config', path.join(tmpDir, 'missing.json')]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^Error: Policy configuration file not found/);
    });
  });

  describe('fetch-policies', () => {
    it('requires a file argument', () => {
      const result = runCli(['fetch-policies']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('fetch-policies requires a file argument');
      expect(result.stderr).toContain('Usage: policy-cli fetch-policies');
    });

    it('fails for a missing file', () => {
      const result = runCli(['fetch-policies', 'missing.md'], tmpDir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(`Error: File not found: ${path.join(tmpDir, 'missing.md')}`);
    });

    it('exits silently without loading config when the file has no references', () => {
      const file = path.join(tmpDir, 'plain.md');
      fs.writeFileSync(file, 'nothing here');
      const result = runCli(['fetch-policies', 'plain.md', '--config', 'unused.json'], tmpDir);
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    });

    it('fetches referenced sections with recursive resolution', () => {
      const file = path.join(tmpDir, 'agent.md');
      fs.writeFileSync(file, 'Follow §META.1 and §APP.4.1-2.');
      const result = runCli(['fetch-policies', file, '--config', CORE_CONFIG]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('## {§META.1}');
      expect(result.stdout).toContain('### {§APP.4.1}');
      expect(result.stdout).toContain('### {§APP.4.2}');
      // §APP.4.2 references §APP.4.3
      expect(result.stdout).toContain('### {§APP.4.3}');
    });

    it('fails when a reference cannot be resolved', () => {
      const file = path.join(tmpDir, 'agent.md');
      fs.writeFileSync(file, 'Follow §META.42.');
      const result = runCli(['fetch-policies', file, '--config', CORE_CONFIG]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('§META.42');
    });
  });

  describe('validate-references', () => {
    it('requires at least one reference', () => {
      const result = runCli(['validate-references', '--config', CORE_CONFIG]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('requires at least one § reference');
    });

    it('returns valid JSON with exit 0 for existing references', () => {
      const result = runCli(['validate-references', '§META.1', '§SYS', '--config', CORE_CONFIG]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        valid: true,
        checked: 2,
        invalid: [],
        details: [],
      });
    });

    it('returns exit 1 and lists invalid references', () => {
      const result = runCli(['validate-references', '§META.9', '--config', CORE_CONFIG]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.valid).toBe(false);
      expect(parsed.invalid).toEqual(['§META.9']);
    });

    it('reports duplicate sections', () => {
      const dupConfig = inlineConfig(['policy-duplicate1.md', 'policy-duplicate2.md']);
      const result = runCli(['validate-references', '§DUP.1', '--config', dupConfig]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.invalid).toEqual(['§DUP.1']);
      expect(parsed.details[0]).toBe('Global validation errors:');
    });
  });

  describe('extract-references', () => {
    it('requires a file argument', () => {
      const result = runCli(['extract-references']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('extract-references requires a file argument');
    });

    it('fails for a missing file', () => {
      const result = runCli(['extract-references', path.join(tmpDir, 'nope.md')]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('File not found');
    });

    it('lists unique sorted references without needing a config', () => {
      const result = runCli(['extract-references', AGENT_FILE]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        '§APP.4.1',
        '§APP.4.2',
        '§APP.4.3',
        '§APP.7',
        '§META.1',
        '§META.2.1',
        '§SYS.5',
        '§TEST.1',
      ]);
    });

    it('resolves relative paths against the provided cwd', () => {
      const result = runCli(['extract-references', 'test-agent.md'], path.dirname(AGENT_FILE));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toContain('§APP.7');
    });
  });

  describe('list-sources', () => {
    it('prints files, statistics, and prefixes', () => {
      const result = runCli(['list-sources', '--config', CORE_CONFIG]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('# Policy Documentation Files');
      expect(result.stdout).toContain(path.join(FIXTURES_DIR, 'policy-app.md'));
      expect(result.stdout).toContain('- Files indexed: 4');
      expect(result.stdout).toContain('## Available Prefixes');
      expect(result.stdout).toContain('- §APP');
      expect(result.stdout).toContain('- §TEST');
    });
  });

  describe('list-sections', () => {
    it('prints per-section detail JSON', () => {
      const manifest = copyFixtures(tmpDir, ['policy-meta.md']);
      const result = runCli(['list-sections', '--config', manifest]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      const parsed = JSON.parse(result.stdout);
      expect(parsed.skipped).toEqual([]);
      expect(parsed.details.map((d: { id: string }) => d.id)).toEqual([
        '§META.1',
        '§META.2',
        '§META.2.1',
      ]);
      expect(parsed.details[0]).toMatchObject({
        prefix: 'META',
        file: 'policy-meta.md',
        refs: [],
      });
      expect(parsed.details[0].byteLength).toBeGreaterThan(0);
    });

    it('reports skipped sections on stderr with exit 1', () => {
      mocks.skipSection = true;
      const manifest = copyFixtures(tmpDir, ['policy-meta.md']);
      const result = runCli(['list-sections', '--config', manifest]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('Skipped sections: 1\n  - §X.1: Failed to read (simulated)\n');
      expect(JSON.parse(result.stdout).skipped).toEqual([
        { id: '§X.1', reason: 'Failed to read (simulated)' },
      ]);
    });
  });

  describe('resolve-references', () => {
    it('requires at least one reference', () => {
      const result = runCli(['resolve-references']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('requires at least one § reference');
    });

    it('maps references to files including recursive references', () => {
      const manifest = copyFixtures(tmpDir, ['policy-test.md', 'policy-sys.md']);
      const result = runCli(['resolve-references', '§TEST.3', '--config', manifest]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        'policy-sys.md': ['§SYS.5'],
        'policy-test.md': ['§TEST.3'],
      });
    });

    it('expands prefix-only references', () => {
      const manifest = copyFixtures(tmpDir, ['policy-meta.md']);
      const result = runCli(['resolve-references', '§META', '--config', manifest]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)['policy-meta.md']).toEqual(['§META.1', '§META.2']);
    });
  });

  describe('check', () => {
    it('requires a file argument', () => {
      const result = runCli(['check']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('check requires a file argument');
    });

    it('fails for a missing file', () => {
      const result = runCli(['check', 'missing.md'], tmpDir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('File not found');
    });

    it('returns exit 0 for a well-formed file', () => {
      const result = runCli(['check', 'policy-meta.md'], FIXTURES_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('✓ policy-meta.md: OK\n');
    });

    it('returns exit 1 and lists issues for a malformed file', () => {
      const file = path.join(tmpDir, 'bad.md');
      fs.writeFileSync(file, '## {§BAD.2}\ncontent\n```js\nunclosed\n');
      const result = runCli(['check', file]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('[UNCLOSED_FENCE]');
      expect(result.stdout).toContain('[NUMBERING_GAP]');
    });
  });
});
