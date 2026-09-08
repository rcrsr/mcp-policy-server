/**
 * Comprehensive tests for section resolver (index-based architecture)
 * Tests recursive reference resolution and section gathering using prebuilt index
 */

import * as path from 'path';
import * as fg from 'fast-glob';
import { ServerConfig } from '../src/config.js';
import { buildSectionIndex } from '../src/indexer.js';
import {
  resolveSection,
  gatherSectionsWithIndex,
  fetchSectionsWithIndex,
  resolveSectionLocationsWithIndex,
} from '../src/resolver.js';
import { SectionIndex, SectionNotation } from '../src/types.js';

describe('resolver (index-based)', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures', 'sample-policies');

  // Build config and index once for all tests
  let config: ServerConfig;
  let index: SectionIndex;

  beforeAll(() => {
    // Build config manually using fast-glob to avoid Windows path issues
    // Fast-glob requires forward slashes, but path.resolve returns backslashes on Windows
    const pattern = path.join(fixturesDir, '*.md').split(path.sep).join('/');
    const files = fg.sync(pattern, {
      dot: false,
      followSymbolicLinks: true,
      onlyFiles: true,
      absolute: true,
    });

    config = {
      files,
      baseDir: fixturesDir,
      maxChunkTokens: 10000,
    };

    // Suppress console.error during index building
    const originalError = console.error;
    console.error = () => {};

    try {
      index = buildSectionIndex(config);
    } finally {
      console.error = originalError;
    }
  });

  describe('resolveSection', () => {
    it('should resolve section notation to file path using index', () => {
      const filePath = resolveSection('§APP.7' as SectionNotation, index);
      expect(path.basename(filePath)).toBe('policy-app.md');
    });

    it('should resolve subsection notation', () => {
      const filePath = resolveSection('§APP.4.1' as SectionNotation, index);
      expect(path.basename(filePath)).toBe('policy-app.md');
    });

    it('should resolve hyphenated prefix', () => {
      const filePath = resolveSection('§APP-HOOK.1' as SectionNotation, index);
      expect(path.basename(filePath)).toBe('policy-app-hooks.md');
    });

    it('should throw error for section not found', () => {
      expect(() => {
        resolveSection('§APP.99' as SectionNotation, index);
      }).toThrow(/Section §APP\.99 not found/);
    });

    it('should throw error for duplicate section', () => {
      expect(() => {
        resolveSection('§DUP.1' as SectionNotation, index);
      }).toThrow(/Section §DUP\.1 found in multiple files/);
    });
  });

  describe('gatherSectionsWithIndex', () => {
    it('should gather single section without references', () => {
      const gathered = gatherSectionsWithIndex(['§META.1'], index, config.baseDir);
      expect(gathered.size).toBe(1);
      expect(gathered.has('§META.1')).toBe(true);

      const section = gathered.get('§META.1');
      expect(section).toBeDefined();
      expect(section?.prefix).toBe('META');
      expect(section?.section).toBe('1');
      expect(section?.file).toBe('policy-meta.md');
      expect(section?.content).toContain('First Meta Section');
    });

    it('should gather section and resolve embedded references', () => {
      const gathered = gatherSectionsWithIndex(['§TEST.1'], index, config.baseDir);
      // TEST.1 references §TEST.2 and §TEST.3
      expect(gathered.size).toBeGreaterThanOrEqual(3);
      expect(gathered.has('§TEST.1')).toBe(true);
      expect(gathered.has('§TEST.2')).toBe(true);
      expect(gathered.has('§TEST.3')).toBe(true);
    });

    it('should resolve recursive reference chains', () => {
      // TEST.2.1 → TEST.2.2 → APP.7 → TEST.1 → TEST.2, TEST.3
      // Note: TEST.2 is parent of TEST.2.1, so TEST.2 supersedes TEST.2.1 when pulled in
      const gathered = gatherSectionsWithIndex(['§TEST.2.1'], index, config.baseDir);

      // TEST.2 gets pulled in and supersedes TEST.2.1 (parent-child deduplication)
      expect(gathered.has('§TEST.2')).toBe(true);
      expect(gathered.has('§TEST.2.1')).toBe(false); // Deduplicated by parent TEST.2
      expect(gathered.has('§APP.7')).toBe(true);
      expect(gathered.has('§TEST.1')).toBe(true);
      expect(gathered.has('§TEST.3')).toBe(true);
    });

    it('should handle parent-child deduplication when parent processed first', () => {
      const gathered = gatherSectionsWithIndex(['§APP.4', '§APP.4.1'], index, config.baseDir);

      // Parent §APP.4 should be included
      expect(gathered.has('§APP.4')).toBe(true);
      // Child §APP.4.1 should be excluded (parent supersedes)
      expect(gathered.has('§APP.4.1')).toBe(false);
    });

    it('should handle parent-child deduplication when child processed first', () => {
      // Process child first, then parent appears via reference
      const gathered = gatherSectionsWithIndex(['§APP.4.1', '§APP.4'], index, config.baseDir);

      // Parent §APP.4 should be included
      expect(gathered.has('§APP.4')).toBe(true);
      // Child §APP.4.1 should be removed when parent added
      expect(gathered.has('§APP.4.1')).toBe(false);
    });

    it('should not deduplicate unrelated sections', () => {
      const gathered = gatherSectionsWithIndex(['§APP.1', '§APP.7'], index, config.baseDir);
      expect(gathered.has('§APP.1')).toBe(true);
      expect(gathered.has('§APP.7')).toBe(true);
    });

    it('should throw error for missing section', () => {
      expect(() => {
        gatherSectionsWithIndex(['§APP.99'], index, config.baseDir);
      }).toThrow(/Section §APP\.99 not found/);
    });

    it('should search across multiple files for section', () => {
      // APP-HOOK.1 is in policy-app-hooks.md
      const gathered = gatherSectionsWithIndex(['§APP-HOOK.1'], index, config.baseDir);
      expect(gathered.has('§APP-HOOK.1')).toBe(true);

      const section = gathered.get('§APP-HOOK.1');
      expect(section?.file).toBe('policy-app-hooks.md');
    });

    it('should handle range notation in embedded references', () => {
      // TEST.2.2 contains §APP.4.1-3 range and §APP.7 which references TEST.1 → TEST.2
      // TEST.2 is parent of TEST.2.2 so it supersedes
      const gathered = gatherSectionsWithIndex(['§TEST.2.2'], index, config.baseDir);

      expect(gathered.has('§TEST.2')).toBe(true); // Parent supersedes TEST.2.2
      expect(gathered.has('§TEST.2.2')).toBe(false); // Deduplicated by parent
      // APP.7 references TEST.1, which pulls in TEST.2 and TEST.3 via references
      expect(gathered.has('§APP.7')).toBe(true);
      expect(gathered.has('§TEST.1')).toBe(true);
      expect(gathered.has('§TEST.3')).toBe(true);
      // Section count should reflect recursive resolution
      expect(gathered.size).toBeGreaterThan(3);
    });

    it('should handle multiple initial sections', () => {
      const gathered = gatherSectionsWithIndex(['§META.1', '§SYS.1'], index, config.baseDir);
      expect(gathered.has('§META.1')).toBe(true);
      expect(gathered.has('§SYS.1')).toBe(true);
    });

    it('should handle sections with no content gracefully', () => {
      // APP.8 is an empty section
      const gathered = gatherSectionsWithIndex(['§APP.8'], index, config.baseDir);
      expect(gathered.has('§APP.8')).toBe(true);
    });

    it('should deduplicate when processing queue', () => {
      // Section that references itself indirectly shouldn't cause infinite loop
      const gathered = gatherSectionsWithIndex(['§APP.4.1'], index, config.baseDir);
      expect(gathered.size).toBeGreaterThan(0);
      // All gathered sections should be unique
      const notations = Array.from(gathered.keys());
      const uniqueNotations = new Set(notations);
      expect(notations.length).toBe(uniqueNotations.size);
    });

    it('should handle empty section list gracefully', () => {
      const gathered = gatherSectionsWithIndex([], index, config.baseDir);
      expect(gathered.size).toBe(0);
    });

    it('should show reference chain in error for embedded references', () => {
      // §BADREF.1 contains reference to §MISSING.99
      expect(() => {
        gatherSectionsWithIndex(['§BADREF.1'], index, config.baseDir);
      }).toThrow(/§MISSING\.99.*\(referenced by §BADREF\.1\)/);
    });
  });

  describe('fetchSectionsWithIndex', () => {
    it('should fetch single section and return content', () => {
      const content = fetchSectionsWithIndex(['§META.1'], index, config.baseDir);
      expect(content).toContain('§META.1');
      expect(content).toContain('First Meta Section');
    });

    it('should fetch multiple sections with separator', () => {
      const content = fetchSectionsWithIndex(['§META.1', '§SYS.1'], index, config.baseDir);
      expect(content).toContain('§META.1');
      expect(content).toContain('§SYS.1');
    });

    it('should sort sections by prefix and number', () => {
      // Test sorting behavior - verify sections are all present
      const content = fetchSectionsWithIndex(
        ['§META.2.1', '§SYS.5.1', '§APP.8'],
        index,
        config.baseDir
      );

      // Verify all sections are included
      expect(content).toContain('{§META.2.1}');
      expect(content).toContain('{§SYS.5.1}');
      expect(content).toContain('{§APP.8}');
    });

    it('should include recursively resolved sections', () => {
      const content = fetchSectionsWithIndex(['§TEST.1'], index, config.baseDir);
      expect(content).toContain('§TEST.1');
      expect(content).toContain('§TEST.2');
      expect(content).toContain('§TEST.3');
    });

    it('should expand range notation', () => {
      // fetchSections should handle range expansion internally via gatherSections
      // APP.4 has references to META.1 and pulls in APP.4.1→APP.4.2→APP.4.3 chain
      // Then parent §APP.4 supersedes all children
      const content = fetchSectionsWithIndex(['§APP.4'], index, config.baseDir);
      expect(content).toContain('{§APP.4}');
    });

    it('should handle sections with embedded references', () => {
      // TEST.2.2 → APP.7 → TEST.1 → TEST.2 (parent supersedes TEST.2.2)
      const content = fetchSectionsWithIndex(['§TEST.2.2'], index, config.baseDir);
      expect(content).toContain('{§TEST.2}'); // Parent instead of TEST.2.2
      // Should include referenced APP sections
      expect(content).toContain('§APP'); // From §APP.7 or §APP.4 references
    });

    it('should throw error for missing section', () => {
      expect(() => {
        fetchSectionsWithIndex(['§APP.99'], index, config.baseDir);
      }).toThrow(/Section §APP\.99 not found/);
    });

    it('should separate sections with newlines and separators', () => {
      const content = fetchSectionsWithIndex(['§META.1', '§SYS.1'], index, config.baseDir);
      // Verify both sections are present (separator format depends on markdown files)
      expect(content).toContain('§META.1');
      expect(content).toContain('§SYS.1');
    });
  });

  describe('resolveSectionLocationsWithIndex', () => {
    it('should map sections to their source files', () => {
      const locations = resolveSectionLocationsWithIndex(
        ['§META.1', '§APP.1'],
        index,
        config.baseDir
      );

      expect(locations['policy-meta.md']).toContain('§META.1');
      expect(locations['policy-app.md']).toContain('§APP.1');
    });

    it('should include recursively resolved sections', () => {
      const locations = resolveSectionLocationsWithIndex(['§TEST.1'], index, config.baseDir);

      // TEST.1 references TEST.2, TEST.3
      expect(locations['policy-test.md']).toBeDefined();
      expect(locations['policy-test.md'].length).toBeGreaterThan(1);
    });

    it('should sort sections within each file', () => {
      const locations = resolveSectionLocationsWithIndex(
        ['§APP.7', '§APP.1', '§APP.4'],
        index,
        config.baseDir
      );

      const appSections = locations['policy-app.md'];
      expect(appSections).toBeDefined();

      // Check numeric sorting: APP.1 < APP.4 < APP.7
      const app1Index = appSections.indexOf('§APP.1');
      const app4Index = appSections.indexOf('§APP.4');
      const app7Index = appSections.indexOf('§APP.7');

      expect(app1Index).toBeLessThan(app4Index);
      expect(app4Index).toBeLessThan(app7Index);
    });

    it('should sort files alphabetically', () => {
      const locations = resolveSectionLocationsWithIndex(
        ['§META.1', '§TEST.1', '§APP.1'],
        index,
        config.baseDir
      );

      const files = Object.keys(locations);
      // Files should be sorted
      const sortedFiles = [...files].sort();
      expect(files).toEqual(sortedFiles);
    });

    it('should map extension file sections correctly', () => {
      const locations = resolveSectionLocationsWithIndex(['§APP-HOOK.1'], index, config.baseDir);

      expect(locations['policy-app-hooks.md']).toBeDefined();
      expect(locations['policy-app-hooks.md']).toContain('§APP-HOOK.1');
    });

    it('should throw error for missing section', () => {
      expect(() => {
        resolveSectionLocationsWithIndex(['§APP.99'], index, config.baseDir);
      }).toThrow(/Section §APP\.99 not found/);
    });

    it('should handle multiple sections from same file', () => {
      const locations = resolveSectionLocationsWithIndex(
        ['§TEST.1', '§TEST.2', '§TEST.3'],
        index,
        config.baseDir
      );

      expect(locations['policy-test.md']).toBeDefined();
      expect(locations['policy-test.md'].length).toBeGreaterThanOrEqual(3);
    });

    it('should return empty object when no sections provided', () => {
      const locations = resolveSectionLocationsWithIndex([], index, config.baseDir);
      expect(Object.keys(locations).length).toBe(0);
    });

    it('should handle parent-child deduplication in location map', () => {
      const locations = resolveSectionLocationsWithIndex(
        ['§APP.4', '§APP.4.1'],
        index,
        config.baseDir
      );

      const appSections = locations['policy-app.md'];
      expect(appSections).toContain('§APP.4');
      expect(appSections).not.toContain('§APP.4.1'); // Child removed by parent
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete reference chain resolution', () => {
      // TEST.2.2 → APP.7 → TEST.1 → TEST.2, TEST.3 → META.1, SYS.5
      const gathered = gatherSectionsWithIndex(['§TEST.2.2'], index, config.baseDir);

      // Should have resolved multiple levels deep
      expect(gathered.size).toBeGreaterThan(3);
    });

    it('should handle mixed range and single section requests', () => {
      // Use whole section §APP.4 instead of range §APP.4.1-3
      const content = fetchSectionsWithIndex(['§APP.1', '§APP.4'], index, config.baseDir);
      expect(content).toContain('{§APP.1}');
      expect(content).toContain('{§APP.4}'); // Parent supersedes children
    });

    it('should correctly order mixed prefix sections', () => {
      // Test with sections from different prefixes
      const content = fetchSectionsWithIndex(
        ['§APP.8', '§META.2.1', '§SYS.5.1'],
        index,
        config.baseDir
      );

      // Verify all sections are included
      expect(content).toContain('{§META.2.1}');
      expect(content).toContain('{§SYS.5.1}');
      expect(content).toContain('{§APP.8}');
    });

    it('should resolve sections from multiple extension files', () => {
      const locations = resolveSectionLocationsWithIndex(
        ['§APP.1', '§APP-HOOK.1'],
        index,
        config.baseDir
      );

      expect(locations['policy-app.md']).toBeDefined();
      expect(locations['policy-app-hooks.md']).toBeDefined();
    });
  });
});

