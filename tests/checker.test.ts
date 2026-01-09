/**
 * Tests for checker.ts
 * Tests policy file format validation
 */

import * as path from 'path';
import { checkPolicyFile, checkPolicyContent, formatCheckResult } from '../src/checker';

// Fixture directory path (absolute)
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');
const APP_POLICY = path.join(FIXTURES_DIR, 'policy-app.md');
const SUBSECTIONS_POLICY = path.join(FIXTURES_DIR, 'policy-subsections.md');
const EXAMPLES_POLICY = path.join(FIXTURES_DIR, 'policy-with-examples.md');

describe('checker', () => {
  describe('checkPolicyContent', () => {
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
          { line: 5, severity: 'error' as const, code: 'MALFORMED_SECTION', message: 'Bad format' },
          { line: 10, severity: 'error' as const, code: 'UNCLOSED_FENCE', message: 'Not closed' },
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
          { line: 5, severity: 'error' as const, code: 'ERROR', message: 'An error' },
          { line: 10, severity: 'warning' as const, code: 'WARN', message: 'A warning' },
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
