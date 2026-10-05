/**
 * Tests for checker.ts
 * Tests policy file format validation
 */

import * as path from 'path';
import { parseSectionHeading } from '../src/parser';
import { checkPolicyFile, checkPolicyContent, formatCheckResult } from '../src/checker';

// Fixture directory path (absolute)
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');
const APP_POLICY = path.join(FIXTURES_DIR, 'policy-app.md');
const SUBSECTIONS_POLICY = path.join(FIXTURES_DIR, 'policy-subsections.md');
const EXAMPLES_POLICY = path.join(FIXTURES_DIR, 'policy-with-examples.md');

describe('checker', () => {
  describe('checkPolicyContent', () => {
    it('should report MALFORMED_TAG once for brackets inside the braces', () => {
      const result = checkPolicyContent('## {§PY.1} A\n\n## {§PY.2 [IMPORTANT]} B\n');

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        line: 3,
        severity: 'error',
        code: 'MALFORMED_TAG',
      });
    });

    it('should report MALFORMED_TAG for a bracketed token after the brace that is not exactly [IMPORTANT]', () => {
      for (const tag of [
        '[IMPORTANT ]',
        '[ IMPORTANT ]',
        '[important]',
        '[IMPORTANTT]',
        '[IMPORTENT]',
      ]) {
        const result = checkPolicyContent(`## {§PY.1} ${tag} Title\n`);
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({
          severity: 'error',
          code: 'MALFORMED_TAG',
        });
      }
    });

    it('should accept a bracketed title that does not read as important', () => {
      for (const title of ['[Deprecated] Title', '[link](url) Title']) {
        const result = checkPolicyContent(`## {§PY.1} ${title}\n`);
        expect(result.issues.filter((issue) => issue.code === 'MALFORMED_TAG')).toEqual([]);
        expect(result.valid).toBe(true);
      }
    });

    it('should report MALFORMED_TAG for [IMPORTANT] elsewhere in the heading', () => {
      for (const heading of [
        '## {§PY.1} Title [IMPORTANT]',
        '## {§PY.1} title [important] text',
        '## {§PY.1} [IMPORTANT] Title [IMPORTANT]',
      ]) {
        const result = checkPolicyContent(`${heading}\n`);
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({
          severity: 'error',
          code: 'MALFORMED_TAG',
        });
      }
    });

    it('should report only MALFORMED_TAG when a tag error coexists with a non-matching section id', () => {
      const result = checkPolicyContent('## {§APP.x} [important] T\n');

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        severity: 'error',
        code: 'MALFORMED_TAG',
      });
    });

    it('should accept a correctly tagged heading and still count it for numbering', () => {
      const ok = checkPolicyContent('## {§PY.1} [IMPORTANT] A\n\n### {§PY.1.1} [IMPORTANT] Sub\n');
      expect(ok.valid).toBe(true);
      expect(ok.issues).toHaveLength(0);

      const gap = checkPolicyContent('## {§PY.1} A\n\n## {§PY.3} [IMPORTANT] C\n');
      expect(gap.issues.map((i) => i.code)).toEqual(['NUMBERING_GAP']);
    });

    it.each([
      '## {§PY.1} [IMPORTANT] [PROFORMA] Title',
      '## {§PY.1} [PROFORMA] [IMPORTANT] Title',
      '## {§PY.1} [PROFORMA] Title [IMPORTANT]',
      '## {§PY.1} [IMPORTANT] Title [proforma]',
      '## {§PY.1} Title [PROFORMA]',
      '## {§PY.1} [Deprecated] [proforma]',
      '## {§PY.1} [PROFORMA] Title [PROFORMA]',
      '## {§PY.1} [proforma] Title',
      '## {§PY.1} [PROFORMA ] Title',
      '## {§PY.1} [ PROFORMA ] Title',
      '## {§PY.1} [PROFORM] Title',
      '## {§PY.1} [PROFORMAA] Title',
      '## {§PY.1} [PROFORMAAAAA] Title',
      '## {§PY.1} [PRO-FORMA] Title',
      '## {§PY.1} [Pro Forma] Title',
      '## {§PY.1}[PROFORMA] Title',
      '## {§PY.1 [PROFORMA]} Title',
    ])('should report MALFORMED_TAG once for %s', (heading) => {
      const result = checkPolicyContent(`${heading}\n`);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        severity: 'error',
        code: 'MALFORMED_TAG',
      });
    });

    it('should report exactly one issue for a doubly tagged heading under a proforma ancestor', () => {
      const result = checkPolicyContent(
        '## {§PY.1} [PROFORMA] A\n\n### {§PY.1.1} [IMPORTANT] [PROFORMA] B\n'
      );
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].code).toBe('MALFORMED_TAG');
    });

    it.each([
      '## {§PY.1} [IMPORTANT] [PROFORMA] Title',
      '## {§PY.1} [PROFORMA] [IMPORTANT] Title',
      '## {§PY.1} [PROFORMA] Title [IMPORTANT]',
      '## {§PY.1} [IMPORTANT] Title [proforma]',
      '## {§PY.1} [PROFORMA] Title [PROFORMA]',
      '## {§PY.1} [proforma] Title',
      '## {§PY.1} [PROFORMAA] Title',
      '## {§PY.1}[PROFORMA] Title',
      '## {§PY.1} [IMPORTANT] [IMPORTANT] T',
    ])('should agree with parseSectionHeading: %s is flagged and parses with no tag', (heading) => {
      const codes = checkPolicyContent(`${heading}\n`).issues.map((i) => i.code);
      expect(codes).toEqual(['MALFORMED_TAG']);
      expect(parseSectionHeading(heading)?.tag ?? null).toBeNull();
    });

    it('should name both tags for mutual exclusion and brackets inside braces', () => {
      const both = checkPolicyContent('## {§PY.1} [IMPORTANT] [PROFORMA] T\n');
      expect(both.issues[0].message).toContain('[IMPORTANT]');
      expect(both.issues[0].message).toContain('[PROFORMA]');
      expect(both.issues[0].message).toContain('mutually exclusive');

      const reversed = checkPolicyContent('## {§PY.1} [PROFORMA] [IMPORTANT] T\n');
      expect(reversed.issues[0].message).toContain('mutually exclusive');

      const inside = checkPolicyContent('## {§PY.1 [PROFORMA]} T\n');
      expect(inside.issues[0].message).toContain('[IMPORTANT]');
      expect(inside.issues[0].message).toContain('[PROFORMA]');
    });

    it('should accept proforma headings and unrelated bracketed titles', () => {
      for (const heading of [
        '## {§PY.1} [PROFORMA] T',
        '## {§PY.1} [PROFORMA]',
        '## {§PY.1} [PROFORMAAAAAA] T',
        '## {§PY.1} [Proposed] T',
        '## {§PY.1} [Professional] T',
        '## {§PY.1} [Profile] T',
        '## {§PY.1} [Deprecated] T',
        '## {§PY.1} [link](url) T',
      ]) {
        const result = checkPolicyContent(`${heading}\n`);
        expect(result.issues).toEqual([]);
        expect(result.valid).toBe(true);
      }
    });

    it('should never flag a heading the parser tags, and parse unflagged bracket titles with no tag', () => {
      expect(parseSectionHeading('## {§PY.1} [PROFORMA] T')?.tag).toBe('proforma');
      expect(parseSectionHeading('## {§PY.1} [PROFORMA]')?.tag).toBe('proforma');
      for (const heading of ['## {§PY.1} [PROFORMA] T', '## {§PY.1} [PROFORMA]']) {
        expect(checkPolicyContent(`${heading}\n`).issues).toEqual([]);
      }
      for (const heading of [
        '## {§PY.1} [Proposed] T',
        '## {§PY.1} [Professional] T',
        '## {§PY.1} [Profile] T',
        '## {§PY.1} [Deprecated] T',
        '## {§PY.1} [link](url) T',
      ]) {
        expect(parseSectionHeading(heading)?.tag ?? null).toBeNull();
      }
    });

    it('should report TAG_CONFLICT for an important heading under a proforma ancestor', () => {
      const cases = [
        {
          content: '## {§PY.1} A\n\n## {§PY.2} [PROFORMA] B\n\n### {§PY.2.1} [IMPORTANT] C\n',
          line: 5,
        },
        {
          content:
            '## {§PY.1} A\n\n## {§PY.2} [PROFORMA] B\n\n### {§PY.2.1} B1\n\n#### {§PY.2.1.1} [IMPORTANT] C\n',
          line: 7,
        },
      ];
      for (const { content, line } of cases) {
        const result = checkPolicyContent(content);
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({
          line,
          severity: 'error',
          code: 'TAG_CONFLICT',
        });
        expect(result.issues[0].message).toContain('§PY.2');
      }
      const deep = checkPolicyContent(
        '## {§PY.1} A\n\n## {§PY.2} [PROFORMA] B\n\n### {§PY.2.1} B1\n\n#### {§PY.2.1.1} [IMPORTANT] C\n'
      );
      expect(deep.issues[0].message).toContain('§PY.2.1.1');
    });

    it('should accept an important parent with a proforma child', () => {
      const result = checkPolicyContent('## {§PY.1} [IMPORTANT] A\n\n### {§PY.1.1} [PROFORMA] B\n');
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should ignore proforma conflicts inside code fences and still count numbering', () => {
      const fenced = checkPolicyContent(
        '## {§PY.1} [PROFORMA] A\n\n```md\n### {§PY.1.1} [IMPORTANT] B\n## {§PY.2} [PROFORMA ] C\n```\n'
      );
      expect(fenced.issues).toHaveLength(0);

      const gap = checkPolicyContent('## {§PY.1} A\n\n## {§PY.3} [PROFORMA] C\n');
      expect(gap.issues.map((i) => i.code)).toEqual(['NUMBERING_GAP']);
    });

    it('should ignore malformed tags inside code fences', () => {
      const result = checkPolicyContent(
        '## {§PY.1} A\n\n```md\n## {§PY.2 [IMPORTANT]} B\n## {§PY.3} [nope] C\n```\n'
      );

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should return valid for well-formed policy content', () => {
      const content = `# Application Policy

## {§APP.1} First Section

Content here.

## {§APP.2} Second Section

More content.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toBe(0);
      expect(result.warnings).toBe(0);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect malformed section headers', () => {
      const content = `# Policy

## {§APP.invalid} Bad Section

Content.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('MALFORMED_SECTION');
      expect(issue.severity).toBe('error');
      expect(issue.line).toBe(3);
    });

    it('should detect alphanumeric section numbers as malformed', () => {
      const content = `# Policy

## {§TEST.6A} Alphanumeric not allowed

## {§TEST.1.2A} Also not allowed
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(2);
      expect(result.issues.every((i) => i.code === 'MALFORMED_SECTION')).toBe(true);
    });

    it('should detect wrong heading level for whole sections', () => {
      const content = `# Policy

### {§APP.1} Should Be Level 2

Content.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('WRONG_HEADING_LEVEL');
      expect(issue.message).toContain('should use ##');
    });

    it('should detect wrong heading level for subsections', () => {
      const content = `# Policy

## {§APP.1} Parent Section

Content.

## {§APP.1.1} Should Be Level 3+

Subsection content.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('WRONG_HEADING_LEVEL');
      expect(issue.message).toContain('should use ### or deeper');
    });

    it('should detect unclosed code blocks', () => {
      const content = `# Policy

## {§APP.1} Section

\`\`\`javascript
const x = 1;
// Never closed
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('UNCLOSED_FENCE');
      expect(issue.line).toBe(5);
    });

    it('should properly handle nested code fences', () => {
      const content = `# Policy

## {§APP.1} Section

\`\`\`\`markdown
Inside we have:
\`\`\`javascript
const x = 1;
\`\`\`
\`\`\`\`

Content continues.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toBe(0);
    });

    it('should ignore section-like patterns inside code blocks', () => {
      const content = `# Policy

## {§APP.1} Real Section

\`\`\`markdown
## {§FAKE.1} This is just an example
\`\`\`

Content.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      // Should only detect §APP.1, not §FAKE.1
      expect(result.issues).toHaveLength(0);
    });

    it('should error on orphan subsections', () => {
      const content = `# Policy

### {§APP.1.1} Orphan Subsection

No parent §APP.1 exists.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('ORPHAN_SUBSECTION');
      expect(issue.severity).toBe('error');
    });

    it('should not warn about subsections with parents', () => {
      const content = `# Policy

## {§APP.1} Parent Section

Content.

### {§APP.1.1} Child Subsection

Nested content.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.warnings).toBe(0);
      expect(result.issues).toHaveLength(0);
    });

    it('should error on numbering not starting at 1', () => {
      const content = `# Policy

## {§APP.5} Starts at 5

Content.

## {§APP.6} Continues

More content.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('NUMBERING_GAP');
      expect(issue.message).toContain('start at 5 instead of 1');
    });

    it('should error on non-contiguous section numbers', () => {
      const content = `# Policy

## {§APP.1} First

Content.

## {§APP.2} Second

More content.

## {§APP.4} Fourth - skipped 3

Missing section 3.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('NUMBERING_GAP');
      expect(issue.message).toContain('missing 3 before 4');
    });

    it('should error on multiple missing section numbers', () => {
      const content = `# Policy

## {§APP.1} First

## {§APP.5} Fifth - skipped 2, 3, 4
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('NUMBERING_GAP');
      expect(issue.message).toContain('missing 2-4 before 5');
    });

    it('should error on non-contiguous subsection numbers', () => {
      const content = `# Policy

## {§APP.1} Parent

### {§APP.1.1} First

### {§APP.1.3} Third - skipped 2
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('NUMBERING_GAP');
      expect(issue.message).toContain('missing .2 before .3');
    });

    it('should warn about mixed prefixes', () => {
      const content = `# Policy

## {§APP.1} Application Section

Content.

## {§META.1} Meta Section

Different prefix.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.warnings).toBe(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('MIXED_PREFIX');
    });

    it('should allow hyphenated prefix extensions', () => {
      const content = `# Policy

## {§APP.1} Application Section

Content.

## {§APP-HOOK.1} Hook Section

Extended prefix same base.
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.warnings).toBe(0);
    });

    it('should handle empty content', () => {
      const content = '';
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toBe(0);
      expect(result.warnings).toBe(0);
    });

    it('should handle content with no sections', () => {
      const content = `# Just a Title

Some regular content without any sections.

- A list item
- Another item
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect multiple issues', () => {
      const content = `# Policy

### {§APP.1} Wrong level for whole section

\`\`\`
Unclosed block

### {§APP.1.1} Orphan subsection in code

## {§META.1} Mixed prefix
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeGreaterThan(0);
    });

    it('should sort issues by line number', () => {
      const content = `# Policy

## {§APP.5} Gap warning at line 3

### {§APP.5.1} Orphan at line 5

## {§META.1} Mixed prefix at line 7
`;
      const result = checkPolicyContent(content);

      for (let i = 1; i < result.issues.length; i++) {
        expect(result.issues[i].line).toBeGreaterThanOrEqual(result.issues[i - 1].line);
      }
    });

    it('should handle deeply nested subsections', () => {
      const content = `# Policy

## {§APP.1} Parent

Content.

### {§APP.1.1} Level 1

#### {§APP.1.1.1} Level 2

##### {§APP.1.1.1.1} Level 3
`;
      const result = checkPolicyContent(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toBe(0);
    });
  });

  describe('checkPolicyFile', () => {
    it('should detect numbering gaps in policy-app.md', () => {
      const result = checkPolicyFile(APP_POLICY);

      // policy-app.md has sections 1, 4, 7, 8 - non-contiguous
      expect(result.valid).toBe(false);
      expect(result.errors).toBe(2);
      expect(result.issues.every((i) => i.code === 'NUMBERING_GAP')).toBe(true);
    });

    it('should validate subsections policy file', () => {
      const result = checkPolicyFile(SUBSECTIONS_POLICY);

      expect(result.valid).toBe(true);
      expect(result.errors).toBe(0);
    });

    it('should detect issues in policy-with-examples.md', () => {
      const result = checkPolicyFile(EXAMPLES_POLICY);

      // This file has §EX.DESC and §EX.TOC which are malformed (text instead of numbers)
      expect(result.valid).toBe(false);
      expect(result.errors).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.code === 'MALFORMED_SECTION')).toBe(true);
    });
  });

  describe('formatCheckResult', () => {
    it('should format valid result with OK', () => {
      const result = {
        valid: true,
        errors: 0,
        warnings: 0,
        issues: [],
      };

      const formatted = formatCheckResult(result, 'policy-app.md');

      expect(formatted).toBe('✓ policy-app.md: OK');
    });

    it('should format result with errors', () => {
      const result = {
        valid: false,
        errors: 2,
        warnings: 0,
        issues: [
          {
            line: 5,
            severity: 'error' as const,
            code: 'MALFORMED_SECTION',
            message: 'Bad format',
          },
          {
            line: 10,
            severity: 'error' as const,
            code: 'UNCLOSED_FENCE',
            message: 'Not closed',
          },
        ],
      };

      const formatted = formatCheckResult(result, 'policy.md');

      expect(formatted).toContain('✗ policy.md');
      expect(formatted).toContain('Line 5');
      expect(formatted).toContain('[MALFORMED_SECTION]');
      expect(formatted).toContain('Line 10');
      expect(formatted).toContain('[UNCLOSED_FENCE]');
      expect(formatted).toContain('2 error(s), 0 warning(s)');
    });

    it('should format result with warnings only', () => {
      const result = {
        valid: true,
        errors: 0,
        warnings: 1,
        issues: [
          {
            line: 3,
            severity: 'warning' as const,
            code: 'MIXED_PREFIX',
            message: 'Mixed prefixes',
          },
        ],
      };

      const formatted = formatCheckResult(result, 'policy.md');

      expect(formatted).toContain('⚠ policy.md');
      expect(formatted).toContain('Line 3');
      expect(formatted).toContain('[MIXED_PREFIX]');
      expect(formatted).toContain('0 error(s), 1 warning(s)');
    });

    it('should use ✗ for errors and ⚠ for warnings', () => {
      const result = {
        valid: false,
        errors: 1,
        warnings: 1,
        issues: [
          {
            line: 5,
            severity: 'error' as const,
            code: 'ERROR',
            message: 'An error',
          },
          {
            line: 10,
            severity: 'warning' as const,
            code: 'WARN',
            message: 'A warning',
          },
        ],
      };

      const formatted = formatCheckResult(result, 'policy.md');
      const lines = formatted.split('\n');

      expect(lines[1]).toContain('✗');
      expect(lines[1]).toContain('Line 5');
      expect(lines[2]).toContain('⚠');
      expect(lines[2]).toContain('Line 10');
    });
  });
});
