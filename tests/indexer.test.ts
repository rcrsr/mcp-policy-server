/**
 * Tests for index optimization and error handling
 */
import {
  buildSectionIndex,
  findTaggedSections,
  buildSectionDetails,
  ensureFreshIndex,
  initializeIndexState,
  closeIndexState,
} from '../src/indexer.js';
import { SectionIndex, SectionNotation } from '../src/types.js';
import { ServerConfig } from '../src/config.js';
import { extractSection } from '../src/parser.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Index Optimization', () => {
  const testDir = path.join(__dirname, 'fixtures', 'optimization-test');
  const testFile1 = path.join(testDir, 'test1.md');
  const testFile2 = path.join(testDir, 'test2.md');

  let config: ServerConfig;

  beforeEach(() => {
    // Create test directory and files
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile1, '## {§TEST.1}\nContent 1');
    fs.writeFileSync(testFile2, '## {§TEST.2}\nContent 2');

    config = {
      files: [testFile1, testFile2],
      baseDir: testDir,
      maxChunkTokens: 10000,
    };
  });

  afterEach(() => {
    // Clean up
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Mtime+Size Optimization', () => {
    test('skips parsing for unchanged files', () => {
      const initial = buildSectionIndex(config);
      expect(initial.sectionMap.size).toBe(2);

      // Rebuild without changes
      const rebuild = buildSectionIndex(config, initial);

      // Should have same sections
      expect(rebuild.sectionMap.size).toBe(2);
      expect(rebuild.sectionMap.has('§TEST.1')).toBe(true);
      expect(rebuild.sectionMap.has('§TEST.2')).toBe(true);
    });

    test('detects file changes via mtime', async () => {
      const initial = buildSectionIndex(config);

      // Wait to ensure mtime difference (for low-precision filesystems)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Modify file
      fs.appendFileSync(testFile1, '\n## {§TEST.3}\nNew section');

      // Rebuild should detect change
      const rebuild = buildSectionIndex(config, initial);
      expect(rebuild.sectionMap.has('§TEST.3')).toBe(true);
    });

    test('detects file changes via size even with same mtime', () => {
      const initial = buildSectionIndex(config);

      // Modify file and restore original mtime (simulate mtime collision)
      const fd = fs.openSync(testFile1, 'a');
      try {
        const { atime, mtime } = fs.fstatSync(fd);
        fs.appendFileSync(fd, '\n## {§TEST.3}\nNew section');
        fs.futimesSync(fd, atime, mtime);
      } finally {
        fs.closeSync(fd);
      }

      // Size check should detect change
      const rebuild = buildSectionIndex(config, initial);
      expect(rebuild.sectionMap.has('§TEST.3')).toBe(true);
    });

    test('handles missing cache data gracefully', () => {
      const initial = buildSectionIndex(config);

      // Corrupt cache by clearing fileSections
      const corruptedIndex: SectionIndex = {
        ...initial,
        fileSections: new Map(), // Empty cache
      };

      // Should rebuild missing entries
      const rebuild = buildSectionIndex(config, corruptedIndex);
      expect(rebuild.sectionMap.size).toBe(2);
    });

    test('tracks file sizes correctly', () => {
      const index = buildSectionIndex(config);

      // Verify fileSizes map is populated
      expect(index.fileSizes.size).toBe(2);
      expect(index.fileSizes.has(testFile1)).toBe(true);
      expect(index.fileSizes.has(testFile2)).toBe(true);

      // Verify sizes are positive numbers
      const size1 = index.fileSizes.get(testFile1);
      const size2 = index.fileSizes.get(testFile2);
      expect(size1).toBeGreaterThan(0);
      expect(size2).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    test('handles deleted files gracefully', () => {
      const initial = buildSectionIndex(config);

      // Delete one file
      fs.unlinkSync(testFile1);

      // Rebuild should handle missing file
      expect(() => {
        buildSectionIndex(config, initial);
      }).not.toThrow();
    });

    test('continues indexing after file error', () => {
      const initial = buildSectionIndex(config);

      // Delete one file but keep the other
      fs.unlinkSync(testFile1);

      // Should still index the remaining file
      const rebuild = buildSectionIndex(config, initial);
      expect(rebuild.sectionMap.has('§TEST.2')).toBe(true);
    });

    test('handles unreadable files gracefully on Unix', () => {
      // Skip on Windows (chmod doesn't work the same way)
      if (process.platform === 'win32') {
        return;
      }

      // Make file unreadable
      fs.chmodSync(testFile1, 0o000);

      expect(() => {
        buildSectionIndex(config);
      }).not.toThrow();

      // Restore permissions for cleanup
      fs.chmodSync(testFile1, 0o644);
    });

    test('handles invalid file paths gracefully', () => {
      const badConfig: ServerConfig = {
        files: ['/nonexistent/path/to/file.md'],
        baseDir: testDir,
        maxChunkTokens: 10000,
      };

      expect(() => {
        buildSectionIndex(badConfig);
      }).not.toThrow();
    });
  });

  describe('Debouncing', () => {
    test('handles rapid file changes', async () => {
      const state = initializeIndexState(config);

      try {
        // Trigger multiple rapid changes
        fs.appendFileSync(testFile1, '\nChange 1');
        await new Promise((resolve) => setTimeout(resolve, 50));
        fs.appendFileSync(testFile1, '\nChange 2');
        await new Promise((resolve) => setTimeout(resolve, 50));
        fs.appendFileSync(testFile1, '\nChange 3');

        // Wait for debounce period
        await new Promise((resolve) => setTimeout(resolve, 400));

        // Should be marked stale
        expect(state.stale).toBe(true);

        // Rebuild should work
        const index = ensureFreshIndex(state, config);
        expect(index).toBeDefined();
      } finally {
        closeIndexState(state);
      }
    });

    test('debounce timer is cleared on cleanup', async () => {
      const state = initializeIndexState(config);

      try {
        // Trigger change to start debounce timer
        fs.appendFileSync(testFile1, '\nChange');

        // Close state immediately (should clear timer without error)
        closeIndexState(state);

        // Wait to ensure no errors occur
        await new Promise((resolve) => setTimeout(resolve, 400));
      } catch (error) {
        // Should not reach here
        expect(error).toBeUndefined();
      }
    });
  });

  describe('Memory Management', () => {
    test('fileSections contains only current files', () => {
      const initial = buildSectionIndex(config);
      expect(initial.fileSections.size).toBe(2);

      // Update config to remove one file
      const newConfig: ServerConfig = {
        ...config,
        files: [testFile1],
      };

      const rebuild = buildSectionIndex(newConfig, initial);

      // Should only have sections for current file
      expect(rebuild.fileSections.size).toBe(1);
      expect(rebuild.fileSections.has(testFile1)).toBe(true);
      expect(rebuild.fileSections.has(testFile2)).toBe(false);
    });

    test('fileSizes contains only current files', () => {
      const initial = buildSectionIndex(config);
      expect(initial.fileSizes.size).toBe(2);

      // Update config to remove one file
      const newConfig: ServerConfig = {
        ...config,
        files: [testFile1],
      };

      const rebuild = buildSectionIndex(newConfig, initial);

      // Should only have sizes for current file
      expect(rebuild.fileSizes.size).toBe(1);
      expect(rebuild.fileSizes.has(testFile1)).toBe(true);
      expect(rebuild.fileSizes.has(testFile2)).toBe(false);
    });
  });

  describe('Index State Lifecycle', () => {
    test('initializeIndexState creates watchers', () => {
      const state = initializeIndexState(config);

      try {
        expect(state.watchers.length).toBe(2);
        expect(state.stale).toBe(false);
        expect(state.rebuilding).toBe(false);
        expect(state.index).toBeDefined();
      } finally {
        closeIndexState(state);
      }
    });

    test('closeIndexState cleans up all resources', () => {
      const state = initializeIndexState(config);

      closeIndexState(state);

      expect(state.watchers.length).toBe(0);
    });

    test('ensureFreshIndex rebuilds when stale', () => {
      const state = initializeIndexState(config);

      try {
        // Mark as stale
        state.stale = true;

        // Add new section to file
        fs.appendFileSync(testFile1, '\n## {§TEST.3}\nNew content');

        // Ensure fresh should rebuild
        const index = ensureFreshIndex(state, config);

        expect(state.stale).toBe(false);
        expect(index.sectionMap.has('§TEST.3')).toBe(true);
      } finally {
        closeIndexState(state);
      }
    });

    test('ensureFreshIndex skips rebuild when fresh', () => {
      const state = initializeIndexState(config);

      try {
        const initialIndex = state.index;

        // Ensure fresh when not stale
        const index = ensureFreshIndex(state, config);

        // Should return same index instance (no rebuild)
        expect(index).toBe(initialIndex);
      } finally {
        closeIndexState(state);
      }
    });
  });

  describe('Integration Tests', () => {
    test('full lifecycle with file changes', async () => {
      const state = initializeIndexState(config);

      try {
        // Initial state
        expect(state.index.sectionMap.size).toBe(2);

        // Modify file
        await new Promise((resolve) => setTimeout(resolve, 1100));
        fs.appendFileSync(testFile1, '\n## {§TEST.3}\nNew section');

        // Wait for file watcher to trigger
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Should be marked stale
        expect(state.stale).toBe(true);

        // Ensure fresh should rebuild
        const index = ensureFreshIndex(state, config);

        expect(state.stale).toBe(false);
        expect(index.sectionMap.has('§TEST.3')).toBe(true);
      } finally {
        closeIndexState(state);
      }
    });
  });
});

