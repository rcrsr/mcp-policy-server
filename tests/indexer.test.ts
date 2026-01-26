/**
 * Tests for index optimization and error handling
 */
import {
  buildSectionIndex,
  ensureFreshIndex,
  initializeIndexState,
  closeIndexState,
} from '../src/indexer.js';
import { SectionIndex } from '../src/types.js';
import { ServerConfig } from '../src/config.js';
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
      const originalMtime = fs.statSync(testFile1).mtime;

      // Modify file and restore original mtime (simulate mtime collision)
      fs.appendFileSync(testFile1, '\n## {§TEST.3}\nNew section');
      fs.utimesSync(testFile1, originalMtime, originalMtime);

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
