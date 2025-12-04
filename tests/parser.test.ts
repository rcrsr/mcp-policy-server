/**
 * Comprehensive tests for parser.ts
 * Tests all 7 exported functions with >80% coverage target
 */

import * as path from 'path';
import {
  getBasePrefix,
  parseSectionNotation,
  expandRange,
  extractSection,
  findEmbeddedReferences,
  isParentSection,
  sortSections,
  PREFIX_ONLY_PATTERN,
} from '../src/parser';
import { SectionNotation } from '../src/types';

// Fixture file paths (absolute)
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');
const TEST_POLICY = path.join(FIXTURES_DIR, 'policy-test.md');
const META_POLICY = path.join(FIXTURES_DIR, 'policy-meta.md');
const HOOKS_POLICY = path.join(FIXTURES_DIR, 'policy-app-hooks.md');
const EMPTY_POLICY = path.join(FIXTURES_DIR, 'policy-empty.md');

describe('parser', () => {
  describe('getBasePrefix', () => {
    it('should return base prefix unchanged for non-hyphenated prefix', () => {
      expect(getBasePrefix('META')).toBe('META');
      expect(getBasePrefix('SYS')).toBe('SYS');
      expect(getBasePrefix('APP')).toBe('APP');
      expect(getBasePrefix('USER')).toBe('USER');
    });

    it('should extract base prefix from hyphenated prefix', () => {
      expect(getBasePrefix('APP-HOOK')).toBe('APP');
      expect(getBasePrefix('APP-PLG')).toBe('APP');
      expect(getBasePrefix('APP-TPL')).toBe('APP');
      expect(getBasePrefix('SYS-TPL')).toBe('SYS');
    });

    it('should handle multi-part hyphenated prefixes correctly', () => {
      expect(getBasePrefix('APP-HOOK-EXTRA')).toBe('APP');
      expect(getBasePrefix('SYS-CUSTOM-TEMPLATE')).toBe('SYS');
    });

    it('should return empty string for empty input', () => {
      expect(getBasePrefix('')).toBe('');
    });

    it('should handle single character prefix', () => {
      expect(getBasePrefix('A')).toBe('A');
      expect(getBasePrefix('A-B')).toBe('A');
    });
  });

  describe('parseSectionNotation', () => {
    describe('without fileMap', () => {
      it('should parse valid section notation with single number', () => {
        const result = parseSectionNotation('§APP.7');
        expect(result).toEqual({
          prefix: 'APP',
          section: '7',
          file: null,
        });
      });

      it('should parse section notation with subsection', () => {
        const result = parseSectionNotation('§META.2.3');
        expect(result).toEqual({
          prefix: 'META',
          section: '2.3',
          file: null,
        });
      });

      it('should parse section notation with deep nesting', () => {
        const result = parseSectionNotation('§SYS.1.2.3.4');
        expect(result).toEqual({
          prefix: 'SYS',
          section: '1.2.3.4',
          file: null,
        });
      });

      it('should parse hyphenated prefix notation', () => {
        const result = parseSectionNotation('§APP-HOOK.2');
        expect(result).toEqual({
          prefix: 'APP-HOOK',
          section: '2',
          file: null,
        });
      });

      it('should parse multi-hyphen prefix notation', () => {
        const result = parseSectionNotation('§APP-PLG-EXT.5');
        expect(result).toEqual({
          prefix: 'APP-PLG-EXT',
          section: '5',
          file: null,
        });
      });

      it('should throw error when § symbol is missing', () => {
        expect(() => parseSectionNotation('APP.7')).toThrow(
          'Invalid section notation: "APP.7". Must start with § symbol'
        );
      });

      it('should throw error for invalid format without section number', () => {
        expect(() => parseSectionNotation('§APP')).toThrow(
          'Invalid section notation: "§APP". Expected format: §[PREFIX].[NUMBER]'
        );
      });

      it('should throw error for lowercase prefix', () => {
        expect(() => parseSectionNotation('§app.7')).toThrow('Invalid section notation');
      });

      it('should throw error for missing prefix', () => {
        expect(() => parseSectionNotation('§.7')).toThrow('Invalid section notation');
      });

      it('should throw error for non-numeric section', () => {
        expect(() => parseSectionNotation('§APP.abc')).toThrow('Invalid section notation');
      });

      it('should throw error for empty string', () => {
        expect(() => parseSectionNotation('')).toThrow(
          'Invalid section notation: "". Must start with § symbol'
        );
      });
    });

    describe('with fileMap', () => {
      const fileMap = {
        META: 'policy-meta.md',
        SYS: 'policy-system.md',
        APP: 'policy-application.md',
        USER: 'policy-user.md',
      };

      it('should resolve file from fileMap for known prefix', () => {
        const result = parseSectionNotation('§APP.7', fileMap);
        expect(result).toEqual({
          prefix: 'APP',
          section: '7',
          file: 'policy-application.md',
        });
      });

      it('should resolve file for all defined prefixes', () => {
        expect(parseSectionNotation('§META.1', fileMap).file).toBe('policy-meta.md');
        expect(parseSectionNotation('§SYS.2', fileMap).file).toBe('policy-system.md');
        expect(parseSectionNotation('§USER.3', fileMap).file).toBe('policy-user.md');
      });

      it('should throw error for unknown prefix', () => {
        expect(() => parseSectionNotation('§UNKNOWN.7', fileMap)).toThrow(
          'Unknown prefix: UNKNOWN. Valid prefixes: META, SYS, APP, USER'
        );
      });

      it('should list available prefixes in error message', () => {
        try {
          parseSectionNotation('§XYZ.1', fileMap);
          fail('Should have thrown error');
        } catch (error) {
          expect((error as Error).message).toContain('Valid prefixes:');
          expect((error as Error).message).toContain('META');
          expect((error as Error).message).toContain('SYS');
        }
      });
    });
  });

  describe('expandRange', () => {
    describe('subsection ranges', () => {
      it('should expand abbreviated subsection range', () => {
        const result = expandRange('§APP.4.1-3');
        expect(result).toEqual(['§APP.4.1', '§APP.4.2', '§APP.4.3']);
      });

      it('should expand full-form subsection range', () => {
        const result = expandRange('§APP.4.1-4.3');
        expect(result).toEqual(['§APP.4.1', '§APP.4.2', '§APP.4.3']);
      });

      it('should expand single-element range', () => {
        const result = expandRange('§META.2.1-1');
        expect(result).toEqual(['§META.2.1']);
      });

      it('should expand multi-digit subsection range', () => {
        const result = expandRange('§SYS.10.5-8');
        expect(result).toEqual(['§SYS.10.5', '§SYS.10.6', '§SYS.10.7', '§SYS.10.8']);
      });
    });

    describe('whole section ranges', () => {
      it('should expand whole section range', () => {
        const result = expandRange('§META.2-4');
        expect(result).toEqual(['§META.2', '§META.3', '§META.4']);
      });

      it('should expand single-element whole section range', () => {
        const result = expandRange('§APP.5-5');
        expect(result).toEqual(['§APP.5']);
      });

      it('should expand large whole section range', () => {
        const result = expandRange('§USER.1-5');
        expect(result).toEqual(['§USER.1', '§USER.2', '§USER.3', '§USER.4', '§USER.5']);
      });

      it('should expand multi-digit whole section range', () => {
        const result = expandRange('§TEST.10-12');
        expect(result).toEqual(['§TEST.10', '§TEST.11', '§TEST.12']);
      });
    });

    describe('single sections (non-ranges)', () => {
      it('should return single section as array with one element', () => {
        const result = expandRange('§APP.7');
        expect(result).toEqual(['§APP.7']);
      });

      it('should return subsection as single-element array', () => {
        const result = expandRange('§META.2.3');
        expect(result).toEqual(['§META.2.3']);
      });

      it('should return deep subsection as single-element array', () => {
        const result = expandRange('§SYS.1.2.3.4');
        expect(result).toEqual(['§SYS.1.2.3.4']);
      });
    });

    describe('hyphenated prefixes', () => {
      it('should expand range with hyphenated prefix', () => {
        const result = expandRange('§APP-HOOK.2.1-3');
        expect(result).toEqual(['§APP-HOOK.2.1', '§APP-HOOK.2.2', '§APP-HOOK.2.3']);
      });

      it('should expand whole section range with hyphenated prefix', () => {
        const result = expandRange('§SYS-TPL.1-3');
        expect(result).toEqual(['§SYS-TPL.1', '§SYS-TPL.2', '§SYS-TPL.3']);
      });
    });

    describe('error cases', () => {
      it('should throw error when § symbol is missing', () => {
        expect(() => expandRange('APP.4.1-3')).toThrow(
          'Invalid section notation: "APP.4.1-3". Must start with § symbol'
        );
      });

      it('should throw error for empty string', () => {
        expect(() => expandRange('')).toThrow(
          'Invalid section notation: "". Must start with § symbol'
        );
      });
    });
  });

  describe('extractSection', () => {
    describe('whole section extraction', () => {
      it('should extract whole section from start to next section', () => {
        const content = extractSection(TEST_POLICY, 'TEST', '1');
        expect(content).toContain('## {§TEST.1} First Whole Section');
        expect(content).toContain('It spans multiple lines');
        expect(content).toContain('§TEST.2');
        expect(content).toContain('§TEST.3');
        expect(content).not.toContain('## {§TEST.2}');
      });

      it('should extract whole section with subsections included', () => {
        const content = extractSection(TEST_POLICY, 'TEST', '2');
        expect(content).toContain('## {§TEST.2} Second Whole Section');
        expect(content).toContain('### {§TEST.2.1}');
        expect(content).toContain('### {§TEST.2.2}');
        expect(content).toContain('### {§TEST.2.3}');
        expect(content).not.toContain('## {§TEST.3}');
      });

      it('should extract whole section up to END marker', () => {
        const content = extractSection(TEST_POLICY, 'TEST', '4');
        expect(content).toContain('## {§TEST.4} Fourth Section');
        expect(content).toContain('Another section for range testing');
        expect(content).not.toContain('{§END}');
      });

      it('should extract section from file with minimal content', () => {
        const content = extractSection(META_POLICY, 'META', '1');
        expect(content).toContain('## {§META.1} First Meta Section');
        expect(content).toContain('Meta section content');
        expect(content).not.toContain('## {§META.2}');
      });
    });

    describe('subsection extraction', () => {
      it('should extract subsection stopping at next section marker', () => {
        const content = extractSection(TEST_POLICY, 'TEST', '2.1');
        expect(content).toContain('### {§TEST.2.1} First Subsection');
        expect(content).toContain('Content of first subsection');
        expect(content).toContain('§TEST.2.2');
        expect(content).not.toContain('### {§TEST.2.2}');
      });

      it('should extract subsection with embedded references', () => {
        const content = extractSection(TEST_POLICY, 'TEST', '2.2');
        expect(content).toContain('### {§TEST.2.2} Second Subsection');
        expect(content).toContain('§APP.7');
        expect(content).toContain('§APP.4.1-3');
        expect(content).not.toContain('### {§TEST.2.3}');
      });

      it('should extract final subsection before next whole section', () => {
        const content = extractSection(TEST_POLICY, 'TEST', '2.3');
        expect(content).toContain('### {§TEST.2.3} Third Subsection');
        expect(content).toContain('Final subsection under TEST.2');
        expect(content).not.toContain('## {§TEST.3}');
      });

      it('should extract subsection from meta policy', () => {
        const content = extractSection(META_POLICY, 'META', '2.1');
        expect(content).toContain('### {§META.2.1} Meta Subsection');
        expect(content).toContain('Subsection content');
      });
    });

    describe('hyphenated prefix extraction', () => {
      it('should extract section with hyphenated prefix', () => {
        const content = extractSection(HOOKS_POLICY, 'APP-HOOK', '1');
        expect(content).toContain('## {§APP-HOOK.1} First Hook Section');
        expect(content).toContain('Hook section content');
        expect(content).not.toContain('## {§APP-HOOK.2}');
      });

      it('should extract section with embedded reference', () => {
        const content = extractSection(HOOKS_POLICY, 'APP-HOOK', '2');
        expect(content).toContain('## {§APP-HOOK.2} Second Hook Section');
        expect(content).toContain('§APP.7');
        expect(content).not.toContain('{§END}');
      });
    });

    describe('edge cases', () => {
      it('should return empty string for non-existent section', () => {
        const content = extractSection(TEST_POLICY, 'TEST', '99');
        expect(content).toBe('');
      });

      it('should return empty string for section in empty file', () => {
        const content = extractSection(EMPTY_POLICY, 'EMPTY', '1');
        expect(content).toBe('');
      });

      it('should handle section at end of file without END marker', () => {
        const content = extractSection(META_POLICY, 'META', '2');
        expect(content).toContain('## {§META.2} Second Meta Section');
        expect(content).toContain('### {§META.2.1}');
      });
    });

    describe('code block preservation', () => {
      it('should preserve code blocks in extracted content', () => {
        const EXAMPLES_POLICY = path.join(FIXTURES_DIR, 'policy-with-examples.md');
        const content = extractSection(EXAMPLES_POLICY, 'EX', '2');

        // Should include the section header
        expect(content).toContain('## {§EX.2} Section Two');

        // Should preserve fenced code blocks with example section markers
        expect(content).toContain('```markdown');
        expect(content).toContain('## {§EXAMPLE.1} Example Section');
        expect(content).toContain('## {§EXAMPLE.2} Another Example');
        expect(content).toContain('```');

        // Should preserve inline code with section markers
        expect(content).toContain('`{§INLINE.1}`');

        // Should preserve YAML code block
        expect(content).toContain('```yaml');
        expect(content).toContain('{§YAML.1}');
        expect(content).toContain('{§YAML.2}');
      });

      it('should preserve all content types in extracted section', () => {
        const EXAMPLES_POLICY = path.join(FIXTURES_DIR, 'policy-with-examples.md');
        const content = extractSection(EXAMPLES_POLICY, 'EX', '2');

        // Verify extraction includes actual prose
        expect(content).toContain('This section contains examples in code blocks');
        expect(content).toContain('Here are some example section headers:');
        expect(content).toContain('You can also show inline examples');
      });
    });
  });

  describe('findEmbeddedReferences', () => {
    it('should find single reference in content', () => {
      const content = 'See §APP.7 for details';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.7']);
    });

    it('should find multiple references in content', () => {
      const content = 'References §APP.7 and §META.2.3 for details';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.7', '§META.2.3']);
    });

    it('should find references with hyphenated prefixes', () => {
      const content = 'Check §APP-HOOK.2 and §SYS-TPL.1 sections';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP-HOOK.2', '§SYS-TPL.1']);
    });

    it('should find range notation', () => {
      const content = 'Refer to §APP.4.1-3 for implementation';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.4.1-3']);
    });

    it('should find whole section range notation', () => {
      const content = 'See sections §META.2-4 for overview';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§META.2-4']);
    });

    it('should find deep nested subsections', () => {
      const content = 'Detailed in §SYS.1.2.3.4 section';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§SYS.1.2.3.4']);
    });

    it('should find references across multiple lines', () => {
      const content = `First line with §APP.7 reference
      Second line with §META.1 reference
      Third line with §SYS.5 reference`;
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.7', '§META.1', '§SYS.5']);
    });

    it('should find references in markdown headers', () => {
      const content = '## {§TEST.1} Header Section\n\nContent with §APP.7';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§TEST.1', '§APP.7']);
    });

    it('should return empty array when no references found', () => {
      const content = 'This content has no section references';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual([]);
    });

    it('should return empty array for empty content', () => {
      const content = '';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual([]);
    });

    it('should ignore incomplete section markers', () => {
      const content = 'This has § symbol but not complete reference';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual([]);
    });

    it('should find multiple references of same section', () => {
      const content = '§APP.7 is important. See §APP.7 again.';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.7', '§APP.7']);
    });

    it('should handle references with punctuation', () => {
      const content = 'Check §APP.7, §META.2, and §SYS.3.';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.7', '§META.2', '§SYS.3']);
    });

    it('should exclude references inside inline code blocks', () => {
      const content = 'Example: `§APP.7` is shown here';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual([]);
    });

    it('should exclude references inside standard fenced code blocks', () => {
      const content = 'See this example:\n```\n§APP.7\n§META.2\n```\nOutside code';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual([]);
    });

    it('should exclude references inside extended fenced code blocks (4 backticks)', () => {
      const content = 'Example:\n````\n§APP.7\n```\nNested code\n```\n§META.2\n````\nOutside';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual([]);
    });

    it('should exclude references inside extended fenced code blocks (5 backticks)', () => {
      const content = 'Example:\n`````\n§APP.7\n````\nNested code\n````\n§META.2\n`````\nOutside';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual([]);
    });

    it('should find references outside code blocks but not inside', () => {
      const content = '§APP.7 is real. Code: `§META.2` and ```\n§SYS.3\n``` but §USER.4 is real.';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.7', '§USER.4']);
    });

    it('should handle multiple code blocks with references between them', () => {
      const content =
        '§APP.7 first, `§META.1` ignored, §SYS.2 found, ```§USER.3``` ignored, §APP.8 last';
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§APP.7', '§SYS.2', '§APP.8']);
    });

    it('should handle unclosed fenced code blocks (common in extracted sections)', () => {
      // This occurs when extractSection stops at next section marker before closing fence
      const content = `
### Example

\`\`\`markdown
## {§VAL.1} Section
Content with §VAL.2 reference
`;
      const refs = findEmbeddedReferences(content);
      // Should not find §VAL references since they're in unclosed fence
      expect(refs).toEqual([]);
    });

    it('should handle fenced blocks with language identifiers', () => {
      const content = `
Text before

\`\`\`typescript
const ref = "§APP.7";
\`\`\`

Text after with §META.2
`;
      const refs = findEmbeddedReferences(content);
      expect(refs).toEqual(['§META.2']); // Only real reference, not the one in code
    });

    it('should handle mismatched fence lengths correctly', () => {
      const content =
        '````\n§APP.7 inside 4-tick fence\n```\nThis closes with only 3 ticks but fence needs 4+';
      const refs = findEmbeddedReferences(content);
      // With proper fence matching, §APP.7 should be excluded
      expect(refs).toEqual([]);
    });
  });

  describe('isParentSection', () => {
    it('should return true for direct parent-child relationship', () => {
      expect(isParentSection('§APP.4' as SectionNotation, '§APP.4.1' as SectionNotation)).toBe(
        true
      );
    });

    it('should return true for nested parent-child relationship', () => {
      expect(isParentSection('§APP.4' as SectionNotation, '§APP.4.1.2' as SectionNotation)).toBe(
        true
      );
    });

    it('should return true for deep nesting', () => {
      expect(isParentSection('§SYS.1' as SectionNotation, '§SYS.1.2.3.4' as SectionNotation)).toBe(
        true
      );
    });

    it('should return false for sibling sections', () => {
      expect(isParentSection('§APP.4' as SectionNotation, '§APP.5' as SectionNotation)).toBe(false);
    });

    it('should return false for different prefixes', () => {
      expect(isParentSection('§APP.4' as SectionNotation, '§META.4.1' as SectionNotation)).toBe(
        false
      );
    });

    it('should return false when child cannot be parent of ancestor', () => {
      expect(isParentSection('§APP.4.1' as SectionNotation, '§APP.4' as SectionNotation)).toBe(
        false
      );
    });

    it('should return false for unrelated sections same prefix', () => {
      expect(isParentSection('§APP.4' as SectionNotation, '§APP.7.1' as SectionNotation)).toBe(
        false
      );
    });

    it('should return false for same section', () => {
      expect(isParentSection('§APP.4' as SectionNotation, '§APP.4' as SectionNotation)).toBe(false);
    });

    it('should handle hyphenated prefixes correctly', () => {
      expect(
        isParentSection('§APP-HOOK.2' as SectionNotation, '§APP-HOOK.2.1' as SectionNotation)
      ).toBe(true);
      expect(isParentSection('§APP-HOOK.2' as SectionNotation, '§APP.2.1' as SectionNotation)).toBe(
        false
      );
    });

    it('should return false for parent-like pattern but different prefix', () => {
      expect(isParentSection('§SYS.4' as SectionNotation, '§APP.4.1' as SectionNotation)).toBe(
        false
      );
    });

    it('should return true for intermediate parent-child', () => {
      expect(isParentSection('§APP.4.1' as SectionNotation, '§APP.4.1.2' as SectionNotation)).toBe(
        true
      );
    });
  });

  describe('sortSections', () => {
    it('should sort sections alphabetically by prefix', () => {
      const sections: SectionNotation[] = ['§USER.1', '§APP.1', '§SYS.1'];
      const sorted = sortSections(sections);
      // Alphabetical order: APP < SYS < USER
      expect(sorted).toEqual(['§APP.1', '§SYS.1', '§USER.1']);
    });

    it('should sort sections numerically within same prefix', () => {
      const sections: SectionNotation[] = ['§APP.10', '§APP.2', '§APP.1', '§APP.20'];
      const sorted = sortSections(sections);
      expect(sorted).toEqual(['§APP.1', '§APP.2', '§APP.10', '§APP.20']);
    });

    it('should sort subsections numerically', () => {
      const sections: SectionNotation[] = ['§APP.4.10', '§APP.4.2', '§APP.4.1'];
      const sorted = sortSections(sections);
      expect(sorted).toEqual(['§APP.4.1', '§APP.4.2', '§APP.4.10']);
    });

    it('should sort deeply nested subsections', () => {
      const sections: SectionNotation[] = ['§SYS.1.2.3', '§SYS.1.2.1', '§SYS.1.1.1'];
      const sorted = sortSections(sections);
      expect(sorted).toEqual(['§SYS.1.1.1', '§SYS.1.2.1', '§SYS.1.2.3']);
    });

    it('should sort whole sections before subsections of same number', () => {
      const sections: SectionNotation[] = ['§APP.4.1', '§APP.4', '§APP.4.2'];
      const sorted = sortSections(sections);
      expect(sorted).toEqual(['§APP.4', '§APP.4.1', '§APP.4.2']);
    });

    it('should handle mixed prefix types', () => {
      const sections: SectionNotation[] = ['§APP-HOOK.2', '§APP.4', '§SYS.1'];
      const sorted = sortSections(sections);
      // Alphabetical order: APP < APP-HOOK < SYS
      expect(sorted).toEqual(['§APP.4', '§APP-HOOK.2', '§SYS.1']);
    });

    it('should sort extended prefixes alphabetically', () => {
      const sections: SectionNotation[] = ['§APP-TPL.1', '§APP-PLG.1', '§APP-HOOK.1', '§APP.1'];
      const sorted = sortSections(sections);
      // Alphabetical order: APP < APP-HOOK < APP-PLG < APP-TPL
      expect(sorted).toEqual(['§APP.1', '§APP-HOOK.1', '§APP-PLG.1', '§APP-TPL.1']);
    });

    it('should handle system template prefix correctly', () => {
      const sections: SectionNotation[] = ['§APP.1', '§SYS-TPL.1', '§SYS.1'];
      const sorted = sortSections(sections);
      // Alphabetical order: APP < SYS < SYS-TPL
      expect(sorted).toEqual(['§APP.1', '§SYS.1', '§SYS-TPL.1']);
    });

    it('should return empty array for empty input', () => {
      const sections: SectionNotation[] = [];
      const sorted = sortSections(sections);
      expect(sorted).toEqual([]);
    });

    it('should handle single section', () => {
      const sections: SectionNotation[] = ['§APP.7'];
      const sorted = sortSections(sections);
      expect(sorted).toEqual(['§APP.7']);
    });

    it('should mutate original array and return it', () => {
      const sections: SectionNotation[] = ['§APP.2', '§APP.1'];
      const sorted = sortSections(sections);
      expect(sorted).toBe(sections); // Same reference
      expect(sections).toEqual(['§APP.1', '§APP.2']); // Mutated
    });

    it('should handle unknown prefix alphabetically', () => {
      const sections: SectionNotation[] = ['§APP.1', '§UNKNOWN.1', '§SYS.1'];
      const sorted = sortSections(sections);
      // Alphabetical order: APP < SYS < UNKNOWN
      expect(sorted[0]).toBe('§APP.1');
      expect(sorted[1]).toBe('§SYS.1');
      expect(sorted[2]).toBe('§UNKNOWN.1');
    });

    it('should handle complex mixed scenario', () => {
      const sections: SectionNotation[] = [
        '§USER.5',
        '§APP.4.2',
        '§APP-HOOK.2',
        '§SYS.2.1',
        '§APP.4.1',
        '§SYS-TPL.1',
      ];
      const sorted = sortSections(sections);
      // Alphabetical order: APP < APP-HOOK < SYS < SYS-TPL < USER
      expect(sorted).toEqual([
        '§APP.4.1',
        '§APP.4.2',
        '§APP-HOOK.2',
        '§SYS.2.1',
        '§SYS-TPL.1',
        '§USER.5',
      ]);
    });
  });

  describe('PREFIX_ONLY_PATTERN', () => {
    it('should match simple prefix-only notation', () => {
      expect('§APP'.match(PREFIX_ONLY_PATTERN)).toBeTruthy();
      expect('§META'.match(PREFIX_ONLY_PATTERN)).toBeTruthy();
      expect('§SYS'.match(PREFIX_ONLY_PATTERN)).toBeTruthy();
      expect('§USER'.match(PREFIX_ONLY_PATTERN)).toBeTruthy();
    });

    it('should match hyphenated prefix-only notation', () => {
      expect('§APP-HOOK'.match(PREFIX_ONLY_PATTERN)).toBeTruthy();
      expect('§SYS-TPL'.match(PREFIX_ONLY_PATTERN)).toBeTruthy();
      expect('§APP-PLG-EXT'.match(PREFIX_ONLY_PATTERN)).toBeTruthy();
    });

    it('should capture the prefix without § symbol', () => {
      const match = '§APP'.match(PREFIX_ONLY_PATTERN);
      expect(match).toBeTruthy();
      expect(match![1]).toBe('APP');

      const hyphenMatch = '§APP-HOOK'.match(PREFIX_ONLY_PATTERN);
      expect(hyphenMatch).toBeTruthy();
      expect(hyphenMatch![1]).toBe('APP-HOOK');
    });

    it('should not match section notation with numbers', () => {
      expect('§APP.7'.match(PREFIX_ONLY_PATTERN)).toBeNull();
      expect('§META.2.3'.match(PREFIX_ONLY_PATTERN)).toBeNull();
      expect('§SYS.1.2.3.4'.match(PREFIX_ONLY_PATTERN)).toBeNull();
    });

    it('should not match range notation', () => {
      expect('§APP.4.1-3'.match(PREFIX_ONLY_PATTERN)).toBeNull();
      expect('§META.2-4'.match(PREFIX_ONLY_PATTERN)).toBeNull();
    });

    it('should not match without § symbol', () => {
      expect('APP'.match(PREFIX_ONLY_PATTERN)).toBeNull();
      expect('META'.match(PREFIX_ONLY_PATTERN)).toBeNull();
    });

    it('should not match lowercase prefixes', () => {
      expect('§app'.match(PREFIX_ONLY_PATTERN)).toBeNull();
      expect('§meta'.match(PREFIX_ONLY_PATTERN)).toBeNull();
    });

    it('should not match empty prefix', () => {
      expect('§'.match(PREFIX_ONLY_PATTERN)).toBeNull();
    });

    it('should not match with trailing characters', () => {
      expect('§APP.'.match(PREFIX_ONLY_PATTERN)).toBeNull();
      expect('§APP '.match(PREFIX_ONLY_PATTERN)).toBeNull();
    });
  });
});