describe('buildSectionDetails', () => {
  const testDir = path.join(__dirname, 'fixtures', 'section-details-test');
  const testFile = path.join(testDir, 'test.md');

  let config: ServerConfig;

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      testFile,
      [
        '## {§TEST.1}',
        'See §TEST.2 for details, and the range §TEST.5.1-3.',
        '',
        '```',
        'Example referencing §TEST.4 inside a fence, should be excluded.',
        '```',
        '',
        'Also see `§TEST.3` inline code, should be excluded.',
        '',
        '## {§TEST.2}',
        'No references here.',
        '',
        '## {§TEST.3}',
        'Nothing to see.',
      ].join('\n')
    );

    config = {
      files: [testFile],
      baseDir: testDir,
      maxChunkTokens: 10000,
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('returns one record per section with id, prefix, file, byteLength, refs and no skipped entries', () => {
    const index = buildSectionIndex(config);
    const { details, skipped } = buildSectionDetails(index, config.baseDir);

    expect(details.length).toBe(3);
    expect(skipped).toEqual([]);
    for (const detail of details) {
      expect(detail.id).toBeDefined();
      expect(detail.prefix).toBe('TEST');
      expect(detail.file).toBe(path.relative(config.baseDir, testFile));
      expect(detail.byteLength).toBeGreaterThan(0);
      expect(Array.isArray(detail.refs)).toBe(true);
    }
  });

  test('byteLength matches Buffer.byteLength of extracted section content', () => {
    const index = buildSectionIndex(config);
    const { details } = buildSectionDetails(index, config.baseDir);

    const section2 = details.find((d) => d.id === '§TEST.2');
    expect(section2).toBeDefined();
    const expectedContent = extractSection(testFile, 'TEST', '2');
    expect(section2!.byteLength).toBe(Buffer.byteLength(expectedContent, 'utf8'));
  });

  test('excludes § references inside fenced code blocks from refs', () => {
    const index = buildSectionIndex(config);
    const { details } = buildSectionDetails(index, config.baseDir);

    const section1 = details.find((d) => d.id === '§TEST.1');
    expect(section1).toBeDefined();
    // §TEST.4 appears only inside the fenced code block, so its absence
    // from refs proves the fenced occurrence was actually excluded
    // (not merely deduped away with a real occurrence elsewhere).
    expect(section1!.refs).not.toContain('§TEST.4');
  });

  test('excludes § references inside inline code from refs', () => {
    const index = buildSectionIndex(config);
    const { details } = buildSectionDetails(index, config.baseDir);

    const section1 = details.find((d) => d.id === '§TEST.1');
    expect(section1).toBeDefined();
    expect(section1!.refs).not.toContain('§TEST.3');
  });

  test('expands range references into individual section ids', () => {
    const index = buildSectionIndex(config);
    const { details } = buildSectionDetails(index, config.baseDir);

    const section1 = details.find((d) => d.id === '§TEST.1');
    expect(section1).toBeDefined();
    expect(section1!.refs).not.toContain('§TEST.5.1-3');
    expect(section1!.refs).toEqual(expect.arrayContaining(['§TEST.5.1', '§TEST.5.2', '§TEST.5.3']));
  });

  test('excludes a section id from its own refs', () => {
    fs.writeFileSync(
      testFile,
      [
        '## {§TEST.1}',
        'This section references itself via §TEST.1 and also §TEST.2.',
        '',
        '## {§TEST.2}',
        'Nothing here.',
      ].join('\n')
    );

    const index = buildSectionIndex(config);
    const { details } = buildSectionDetails(index, config.baseDir);

    const section1 = details.find((d) => d.id === '§TEST.1');
    expect(section1).toBeDefined();
    expect(section1!.refs).not.toContain('§TEST.1');
    expect(section1!.refs).toContain('§TEST.2');
  });

  test('results are sorted by id', () => {
    const index = buildSectionIndex(config);
    const { details } = buildSectionDetails(index, config.baseDir);

    const ids = details.map((d) => d.id);
    const sortedIds = [...ids].sort();
    expect(ids).toEqual(sortedIds);
  });

  test('reports skipped sections with a reason instead of throwing', () => {
    fs.writeFileSync(
      testFile,
      ['## {§TEST.1}', 'Some content.', '', '## {§TEST.2}', 'More content.'].join('\n')
    );

    const index = buildSectionIndex(config);
    // Simulate an id that fails SECTION_ID_SPLIT_PATTERN by injecting a
    // malformed entry directly into the section map.
    index.sectionMap.set('§' as SectionNotation, testFile);

    const { details, skipped } = buildSectionDetails(index, config.baseDir);

    expect(details.length).toBe(2);
    expect(skipped.length).toBe(1);
    expect(skipped[0].id).toBe('§');
    expect(skipped[0].reason).toMatch(/does not match expected/);
  });
});

