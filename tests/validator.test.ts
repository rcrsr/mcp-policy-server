/**
 * Comprehensive tests for validator.ts
 * Tests index-based validation with duplicate detection
 */

import * as path from 'path';
import { validateFromIndex, formatDuplicateErrors } from '../src/validator';
import { buildSectionIndex } from '../src/indexer';
import { ServerConfig } from '../src/config';

// Fixture directory paths (absolute)
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');
const META_POLICY = path.join(FIXTURES_DIR, 'policy-meta.md');
const APP_POLICY = path.join(FIXTURES_DIR, 'policy-app.md');
const HOOKS_POLICY = path.join(FIXTURES_DIR, 'policy-app-hooks.md');
const EMPTY_POLICY = path.join(FIXTURES_DIR, 'policy-empty.md');
const DUPLICATE1_POLICY = path.join(FIXTURES_DIR, 'policy-duplicate1.md');
const DUPLICATE2_POLICY = path.join(FIXTURES_DIR, 'policy-duplicate2.md');
const SUBSECTIONS_POLICY = path.join(FIXTURES_DIR, 'policy-subsections.md');
const HYPHENATED_POLICY = path.join(FIXTURES_DIR, 'policy-hyphenated.md');

describe('validator', () => {
  describe('validateFromIndex', () => {
    // Mock console.error to avoid cluttering test output
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return valid result when no duplicates exist', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [META_POLICY, APP_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should detect duplicate sections across multiple files', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [DUPLICATE1_POLICY, DUPLICATE2_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(2);

      // Check for §DUP.1 duplicate
      const dup1Error = result.errors?.find((e) => e.section === '§DUP.1');
      expect(dup1Error).toBeDefined();
      expect(dup1Error?.files).toContain(DUPLICATE1_POLICY);
      expect(dup1Error?.files).toContain(DUPLICATE2_POLICY);
      expect(dup1Error?.files).toHaveLength(2);

      // Check for §DUP.3 duplicate
      const dup3Error = result.errors?.find((e) => e.section === '§DUP.3');
      expect(dup3Error).toBeDefined();
      expect(dup3Error?.files).toContain(DUPLICATE1_POLICY);
      expect(dup3Error?.files).toContain(DUPLICATE2_POLICY);
      expect(dup3Error?.files).toHaveLength(2);
    });

    it('should handle files with no duplicates mixed with duplicate files', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [META_POLICY, DUPLICATE1_POLICY, DUPLICATE2_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(2);

      // Only DUP sections should be flagged
      result.errors?.forEach((error) => {
        expect(error.section).toMatch(/^§DUP\./);
      });
    });

    it('should return valid for empty policy files', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [EMPTY_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should handle hyphenated prefix sections correctly', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [HOOKS_POLICY, HYPHENATED_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should handle mix of unique and duplicate sections in same files', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [DUPLICATE1_POLICY, DUPLICATE2_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      // §DUP.2 is unique to duplicate1, §DUP.4 is unique to duplicate2
      // Only §DUP.1 and §DUP.3 should be flagged as duplicates
      expect(result.errors).toHaveLength(2);

      const sections = result.errors?.map((e) => e.section);
      expect(sections).toContain('§DUP.1');
      expect(sections).toContain('§DUP.3');
      expect(sections).not.toContain('§DUP.2');
      expect(sections).not.toContain('§DUP.4');
    });

    it('should validate subsections independently', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [SUBSECTIONS_POLICY, APP_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      // No duplicates between these files
      expect(result.valid).toBe(true);
    });

    it('should return empty errors array when all sections are unique', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [META_POLICY, APP_POLICY, SUBSECTIONS_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should detect duplicates from index.duplicates Map', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [DUPLICATE1_POLICY, DUPLICATE2_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);

      // Verify index has duplicates Map populated
      expect(index.duplicates.size).toBeGreaterThan(0);
      expect(index.duplicates.has('§DUP.1')).toBe(true);
      expect(index.duplicates.has('§DUP.3')).toBe(true);

      // Verify validateFromIndex returns those duplicates
      const result = validateFromIndex(index);
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBe(index.duplicates.size);
    });

    it('should handle single file with no duplicates', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [META_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      expect(result.valid).toBe(true);
      expect(index.duplicates.size).toBe(0);
    });

    it('should exclude duplicates from index.sectionMap', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [DUPLICATE1_POLICY, DUPLICATE2_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);

      // Duplicates should be in duplicates Map
      expect(index.duplicates.has('§DUP.1')).toBe(true);
      expect(index.duplicates.has('§DUP.3')).toBe(true);

      // But NOT in sectionMap
      expect(index.sectionMap.has('§DUP.1')).toBe(false);
      expect(index.sectionMap.has('§DUP.3')).toBe(false);

      // Unique sections should be in sectionMap
      expect(index.sectionMap.has('§DUP.2')).toBe(true);
      expect(index.sectionMap.has('§DUP.4')).toBe(true);
    });
  });

  describe('formatDuplicateErrors', () => {
    it('should format single duplicate error correctly', () => {
      const errors = [
        { section: '§APP.7', files: ['/path/policy-application.md', '/path/policy-app-extra.md'] },
      ];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toContain('Duplicate section IDs detected:');
      expect(formatted).toContain(
        '§APP.7 appears in: /path/policy-application.md, /path/policy-app-extra.md'
      );
      expect(formatted.split('\n')).toHaveLength(2);
    });

    it('should format multiple duplicate errors correctly', () => {
      const errors = [
        { section: '§APP.7', files: ['/path/policy-application.md', '/path/policy-app-extra.md'] },
        { section: '§META.1', files: ['/path/policy-meta.md', '/path/policy-meta-override.md'] },
      ];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toContain('Duplicate section IDs detected:');
      expect(formatted).toContain(
        '§APP.7 appears in: /path/policy-application.md, /path/policy-app-extra.md'
      );
      expect(formatted).toContain(
        '§META.1 appears in: /path/policy-meta.md, /path/policy-meta-override.md'
      );
      expect(formatted.split('\n')).toHaveLength(3);
    });

    it('should format three-way duplicate correctly', () => {
      const errors = [
        {
          section: '§DUP.1',
          files: [
            '/path/policy-duplicate1.md',
            '/path/policy-duplicate2.md',
            '/path/policy-duplicate3.md',
          ],
        },
      ];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toContain(
        '§DUP.1 appears in: /path/policy-duplicate1.md, /path/policy-duplicate2.md, /path/policy-duplicate3.md'
      );
      expect(formatted.split('\n')).toHaveLength(2);
    });

    it('should handle empty errors array', () => {
      const errors: Array<{ section: string; files: string[] }> = [];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toBe('Duplicate section IDs detected:');
      expect(formatted.split('\n')).toHaveLength(1);
    });

    it('should format errors with hyphenated prefixes', () => {
      const errors = [
        {
          section: '§APP-HOOK.2',
          files: ['/path/policy-app-hooks.md', '/path/policy-app-hooks-override.md'],
        },
        {
          section: '§SYS-TPL.1',
          files: ['/path/policy-sys-template.md', '/path/policy-sys-tpl.md'],
        },
      ];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toContain('§APP-HOOK.2 appears in:');
      expect(formatted).toContain('§SYS-TPL.1 appears in:');
      expect(formatted.split('\n')).toHaveLength(3);
    });

    it('should format subsection duplicates correctly', () => {
      const errors = [
        { section: '§META.2.1', files: ['/path/policy-meta.md', '/path/policy-meta-extended.md'] },
      ];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toContain(
        '§META.2.1 appears in: /path/policy-meta.md, /path/policy-meta-extended.md'
      );
    });

    it('should maintain order of errors as provided', () => {
      const errors = [
        { section: '§APP.7', files: ['/path/file1.md', '/path/file2.md'] },
        { section: '§META.1', files: ['/path/file3.md', '/path/file4.md'] },
        { section: '§SYS.3', files: ['/path/file5.md', '/path/file6.md'] },
      ];

      const formatted = formatDuplicateErrors(errors);
      const lines = formatted.split('\n');

      expect(lines[1]).toContain('§APP.7');
      expect(lines[2]).toContain('§META.1');
      expect(lines[3]).toContain('§SYS.3');
    });

    it('should properly indent error lines', () => {
      const errors = [
        { section: '§APP.7', files: ['/path/policy-application.md', '/path/policy-app-extra.md'] },
      ];

      const formatted = formatDuplicateErrors(errors);
      const lines = formatted.split('\n');

      expect(lines[0]).not.toMatch(/^\s/); // Header not indented
      expect(lines[1]).toMatch(/^\s\s/); // Error line indented with 2 spaces
    });

    it('should handle files array with single file (edge case)', () => {
      // This shouldn't happen in practice, but test defensive handling
      const errors = [{ section: '§APP.7', files: ['/path/policy-application.md'] }];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toContain('§APP.7 appears in: /path/policy-application.md');
    });

    it('should handle long file lists correctly', () => {
      const errors = [
        {
          section: '§TEST.1',
          files: [
            '/path/file1.md',
            '/path/file2.md',
            '/path/file3.md',
            '/path/file4.md',
            '/path/file5.md',
            '/path/file6.md',
            '/path/file7.md',
          ],
        },
      ];

      const formatted = formatDuplicateErrors(errors);

      expect(formatted).toContain(
        '§TEST.1 appears in: /path/file1.md, /path/file2.md, /path/file3.md, /path/file4.md, /path/file5.md, /path/file6.md, /path/file7.md'
      );
      expect(formatted.split('\n')).toHaveLength(2);
    });

    it('should produce output matching expected format exactly', () => {
      const errors = [
        { section: '§APP.7', files: ['/path/policy-application.md', '/path/policy-app-extra.md'] },
      ];

      const formatted = formatDuplicateErrors(errors);

      const expected = `Duplicate section IDs detected:
  §APP.7 appears in: /path/policy-application.md, /path/policy-app-extra.md`;

      expect(formatted).toBe(expected);
    });

    it('should format absolute file paths from index', () => {
      const config: ServerConfig = {
        baseDir: FIXTURES_DIR,
        files: [DUPLICATE1_POLICY, DUPLICATE2_POLICY],
        maxChunkTokens: 10000,
      };

      const index = buildSectionIndex(config);
      const result = validateFromIndex(index);

      const formatted = formatDuplicateErrors(result.errors!);

      // Should contain absolute paths
      expect(formatted).toContain(DUPLICATE1_POLICY);
      expect(formatted).toContain(DUPLICATE2_POLICY);
    });
  });
});
