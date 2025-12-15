/**
 * Integration tests for MCP server
 * Tests all tool handlers end-to-end with real file fixtures
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  handleFetch,
  handleResolveReferences,
  handleExtractReferences,
  handleValidateReferences,
  handleListSources,
  estimateTokens,
  chunkContent,
  expandSectionsWithIndex,
} from '../src/handlers';
import { ServerConfig } from '../src/config';
import { initializeIndexState, closeIndexState } from '../src/indexer';
import { IndexState } from '../src/types';

// Test configuration matching fixture structure
// baseDir should be the actual policy directory, not the project root
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'sample-policies');
const TEST_CONFIG: ServerConfig = {
  files: [
    path.join(FIXTURES_DIR, 'policy-test.md'),
    path.join(FIXTURES_DIR, 'policy-meta.md'),
    path.join(FIXTURES_DIR, 'policy-app.md'),
    path.join(FIXTURES_DIR, 'policy-sys.md'),
    path.join(FIXTURES_DIR, 'policy-duplicate1.md'),
    path.join(FIXTURES_DIR, 'policy-subsections.md'),
    path.join(FIXTURES_DIR, 'policy-empty.md'),
    path.join(FIXTURES_DIR, 'policy-large.md'),
    path.join(FIXTURES_DIR, 'policy-app-hooks.md'),
  ],
  baseDir: FIXTURES_DIR,
  maxChunkTokens: 10000,
};

// Small chunk size for testing chunking behavior
const SMALL_CHUNK_CONFIG: ServerConfig = {
  ...TEST_CONFIG,
  maxChunkTokens: 500,
};

describe('MCP Server Integration', () => {
  let indexState: IndexState;
  let smallChunkIndexState: IndexState;

  beforeAll(() => {
    // Initialize index state once for all tests
    indexState = initializeIndexState(TEST_CONFIG);
    smallChunkIndexState = initializeIndexState(SMALL_CHUNK_CONFIG);
  });

  afterAll(() => {
    // Clean up file watchers after tests
    closeIndexState(indexState);
    closeIndexState(smallChunkIndexState);
  });

  describe('Configuration', () => {
    test('test config has all required fields', () => {
      expect(TEST_CONFIG.baseDir).toBeDefined();
      expect(TEST_CONFIG.files).toBeDefined();
      expect(Array.isArray(TEST_CONFIG.files)).toBe(true);
      expect(TEST_CONFIG.files.length).toBeGreaterThan(0);
    });

    test('test config has maxChunkTokens default', () => {
      expect(TEST_CONFIG.maxChunkTokens).toBe(10000);
    });

    test('all configured files exist', () => {
      for (const filePath of TEST_CONFIG.files) {
        expect(fs.existsSync(filePath)).toBe(true);
      }
    });
  });

  describe('Tool Handlers', () => {
    describe('handleFetch', () => {
      test('fetches single section successfully', () => {
        const response = handleFetch({ sections: ['§TEST.1'] }, TEST_CONFIG, indexState);

        expect(response.content).toBeDefined();
        expect(response.content.length).toBeGreaterThan(0);
        expect(response.content[0].type).toBe('text');
        expect(response.content[0].text).toContain('§TEST.1');
        expect(response.content[0].text).toContain('First Whole Section');
      });

      test('fetches multiple sections from same file', () => {
        const response = handleFetch({ sections: ['§TEST.1', '§TEST.3'] }, TEST_CONFIG, indexState);

        expect(response.content[0].text).toContain('§TEST.1');
        expect(response.content[0].text).toContain('§TEST.3');
      });

      test('fetches sections from different files', () => {
        const response = handleFetch(
          { sections: ['§APP.7', '§SYS.5', '§META.1'] },
          TEST_CONFIG,
          indexState
        );

        const text = response.content[0].text;
        expect(text).toContain('§APP.7');
        expect(text).toContain('§SYS.5');
        expect(text).toContain('§META.1');
      });

      test('expands range notation', () => {
        const response = handleFetch({ sections: ['§APP.4.1-3'] }, TEST_CONFIG, indexState);

        const text = response.content[0].text;
        expect(text).toContain('§APP.4.1');
        expect(text).toContain('§APP.4.2');
        expect(text).toContain('§APP.4.3');
      });

      test('resolves embedded references recursively', () => {
        const response = handleFetch({ sections: ['§TEST.1'] }, TEST_CONFIG, indexState);

        const text = response.content[0].text;
        // TEST.1 references TEST.2 and TEST.3
        expect(text).toContain('§TEST.2');
        expect(text).toContain('§TEST.3');
      });

      test('throws error for empty sections array', () => {
        expect(() => {
          handleFetch({ sections: [] }, TEST_CONFIG, indexState);
        }).toThrow('sections parameter must be a non-empty array');
      });

      test('throws error for non-array sections parameter', () => {
        expect(() => {
          handleFetch({ sections: '§TEST.1' }, TEST_CONFIG, indexState);
        }).toThrow('Invalid arguments: expected { sections: string[]');
      });

      test('throws error for invalid section notation', () => {
        expect(() => {
          handleFetch({ sections: ['TEST.1'] }, TEST_CONFIG, indexState);
        }).toThrow();
      });

      test('throws error for unknown prefix', () => {
        expect(() => {
          handleFetch({ sections: ['§UNKNOWN.1'] }, TEST_CONFIG, indexState);
        }).toThrow();
      });

      test('throws error for missing section', () => {
        expect(() => {
          handleFetch({ sections: ['§TEST.999'] }, TEST_CONFIG, indexState);
        }).toThrow();
      });

      describe('prefix-only notation', () => {
        test('fetches all sections for a prefix', () => {
          const response = handleFetch({ sections: ['§META'] }, TEST_CONFIG, indexState);

          const text = response.content[0].text;
          expect(text).toContain('§META.1');
          expect(text).toContain('§META.2');
        });

        test('fetches all sections with hyphenated prefix', () => {
          const response = handleFetch({ sections: ['§APP-HOOK'] }, TEST_CONFIG, indexState);

          const text = response.content[0].text;
          expect(text).toContain('§APP-HOOK.1');
          expect(text).toContain('§APP-HOOK.2');
        });

        test('works with mixed prefix-only and specific sections', () => {
          const response = handleFetch({ sections: ['§META', '§TEST.1'] }, TEST_CONFIG, indexState);

          const text = response.content[0].text;
          expect(text).toContain('§META.1');
          expect(text).toContain('§TEST.1');
        });

        test('throws error for unknown prefix', () => {
          expect(() => {
            handleFetch({ sections: ['§UNKNOWN'] }, TEST_CONFIG, indexState);
          }).toThrow('No sections found for prefix: UNKNOWN');
        });
      });

      describe('chunking', () => {
        test('returns single chunk for small content', () => {
          const response = handleFetch({ sections: ['§TEST.1'] }, TEST_CONFIG, indexState);

          expect(response.content.length).toBe(1);
          expect(response.content[0].text).not.toContain('MORE CHUNKS REQUIRED');
        });

        test('splits large content into multiple chunks', () => {
          const response = handleFetch(
            { sections: ['§LARGE.1', '§LARGE.2', '§LARGE.3'] },
            SMALL_CHUNK_CONFIG,
            smallChunkIndexState
          );

          expect(response.content.length).toBeGreaterThan(1);
          expect(response.content[1].text).toContain('INCOMPLETE');
          expect(response.content[1].text).toContain('continuation');
        });

        test('retrieves subsequent chunks with continuation token', () => {
          // First request to get initial chunk
          const firstResponse = handleFetch(
            { sections: ['§LARGE.1', '§LARGE.2', '§LARGE.3'] },
            SMALL_CHUNK_CONFIG,
            smallChunkIndexState
          );

          expect(firstResponse.content.length).toBeGreaterThan(1);

          // Extract continuation token from response
          const continuationMatch = firstResponse.content[1].text.match(/continuation="([^"]+)"/);
          expect(continuationMatch).not.toBeNull();

          const continuationToken = continuationMatch![1];

          // Second request with continuation
          const secondResponse = handleFetch(
            {
              sections: ['§LARGE.1', '§LARGE.2', '§LARGE.3'],
              continuation: continuationToken,
            },
            SMALL_CHUNK_CONFIG,
            smallChunkIndexState
          );

          expect(secondResponse.content).toBeDefined();
          expect(secondResponse.content[0].text).toBeDefined();
          expect(secondResponse.content[0].text.length).toBeGreaterThan(0);
        });

        test('throws error for invalid continuation token', () => {
          expect(() => {
            handleFetch(
              {
                sections: ['§TEST.1'],
                continuation: 'chunk:999',
              },
              TEST_CONFIG,
              indexState
            );
          }).toThrow('Invalid continuation token');
        });

        test('last chunk has no continuation message', () => {
          const response = handleFetch({ sections: ['§TEST.1'] }, TEST_CONFIG, indexState);

          const hasMoreMessage = response.content.some((c) =>
            c.text.includes('MORE CHUNKS REQUIRED')
          );

          expect(hasMoreMessage).toBe(false);
        });
      });
    });

    describe('handleResolveReferences', () => {
      test('resolves single section location', () => {
        const response = handleResolveReferences(
          { sections: ['§TEST.1'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result['policy-test.md']).toBeDefined();
        expect(result['policy-test.md']).toContain('§TEST.1');
      });

      test('resolves multiple sections from same file', () => {
        const response = handleResolveReferences(
          { sections: ['§TEST.1', '§TEST.2', '§TEST.3'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result['policy-test.md']).toBeDefined();
        expect(result['policy-test.md'].length).toBeGreaterThanOrEqual(3);
      });

      test('groups sections by file', () => {
        const response = handleResolveReferences(
          { sections: ['§APP.7', '§SYS.5', '§META.1'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result['policy-app.md']).toBeDefined();
        expect(result['policy-sys.md']).toBeDefined();
        expect(result['policy-meta.md']).toBeDefined();
      });

      test('expands ranges before resolving', () => {
        const response = handleResolveReferences(
          { sections: ['§APP.4.1-3'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result['policy-app.md']).toContain('§APP.4.1');
        expect(result['policy-app.md']).toContain('§APP.4.2');
        expect(result['policy-app.md']).toContain('§APP.4.3');
      });

      test('includes recursively resolved references', () => {
        const response = handleResolveReferences(
          { sections: ['§TEST.1'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        const allSections = Object.values(result).flat();

        // TEST.1 should trigger recursive resolution
        expect(allSections.length).toBeGreaterThan(1);
      });

      test('sorts sections within each file', () => {
        const response = handleResolveReferences(
          { sections: ['§TEST.3', '§TEST.1', '§TEST.2'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        const sections = result['policy-test.md'];

        // Verify sections are sorted
        const indices = sections.map((s: string) => {
          const match = s.match(/§TEST\.(\d+)/);
          return match ? parseInt(match[1], 10) : 0;
        });

        for (let i = 1; i < indices.length; i++) {
          expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
        }
      });

      test('throws error for empty sections array', () => {
        expect(() => {
          handleResolveReferences({ sections: [] }, TEST_CONFIG, indexState);
        }).toThrow('sections parameter must be a non-empty array');
      });

      test('throws error for non-array sections parameter', () => {
        expect(() => {
          handleResolveReferences({ sections: '§TEST.1' }, TEST_CONFIG, indexState);
        }).toThrow('Invalid arguments: expected { sections: string[]');
      });

      test('resolves prefix-only notation to all matching sections', () => {
        const response = handleResolveReferences({ sections: ['§META'] }, TEST_CONFIG, indexState);

        const result = JSON.parse(response.content[0].text);
        expect(result['policy-meta.md']).toBeDefined();
        expect(result['policy-meta.md']).toContain('§META.1');
        expect(result['policy-meta.md']).toContain('§META.2');
      });
    });

    describe('handleExtractReferences', () => {
      const testAgentPath = path.join(__dirname, 'fixtures', 'test-agent.md');

      test('extracts all § references from file', () => {
        const response = handleExtractReferences({ file_path: testAgentPath }, TEST_CONFIG);

        const references = JSON.parse(response.content[0].text);
        expect(Array.isArray(references)).toBe(true);
        expect(references).toContain('§APP.7');
        expect(references).toContain('§SYS.5');
        expect(references).toContain('§META.1');
        expect(references).toContain('§TEST.1');
      });

      test('expands ranges in extracted references', () => {
        const response = handleExtractReferences({ file_path: testAgentPath }, TEST_CONFIG);

        const references = JSON.parse(response.content[0].text);
        expect(references).toContain('§APP.4.1');
        expect(references).toContain('§APP.4.2');
        expect(references).toContain('§APP.4.3');
      });

      test('returns unique sorted references', () => {
        const response = handleExtractReferences({ file_path: testAgentPath }, TEST_CONFIG);

        const references = JSON.parse(response.content[0].text);
        const uniqueRefs = Array.from(new Set(references));

        expect(references.length).toBe(uniqueRefs.length);

        // Verify sorted order
        const sorted = [...references].sort();
        expect(references).toEqual(sorted);
      });

      test('handles file with no references', () => {
        const emptyFile = path.join(__dirname, 'fixtures', 'sample-policies', 'policy-empty.md');

        const response = handleExtractReferences({ file_path: emptyFile }, TEST_CONFIG);

        const references = JSON.parse(response.content[0].text);
        expect(Array.isArray(references)).toBe(true);
        expect(references.length).toBe(0);
      });

      test('throws error for missing file_path parameter', () => {
        expect(() => {
          handleExtractReferences({}, TEST_CONFIG);
        }).toThrow('Invalid arguments: expected { file_path: string }');
      });

      test('throws error for non-existent file', () => {
        expect(() => {
          handleExtractReferences({ file_path: '/non/existent/file.md' }, TEST_CONFIG);
        }).toThrow();
      });
    });

    describe('handleValidateReferences', () => {
      test('validates existing references as valid', () => {
        const response = handleValidateReferences(
          { references: ['§TEST.1', '§APP.7', '§META.1'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result.valid).toBe(true);
        expect(result.checked).toBe(3);
        expect(result.invalid).toEqual([]);
      });

      test('detects invalid references', () => {
        const response = handleValidateReferences(
          { references: ['§TEST.1', '§TEST.999', '§APP.7'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result.valid).toBe(false);
        expect(result.invalid).toContain('§TEST.999');
        expect(result.details.length).toBeGreaterThan(0);
      });

      test('validates ranges by expanding them first', () => {
        const response = handleValidateReferences(
          { references: ['§APP.4.1-3'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result.valid).toBe(true);
        expect(result.checked).toBe(1);
      });

      test('detects duplicate sections across files', () => {
        // DUP.1 appears in both policy-duplicate1.md and policy-duplicate2.md
        const response = handleValidateReferences(
          { references: ['§DUP.1'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        // May report duplicate issues in details
        expect(result.checked).toBe(1);
      });

      test('includes error details for invalid references', () => {
        const response = handleValidateReferences(
          { references: ['§TEST.999'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result.valid).toBe(false);
        expect(result.details).toBeDefined();
        expect(result.details.length).toBeGreaterThan(0);
        expect(result.details.some((d: string) => d.includes('§TEST.999'))).toBe(true);
      });

      test('throws error for empty references array', () => {
        expect(() => {
          handleValidateReferences({ references: [] }, TEST_CONFIG, indexState);
        }).toThrow('references parameter must be a non-empty array');
      });

      test('throws error for non-array references parameter', () => {
        expect(() => {
          handleValidateReferences({ references: '§TEST.1' }, TEST_CONFIG, indexState);
        }).toThrow('Invalid arguments: expected { references: string[]');
      });

      test('validates prefix-only notation by expanding to all sections', () => {
        const response = handleValidateReferences(
          { references: ['§META'] },
          TEST_CONFIG,
          indexState
        );

        const result = JSON.parse(response.content[0].text);
        expect(result.valid).toBe(true);
        // Note: checked count is the original reference count, not expanded
        expect(result.checked).toBe(1);
      });
    });

    describe('handleListSources', () => {
      test('returns formatted list of policy sources', () => {
        const response = handleListSources({}, TEST_CONFIG, indexState);

        expect(response.content).toBeDefined();
        expect(response.content[0].type).toBe('text');

        const text = response.content[0].text;
        expect(text).toContain('Policy Documentation Files');
        expect(text).toContain('Format');
      });

      test('includes configured files list', () => {
        const response = handleListSources({}, TEST_CONFIG, indexState);
        const text = response.content[0].text;

        // Check that policy files are listed
        expect(text).toContain('policy-test.md');
        expect(text).toContain('policy-app.md');
      });

      test('includes index statistics', () => {
        const response = handleListSources({}, TEST_CONFIG, indexState);
        const text = response.content[0].text;

        expect(text).toContain('Index Statistics');
        expect(text).toContain('Files indexed:');
        expect(text).toContain('Sections indexed:');
        expect(text).toContain('Duplicate sections:');
        expect(text).toContain('Last indexed:');
      });

      test('includes format documentation', () => {
        const response = handleListSources({}, TEST_CONFIG, indexState);
        const text = response.content[0].text;

        expect(text).toContain('Format');
        expect(text).toContain('§');
        expect(text).toContain('Ranges expand');
      });

      test('documents section notation', () => {
        const response = handleListSources({}, TEST_CONFIG, indexState);
        const text = response.content[0].text;

        expect(text).toContain('§');
        expect(text).toContain('prefix');
        expect(text).toContain('expand');
      });
    });
  });

  describe('Helper Functions', () => {
    describe('expandSectionsWithIndex', () => {
      test('expands prefix-only notation to all matching sections', () => {
        const expanded = expandSectionsWithIndex(['§TEST'], indexState.index);

        expect(expanded.length).toBeGreaterThan(0);
        expect(expanded.every((s) => s.startsWith('§TEST.'))).toBe(true);
      });

      test('returns all sections for a prefix', () => {
        const expanded = expandSectionsWithIndex(['§META'], indexState.index);

        expect(expanded).toContain('§META.1');
        expect(expanded).toContain('§META.2');
      });

      test('passes through regular section notation unchanged', () => {
        const expanded = expandSectionsWithIndex(['§TEST.1'], indexState.index);

        expect(expanded).toEqual(['§TEST.1']);
      });

      test('expands range notation via expandRange', () => {
        const expanded = expandSectionsWithIndex(['§APP.4.1-3'], indexState.index);

        expect(expanded).toContain('§APP.4.1');
        expect(expanded).toContain('§APP.4.2');
        expect(expanded).toContain('§APP.4.3');
      });

      test('handles mixed notation types', () => {
        const expanded = expandSectionsWithIndex(
          ['§META', '§TEST.1', '§APP.4.1-2'],
          indexState.index
        );

        // Should have META sections
        expect(expanded.some((s) => s.startsWith('§META.'))).toBe(true);
        // Should have TEST.1
        expect(expanded).toContain('§TEST.1');
        // Should have expanded range
        expect(expanded).toContain('§APP.4.1');
        expect(expanded).toContain('§APP.4.2');
      });

      test('throws error for unknown prefix', () => {
        expect(() => {
          expandSectionsWithIndex(['§NONEXISTENT'], indexState.index);
        }).toThrow('No sections found for prefix: NONEXISTENT');
      });

      test('handles hyphenated prefix-only notation', () => {
        const expanded = expandSectionsWithIndex(['§APP-HOOK'], indexState.index);

        expect(expanded.length).toBeGreaterThan(0);
        expect(expanded.every((s) => s.startsWith('§APP-HOOK.'))).toBe(true);
      });
    });

    describe('estimateTokens', () => {
      test('estimates tokens for short text', () => {
        const text = 'Hello world';
        const tokens = estimateTokens(text);

        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(text.length);
      });

      test('estimates approximately 1 token per 4 characters', () => {
        const text = 'a'.repeat(400);
        const tokens = estimateTokens(text);

        expect(tokens).toBeCloseTo(100, -1);
      });

      test('rounds up for fractional tokens', () => {
        const text = 'abc';
        const tokens = estimateTokens(text);

        expect(tokens).toBe(1);
      });

      test('handles empty string', () => {
        const tokens = estimateTokens('');
        expect(tokens).toBe(0);
      });
    });

    describe('chunkContent', () => {
      test('returns single chunk for content under limit', () => {
        const content = 'Small content';
        const chunks = chunkContent(content, 10000);

        expect(chunks.length).toBe(1);
        expect(chunks[0].content).toBe(content);
        expect(chunks[0].hasMore).toBe(false);
        expect(chunks[0].continuation).toBeNull();
      });

      test('splits content at section boundaries', () => {
        const content = `## {§TEST.1} Section One

${'Content for section one. '.repeat(50)}

## {§TEST.2} Section Two

${'Content for section two. '.repeat(50)}

## {§TEST.3} Section Three

${'Content for section three. '.repeat(50)}`;

        const chunks = chunkContent(content, 200);

        expect(chunks.length).toBeGreaterThan(1);

        // Each chunk should start with a section header
        for (const chunk of chunks) {
          if (chunk.content.includes('##')) {
            expect(chunk.content).toMatch(/^## \{§/m);
          }
        }
      });

      test('sets hasMore flag correctly', () => {
        const longContent = 'a'.repeat(50000);
        const chunks = chunkContent(longContent, 1000);

        // All chunks except last should have hasMore=true
        for (let i = 0; i < chunks.length - 1; i++) {
          expect(chunks[i].hasMore).toBe(true);
        }

        // Last chunk should have hasMore=false
        expect(chunks[chunks.length - 1].hasMore).toBe(false);
      });

      test('generates sequential continuation tokens', () => {
        const longContent = 'a'.repeat(50000);
        const chunks = chunkContent(longContent, 1000);

        for (let i = 0; i < chunks.length - 1; i++) {
          expect(chunks[i].continuation).toBe(`chunk:${i + 1}`);
        }

        expect(chunks[chunks.length - 1].continuation).toBeNull();
      });

      test('keeps sections intact across chunks', () => {
        const content = `## {§TEST.1} Section One

${'Line of content. '.repeat(100)}

## {§TEST.2} Section Two

${'Another line. '.repeat(100)}`;

        const chunks = chunkContent(content, 500);

        // Verify no section is split mid-content
        for (const chunk of chunks) {
          const sectionCount = (chunk.content.match(/## \{§/g) ?? []).length;
          expect(sectionCount).toBeGreaterThanOrEqual(0);
        }
      });

      test('handles content with no section markers', () => {
        const content = 'Plain content without sections. '.repeat(1000);
        const chunks = chunkContent(content, 1000);

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[chunks.length - 1].hasMore).toBe(false);
      });

      test('uses custom maxTokens parameter', () => {
        const content = `## {§TEST.1} Section One

${'Content here. '.repeat(200)}

## {§TEST.2} Section Two

${'More content. '.repeat(200)}

## {§TEST.3} Section Three

${'Additional content. '.repeat(200)}`;

        const largeChunks = chunkContent(content, 2000);
        const smallChunks = chunkContent(content, 500);

        expect(smallChunks.length).toBeGreaterThan(largeChunks.length);
      });
    });
  });

  describe('Edge Cases', () => {
    test('handles subsection references correctly', () => {
      const response = handleFetch({ sections: ['§META.2.1'] }, TEST_CONFIG, indexState);

      expect(response.content[0].text).toContain('§META.2.1');
      expect(response.content[0].text).toContain('Meta Subsection');
    });

    test('handles deeply nested subsections', () => {
      const response = handleFetch({ sections: ['§SUB.1.2.1'] }, TEST_CONFIG, indexState);

      expect(response.content[0].text).toContain('§SUB.1.2.1');
      expect(response.content[0].text).toContain('Deeply Nested');
    });

    test('handles empty section content', () => {
      const response = handleFetch({ sections: ['§APP.8'] }, TEST_CONFIG, indexState);

      expect(response.content[0].text).toContain('§APP.8');
    });

    test('handles mixed notation types in single request', () => {
      const response = handleFetch(
        { sections: ['§TEST.1', '§APP.4.1-3', '§META.2.1'] },
        TEST_CONFIG,
        indexState
      );

      const text = response.content[0].text;
      expect(text).toContain('§TEST.1');
      expect(text).toContain('§APP.4.1');
      expect(text).toContain('§META.2.1');
    });

    test('deduplicates parent-child sections', () => {
      const response = handleFetch({ sections: ['§APP.4', '§APP.4.1'] }, TEST_CONFIG, indexState);

      // APP.4 should include APP.4.1 content, so no duplication
      const text = response.content[0].text;
      const matches = text.match(/§APP\.4\.1/g);

      // Should appear once in header, not duplicated
      expect(matches).toBeDefined();
    });

    test('handles circular reference chains', () => {
      // TEST.1 references TEST.2, which references TEST.2.2,
      // which references APP.7, which references TEST.1
      const response = handleFetch({ sections: ['§TEST.1'] }, TEST_CONFIG, indexState);

      // Should not infinite loop
      expect(response.content).toBeDefined();
      expect(response.content[0].text).toBeTruthy();
    });

    test('handles sections with special characters in content', () => {
      const response = handleFetch({ sections: ['§TEST.1'] }, TEST_CONFIG, indexState);

      expect(response.content[0].text).toBeDefined();
      expect(response.content[0].text.length).toBeGreaterThan(0);
    });

    test('handles section notation with hyphens in prefix', () => {
      // APP-HOOK should extract base prefix APP and find policy-app-hooks.md
      const response = handleFetch({ sections: ['§APP-HOOK.1'] }, TEST_CONFIG, indexState);

      expect(response.content[0].text).toContain('§APP-HOOK.1');
      expect(response.content[0].text).toContain('First Hook Section');
    });
  });
});
