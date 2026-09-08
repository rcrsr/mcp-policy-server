/**
 * Tests for config.ts
 * Covers the three configuration formats, glob expansion, and file validation
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, validateConfiguration, ServerConfig } from '../src/config.js';
import { ConfigError } from '../src/types.js';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');
const toGlob = (p: string): string => p.split(path.sep).join('/');

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-config-'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadConfig with policies.json', () => {
    it('loads files relative to the manifest directory', () => {
      const manifest = path.join(FIXTURES_DIR, 'policies.json');
      const config = loadConfig(manifest);

      expect(config.baseDir).toBe(FIXTURES_DIR);
      expect(config.maxChunkTokens).toBe(10000);
      expect(config.files.length).toBeGreaterThan(5);
      expect(config.files).toContain(path.join(FIXTURES_DIR, 'policy-app.md'));
      expect(config.files.every((f) => path.isAbsolute(f))).toBe(true);
    });

    it('resolves a relative manifest path against cwd', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(FIXTURES_DIR);
      const config = loadConfig('./policies.json');
      expect(config.baseDir).toBe(FIXTURES_DIR);
    });

    it('defaults to ./policies.json when nothing is provided', () => {
      vi.stubEnv('MCP_POLICY_CONFIG', '');
      vi.spyOn(process, 'cwd').mockReturnValue(FIXTURES_DIR);
      // Empty env var is falsy but defined; ?? only skips undefined, so unset it
      delete process.env.MCP_POLICY_CONFIG;

      const config = loadConfig();
      expect(config.baseDir).toBe(FIXTURES_DIR);
    });

    it('reads MCP_POLICY_CONFIG when no argument is given', () => {
      vi.stubEnv('MCP_POLICY_CONFIG', path.join(FIXTURES_DIR, 'policies.json'));
      const config = loadConfig();
      expect(config.baseDir).toBe(FIXTURES_DIR);
    });

    it('throws ConfigError when the manifest is missing', () => {
      const missing = path.join(tmpDir, 'nope.json');
      expect(() => loadConfig(missing)).toThrow(ConfigError);
      expect(() => loadConfig(missing)).toThrow(/configuration file not found/);
    });

    it('throws ConfigError when the manifest is not valid JSON', () => {
      const manifest = path.join(tmpDir, 'policies.json');
      fs.writeFileSync(manifest, '{ not json');
      expect(() => loadConfig(manifest)).toThrow(/Failed to parse policies manifest/);
    });

    it('deduplicates files matched by overlapping patterns', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.md'), '## {§A.1}\n');
      const manifest = path.join(tmpDir, 'policies.json');
      fs.writeFileSync(manifest, JSON.stringify({ files: ['*.md', 'a.md'] }));

      const config = loadConfig(manifest);
      expect(config.files).toEqual([path.join(tmpDir, 'a.md')]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('duplicate paths'));
    });
  });

  describe('loadConfig with inline JSON', () => {
    it('parses an inline manifest and uses cwd as baseDir', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const inline = JSON.stringify({ files: [toGlob(path.join(FIXTURES_DIR, 'policy-app.md'))] });

      const config = loadConfig(inline);
      expect(config.baseDir).toBe(tmpDir);
      expect(config.files).toEqual([path.join(FIXTURES_DIR, 'policy-app.md')]);
    });

    it('throws ConfigError for malformed inline JSON', () => {
      expect(() => loadConfig('{ files: [ }')).toThrow(/inline JSON/);
    });
  });

  describe('loadConfig with a direct glob', () => {
    it('treats the value as a single pattern', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const config = loadConfig(toGlob(path.join(FIXTURES_DIR, 'policy-meta.md')));
      expect(config.files).toEqual([path.join(FIXTURES_DIR, 'policy-meta.md')]);
      expect(config.baseDir).toBe(tmpDir);
    });

    it('resolves relative globs against cwd', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(FIXTURES_DIR);
      const config = loadConfig('policy-sys.md');
      expect(config.files).toEqual([path.join(FIXTURES_DIR, 'policy-sys.md')]);
    });

    it('warns for zero-match patterns and throws when nothing matches overall', () => {
      expect(() => loadConfig(toGlob(path.join(tmpDir, 'missing-*.md')))).toThrow(
        /No policy files found after glob expansion/
      );
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('matched 0 files'));
    });
  });

  describe('file validation', () => {
    it('rejects files without a .md extension', () => {
      const txt = path.join(tmpDir, 'policy.txt');
      fs.writeFileSync(txt, '## {§A.1}\n');
      expect(() => loadConfig(toGlob(txt))).toThrow(/must have \.md extension/);
    });

    it('rejects a manifest entry that points at a directory', () => {
      const dir = path.join(tmpDir, 'sub.md');
      fs.mkdirSync(dir);
      const manifest = path.join(tmpDir, 'policies.json');
      fs.writeFileSync(manifest, JSON.stringify({ files: ['sub.md', 'sub.md/'] }));
      // fast-glob onlyFiles filters the directory out, leaving nothing
      expect(() => loadConfig(manifest)).toThrow(ConfigError);
    });

    it('rejects a file that is not readable', () => {
      // root bypasses file permissions, so the check cannot be observed there
      if (process.getuid?.() === 0) return;
      const file = path.join(tmpDir, 'locked.md');
      fs.writeFileSync(file, '## {§A.1}\n');
      fs.chmodSync(file, 0o000);
      try {
        expect(() => loadConfig(toGlob(file))).toThrow(/not readable/);
      } finally {
        fs.chmodSync(file, 0o644);
      }
    });
  });

  describe('validateConfiguration', () => {
    const valid: ServerConfig = { files: ['/a/policy.md'], baseDir: '/a', maxChunkTokens: 100 };

    it('accepts a well-formed configuration', () => {
      expect(() => validateConfiguration(valid)).not.toThrow();
      expect(() => validateConfiguration({ files: ['/a/p.md'], baseDir: '/a' })).not.toThrow();
    });

    it('rejects a missing or non-array files field', () => {
      expect(() => validateConfiguration({ ...valid, files: undefined as never })).toThrow(
        /files \(must be array\)/
      );
      expect(() => validateConfiguration({ ...valid, files: 'x' as never })).toThrow(ConfigError);
    });

    it('rejects an empty files array', () => {
      expect(() => validateConfiguration({ ...valid, files: [] })).toThrow(/files array is empty/);
    });

    it('rejects a missing baseDir', () => {
      expect(() => validateConfiguration({ ...valid, baseDir: '' })).toThrow(/baseDir/);
    });

    it('rejects a non-positive maxChunkTokens', () => {
      expect(() => validateConfiguration({ ...valid, maxChunkTokens: 0 })).toThrow(
        /maxChunkTokens must be a positive number/
      );
      expect(() => validateConfiguration({ ...valid, maxChunkTokens: 'x' as never })).toThrow(
        ConfigError
      );
    });
  });
});