describe('buildSectionDetails error handling', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('skips sections whose id cannot be parsed or whose file cannot be read', () => {
    const missingFile = path.join(__dirname, 'fixtures', 'does-not-exist.md');
    const index: SectionIndex = {
      sectionMap: new Map([
        ['§WEIRD', missingFile],
        ['§GONE.1', missingFile],
        ['§GONE.2', missingFile],
      ]),
      duplicates: new Map(),
      fileMtimes: new Map(),
      fileSizes: new Map(),
      fileSections: new Map(),
      lastIndexed: new Date(),
      fileCount: 1,
      sectionCount: 3,
    };

    const { details, skipped } = buildSectionDetails(index, __dirname);
    expect(details).toEqual([]);
    expect(skipped.map((s) => s.id)).toEqual(['§WEIRD', '§GONE.1', '§GONE.2']);
    expect(skipped[0].reason).toContain('does not match expected §PREFIX.NUMBER format');
    expect(skipped[1].reason).toMatch(/^Failed to read /);
    expect(skipped[2].reason).toBe(skipped[1].reason);
  });
});

describe('buildSectionDetails important flag', () => {
  const testDir = path.join(__dirname, 'fixtures', 'section-important-test');
  const testFile = path.join(testDir, 'important.md');

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function detailsFor(lines: string[]): Map<string, { important: boolean; proforma: boolean }> {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile, lines.join('\n'));
    const index = buildSectionIndex({ files: [testFile], baseDir: testDir, maxChunkTokens: 10000 });
    const { details } = buildSectionDetails(index, testDir);
    return new Map(details.map((d) => [d.id, { important: d.important, proforma: d.proforma }]));
  }

  test('tagged parent marks the parent and every child important; untagged sibling is not', () => {
    const flags = detailsFor([
      '## {§IMP.1} [IMPORTANT] Tagged',
      'Body.',
      '### {§IMP.1.1} Child',
      'Child body.',
      '### {§IMP.1.2} Other child',
      'Other body.',
      '## {§IMP.2} Untagged',
      'Body.',
    ]);

    expect(flags.get('§IMP.1')?.important).toBe(true);
    expect(flags.get('§IMP.1.1')?.important).toBe(true);
    expect(flags.get('§IMP.1.2')?.important).toBe(true);
    expect(flags.get('§IMP.2')?.important).toBe(false);
  });

  test('tagged child under an untagged parent is important only for that child', () => {
    const flags = detailsFor([
      '## {§IMP.1} Untagged parent',
      'Body.',
      '### {§IMP.1.1} [IMPORTANT] Tagged child',
      'Child body.',
      '### {§IMP.1.2} Untagged sibling',
      'Sibling body.',
    ]);

    expect(flags.get('§IMP.1')?.important).toBe(false);
    expect(flags.get('§IMP.1.1')?.important).toBe(true);
    expect(flags.get('§IMP.1.2')?.important).toBe(false);
  });

  test('tagged parent marks deeper descendants important', () => {
    const flags = detailsFor([
      '## {§IMP.1} [IMPORTANT] Tagged',
      'Body.',
      '### {§IMP.1.1} Child',
      'Child body.',
      '### {§IMP.1.1.1} Grandchild',
      'Grandchild body.',
    ]);

    expect(flags.get('§IMP.1.1.1')?.important).toBe(true);
  });

  test('tagged middle section marks its grandchild important but not its untagged ancestor or sibling', () => {
    const flags = detailsFor([
      '## {§IMP.1} Untagged root',
      'Body.',
      '### {§IMP.1.1} [IMPORTANT] Tagged middle',
      'Middle body.',
      '### {§IMP.1.1.1} Grandchild',
      'Grandchild body.',
      '### {§IMP.1.2} Untagged sibling',
      'Sibling body.',
    ]);

    expect(flags.get('§IMP.1.1.1')?.important).toBe(true);
    expect(flags.get('§IMP.1')?.important).toBe(false);
    expect(flags.get('§IMP.1.2')?.important).toBe(false);
  });

  test('proforma parent marks itself and every descendant proforma and not important', () => {
    const flags = detailsFor([
      '## {§IMP.1} [PROFORMA] Proforma',
      'Body.',
      '### {§IMP.1.1} Child',
      'Child body.',
      '### {§IMP.1.1.1} Grandchild',
      'Grandchild body.',
      '## {§IMP.2} Untagged',
      'Body.',
    ]);

    for (const id of ['§IMP.1', '§IMP.1.1', '§IMP.1.1.1']) {
      expect(flags.get(id)).toEqual({ important: false, proforma: true });
    }
    expect(flags.get('§IMP.2')).toEqual({ important: false, proforma: false });
  });

  test('proforma child under an important parent is proforma only; siblings stay important', () => {
    const flags = detailsFor([
      '## {§IMP.1} [IMPORTANT] Important parent',
      'Body.',
      '### {§IMP.1.1} [PROFORMA] Proforma child',
      'Child body.',
      '### {§IMP.1.2} Sibling',
      'Sibling body.',
    ]);

    expect(flags.get('§IMP.1')).toEqual({ important: true, proforma: false });
    expect(flags.get('§IMP.1.1')).toEqual({ important: false, proforma: true });
    expect(flags.get('§IMP.1.2')).toEqual({ important: true, proforma: false });
  });

  test('important child under a proforma parent is not important', () => {
    const flags = detailsFor([
      '## {§IMP.1} [PROFORMA] Proforma parent',
      'Body.',
      '### {§IMP.1.1} [IMPORTANT] Important child',
      'Child body.',
    ]);

    expect(flags.get('§IMP.1.1')).toEqual({ important: false, proforma: true });
  });

  test('file mixing both tags keeps each tag set holding only its own ids', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      testFile,
      [
        '## {§IMP.1} [IMPORTANT] Important',
        'Body.',
        '## {§IMP.2} [PROFORMA] Proforma',
        'Body.',
        '## {§IMP.3} Untagged',
        'Body.',
      ].join('\n')
    );
    const index = buildSectionIndex({ files: [testFile], baseDir: testDir, maxChunkTokens: 10000 });

    const tagged = findTaggedSections(['§IMP.1', '§IMP.2', '§IMP.3'], index);

    expect(Array.from(tagged.important)).toEqual(['§IMP.1']);
    expect(Array.from(tagged.proforma)).toEqual(['§IMP.2']);
  });
});
