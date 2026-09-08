/**
 * Tests for operations.ts
 * Shared logic behind the MCP handlers, CLI, and hook
 */

import * as path from 'path';
import { ServerConfig } from '../src/config.js';
import { buildSectionIndex } from '../src/indexer.js';
import {
  dedupeSupersededReferences,
  expandSectionsWithIndex,
  extractReferences,
  fetchPoliciesForReferences,
  formatSourceList,
  listPrefixes,
  validateReferences,
} from '../src/operations.js';
import { SectionIndex } from '../src/types.js';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');

function makeConfig(names: string[]): ServerConfig {
  return {
    files: names.map((n) => path.join(FIXTURES_DIR, n)),
    baseDir: FIXTURES_DIR,
    maxChunkTokens: 10000,
  };
}

describe('operations', () => {
  const config = makeConfig([
    'policy-test.md',
    'policy-meta.md',
    'policy-app.md',
    'policy-sys.md',
    'policy-hyphenated.md',
  ]);
  let index: SectionIndex;

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    index = buildSectionIndex(config);
  });

  describe('expandSectionsWithIndex', () => {
    it('expands prefix-only notation to every indexed section', () => {
      expect(expandSectionsWithIndex(['§META'], index).sort()).toEqual([
        '§META.1',
        '§META.2',
        '§META.2.1',
      ]);
    });

    it('expands ranges and passes single sections through', () => {
      expect(expandSectionsWithIndex(['§APP.4.1-2', '§SYS.1'], index)).toEqual([
        '§APP.4.1',
        '§APP.4.2',
        '§SYS.1',
      ]);
    });

    it('does not let §APP match §APP-PLG sections', () => {
      const result = expandSectionsWithIndex(['§APP'], index);
      expect(result.some((s) => s.startsWith('§APP-PLG'))).toBe(false);
      expect(expandSectionsWithIndex(['§APP-PLG'], index)).toEqual(['§APP-PLG.1']);
    });

    it('throws for an unknown prefix', () => {
      expect(() => expandSectionsWithIndex(['§NOPE'], index)).toThrow(
        'No sections found for prefix: NOPE'
      );
    });
  });

  describe('extractReferences', () => {
    it('returns unique, sorted, range-expanded references', () => {
      const content = 'See §APP.4.1-2 then §META.1, again §APP.4.1 and §APP.4.2';
      expect(extractReferences(content)).toEqual(['§APP.4.1', '§APP.4.2', '§META.1']);
    });

    it('keeps prefix-only references and ignores code', () => {
      const content = 'Follow §META always. Example: `§APP.1`\n```\n§SYS.1\n```';
      expect(extractReferences(content)).toEqual(['§META']);
    });

    it('returns an empty array when there are no references', () => {
      expect(extractReferences('plain text')).toEqual([]);
    });
  });

  describe('dedupeSupersededReferences', () => {
    it('drops specific references covered by a prefix-only reference', () => {
      const dropped: string[] = [];
      const result = dedupeSupersededReferences(
        ['§META', '§META.2', '§APP.1', '§META.2.1'],
        (ref, prefix) => dropped.push(`${ref}:${prefix}`)
      );
      expect(result).toEqual(['§META', '§APP.1']);
      expect(dropped).toEqual(['§META.2:META', '§META.2.1:META']);
    });

    it('removes exact duplicates while preserving order', () => {
      expect(dedupeSupersededReferences(['§APP.2', '§APP.1', '§APP.2'])).toEqual([
        '§APP.2',
        '§APP.1',
      ]);
    });

    it('does not treat §APP as covering §APP-HOOK.1', () => {
      expect(dedupeSupersededReferences(['§APP', '§APP-HOOK.1'])).toEqual(['§APP', '§APP-HOOK.1']);
    });

    it('works without a callback', () => {
      expect(dedupeSupersededReferences(['§SYS', '§SYS.5'])).toEqual(['§SYS']);
    });
  });

  describe('fetchPoliciesForReferences', () => {
    it('fetches content for expanded references with recursive resolution', () => {
      const content = fetchPoliciesForReferences(['§SYS.5'], index, FIXTURES_DIR);
      expect(content).toContain('## {§SYS.5}');
      // §SYS.5 references §TEST.3, which references §SYS.5 (cycle) - both present once
      expect(content).toContain('## {§TEST.3}');
      expect(content.match(/## \{§SYS\.5\}/g)).toHaveLength(1);
    });

    it('expands prefix-only references', () => {
      const content = fetchPoliciesForReferences(['§META'], index, FIXTURES_DIR);
      expect(content).toContain('## {§META.1}');
      expect(content).toContain('## {§META.2}');
    });

    it('throws when a reference cannot be resolved', () => {
      expect(() => fetchPoliciesForReferences(['§META.99'], index, FIXTURES_DIR)).toThrow(
        /§META\.99/
      );
    });
  });

  describe('validateReferences', () => {
    it('reports valid for existing references', () => {
      const result = validateReferences(['§APP.1', '§META.2-2'], index);
      expect(result).toEqual({ valid: true, checked: 2, invalid: [], details: [] });
    });

    it('reports missing references', () => {
      const result = validateReferences(['§APP.1', '§APP.99'], index);
      expect(result.valid).toBe(false);
      expect(result.checked).toBe(2);
      expect(result.invalid).toEqual(['§APP.99']);
      expect(result.details).toEqual(['§APP.99: Section not found in policy files']);
    });

    it('reports global duplicates and ambiguous references', () => {
      const dupIndex = buildSectionIndex(
        makeConfig(['policy-duplicate1.md', 'policy-duplicate2.md'])
      );
      const result = validateReferences(['§DUP.1', '§DUP.2'], dupIndex);

      expect(result.valid).toBe(false);
      expect(result.invalid).toEqual(['§DUP.1']);
      expect(result.details[0]).toBe('Global validation errors:');
      expect(result.details[1]).toContain('§DUP.1 appears in:');
      expect(result.details[1]).toContain('§DUP.3 appears in:');
      expect(result.details[2]).toContain('§DUP.1: Found in multiple files:');
      expect(result.details[2]).toContain('policy-duplicate1.md');
      expect(result.details[2]).toContain('policy-duplicate2.md');
    });

    it('throws for an unknown prefix-only reference', () => {
      expect(() => validateReferences(['§NOPE'], index)).toThrow(/No sections found/);
    });
  });

  describe('listPrefixes', () => {
    it('returns sorted distinct prefixes including hyphenated ones', () => {
      expect(listPrefixes(index)).toEqual(['APP', 'APP-PLG', 'META', 'SYS', 'SYS-TPL', 'TEST']);
    });

    it('returns an empty list for an empty index', () => {
      const empty = buildSectionIndex(makeConfig(['policy-empty.md']));
      expect(listPrefixes(empty)).toEqual([]);
    });
  });

  describe('formatSourceList', () => {
    it('includes files, statistics, prefixes, and format notes', () => {
      const text = formatSourceList(config, index);
      for (const file of config.files) {
        expect(text).toContain(`- ${file}`);
      }
      expect(text).toContain(`- Files indexed: ${config.files.length}`);
      expect(text).toContain(`- Sections indexed: ${index.sectionCount}`);
      expect(text).toContain('- Duplicate sections: 0');
      expect(text).toContain(`- Last indexed: ${index.lastIndexed.toISOString()}`);
      expect(text).toContain('- §APP-PLG');
      expect(text).toContain('- §TEST');
      expect(text).toContain('## Format');
    });
  });
});