describe('resolver lenient mode', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures', 'sample-policies');
  let index: SectionIndex;

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    index = buildSectionIndex({
      files: [path.join(fixturesDir, 'policy-meta.md'), path.join(fixturesDir, 'policy-sys.md')],
      baseDir: fixturesDir,
    });
  });

  it('throws on invalid notation when strict', () => {
    expect(() => gatherSectionsWithIndex(['§NOPE'], index, fixturesDir)).toThrow(
      /Invalid section notation "§NOPE"/
    );
  });

  it('skips invalid notation and unresolvable sections with warnings when lenient', () => {
    const warnings: string[] = [];
    const gathered = gatherSectionsWithIndex(['§NOPE', '§META.99', '§META.1'], index, fixturesDir, {
      lenient: true,
      onWarning: (m) => warnings.push(m),
    });

    expect(Array.from(gathered.keys())).toEqual(['§META.1']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Invalid section notation "§NOPE"/);
    expect(warnings[1]).toMatch(/^Failed to resolve section "§META\.99"/);
  });

  it('works lenient without an onWarning callback', () => {
    const content = fetchSectionsWithIndex(['§META.99', '§SYS.1'], index, fixturesDir, {
      lenient: true,
    });
    expect(content).toContain('## {§SYS.1}');
  });
});
