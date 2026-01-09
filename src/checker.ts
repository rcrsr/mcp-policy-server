/**
 * Policy file format checker
 * Validates structure, sections, numbering, and code fence matching
 */

import * as fs from 'fs';
import { CheckIssue, CheckResult } from './types.js';

// Section header pattern: ## {§PREFIX.NUMBER} or ### {§PREFIX.NUMBER.SUBSECTION}
const SECTION_HEADER_PATTERN =
  /^(#{2,})\s*\{§([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\.(\d+(?:\.\d+)*)\}/;

// Malformed section header (has § but wrong format)
const MALFORMED_SECTION_PATTERN = /^(#{2,})\s*\{§/;

// Code fence pattern (captures backtick count and optional language)
const CODE_FENCE_PATTERN = /^(`{3,})(\S*)/;

/**
 * Check a policy file for format issues
 *
 * Validates:
 * - Section header format ({§PREFIX.NUMBER})
 * - Section numbering consistency
 * - Code fence matching (all opened blocks are closed)
 * - Heading level appropriateness (## for whole sections, ### for subsections)
 * - Orphan subsections (subsections without parent)
 *
 * @param filePath - Absolute path to policy markdown file
 * @returns Check result with issues and statistics
 *
 * @example
 * ```typescript
 * const result = checkPolicyFile('/path/to/policy-app.md');
 * if (!result.valid) {
 *   console.error('Format errors found:', result.errors);
 * }
 * ```
 */
export function checkPolicyFile(filePath: string): CheckResult {
  const content = fs.readFileSync(filePath, 'utf8');
  return checkPolicyContent(content);
}

/**
 * Check policy content string for format issues
 *
 * @param content - Policy file content as string
 * @returns Check result with issues and statistics
 */
export function checkPolicyContent(content: string): CheckResult {
  const issues: CheckIssue[] = [];
  const lines = content.split('\n');

  // Track state
  let inCodeBlock = false;
  let codeBlockStartLine = 0;
  let codeBlockFenceLength = 0;
  const sections: Array<{ line: number; prefix: string; number: string; depth: number }> = [];
  let detectedPrefix: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Check for code fence
    const fenceMatch = line.match(CODE_FENCE_PATTERN);
    if (fenceMatch) {
      const fenceLength = fenceMatch[1].length;
      const hasLanguage = fenceMatch[2].length > 0;

      if (!inCodeBlock) {
        // Opening fence
        inCodeBlock = true;
        codeBlockStartLine = lineNum;
        codeBlockFenceLength = fenceLength;
      } else if (!hasLanguage && fenceLength >= codeBlockFenceLength) {
        // Closing fence (must not have language specifier and be at least as long)
        inCodeBlock = false;
        codeBlockStartLine = 0;
        codeBlockFenceLength = 0;
      }
      continue;
    }

    // Skip content inside code blocks
    if (inCodeBlock) {
      continue;
    }

    // Check for malformed section headers
    const malformedMatch = line.match(MALFORMED_SECTION_PATTERN);
    if (malformedMatch && !line.match(SECTION_HEADER_PATTERN)) {
      issues.push({
        line: lineNum,
        severity: 'error',
        code: 'MALFORMED_SECTION',
        message: `Malformed section header. Expected format: ## {§PREFIX.NUMBER} or ### {§PREFIX.N.M}`,
      });
      continue;
    }

    // Check for valid section headers
    const sectionMatch = line.match(SECTION_HEADER_PATTERN);
    if (sectionMatch) {
      const [, hashes, prefix, number] = sectionMatch;
      const depth = hashes.length;
      const numberParts = number.split('.').map(Number);
      const isSubsection = numberParts.length > 1;

      // Track first detected prefix for consistency check
      // Extract base prefix (before hyphen)
      detectedPrefix ??= prefix.split('-')[0];

      // Check prefix consistency (base prefix should match)
      const basePrefix = prefix.split('-')[0];
      if (basePrefix !== detectedPrefix) {
        issues.push({
          line: lineNum,
          severity: 'warning',
          code: 'MIXED_PREFIX',
          message: `Mixed prefixes in file: ${prefix} (expected ${detectedPrefix} or ${detectedPrefix}-*)`,
        });
      }

      // Check heading level matches section type
      if (!isSubsection && depth !== 2) {
        issues.push({
          line: lineNum,
          severity: 'error',
          code: 'WRONG_HEADING_LEVEL',
          message: `Whole section §${prefix}.${number} should use ## (level 2), found ${'#'.repeat(depth)} (level ${depth})`,
        });
      } else if (isSubsection && depth < 3) {
        issues.push({
          line: lineNum,
          severity: 'error',
          code: 'WRONG_HEADING_LEVEL',
          message: `Subsection §${prefix}.${number} should use ### or deeper (level 3+), found ${'#'.repeat(depth)} (level ${depth})`,
        });
      }

      sections.push({ line: lineNum, prefix, number, depth });
    }
  }

  // Check for unclosed code blocks
  if (inCodeBlock) {
    issues.push({
      line: codeBlockStartLine,
      severity: 'error',
      code: 'UNCLOSED_FENCE',
      message: `Code block opened at line ${codeBlockStartLine} is never closed`,
    });
  }

  // Check for orphan subsections (subsection without parent)
  checkOrphanSubsections(sections, issues);

  // Check for non-sequential numbering (warning only)
  checkNumberingSequence(sections, issues);

  // Sort issues by line number
  issues.sort((a, b) => a.line - b.line);

  // Calculate counts
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  return {
    valid: errors === 0,
    errors,
    warnings,
    issues,
  };
}

/**
 * Check for orphan subsections (subsection without parent whole section)
 */
function checkOrphanSubsections(
  sections: Array<{ line: number; prefix: string; number: string; depth: number }>,
  issues: CheckIssue[]
): void {
  const wholeSections = new Set<string>();

  // First pass: collect all whole sections
  for (const section of sections) {
    const parts = section.number.split('.');
    if (parts.length === 1) {
      wholeSections.add(`${section.prefix}.${section.number}`);
    }
  }

  // Second pass: check subsections have parents
  for (const section of sections) {
    const parts = section.number.split('.');
    if (parts.length > 1) {
      const parentKey = `${section.prefix}.${parts[0]}`;
      if (!wholeSections.has(parentKey)) {
        issues.push({
          line: section.line,
          severity: 'error',
          code: 'ORPHAN_SUBSECTION',
          message: `Subsection §${section.prefix}.${section.number} has no parent section §${parentKey}`,
        });
      }
    }
  }
}

/**
 * Check for non-sequential section numbering
 */
function checkNumberingSequence(
  sections: Array<{ line: number; prefix: string; number: string; depth: number }>,
  issues: CheckIssue[]
): void {
  // Group by prefix and parent
  const wholeSectionsByPrefix = new Map<string, number[]>();
  const subsectionsByParent = new Map<string, Array<{ line: number; subNum: number }>>();

  for (const section of sections) {
    const parts = section.number.split('.').map(Number);

    if (parts.length === 1) {
      // Whole section
      const nums = wholeSectionsByPrefix.get(section.prefix) ?? [];
      nums.push(parts[0]);
      wholeSectionsByPrefix.set(section.prefix, nums);
    } else if (parts.length === 2) {
      // First-level subsection only (e.g., §APP.1.1, not §APP.1.1.1)
      const parentKey = `${section.prefix}.${parts[0]}`;
      const subs = subsectionsByParent.get(parentKey) ?? [];
      subs.push({ line: section.line, subNum: parts[1] });
      subsectionsByParent.set(parentKey, subs);
    }
    // Deeper subsections (§APP.1.1.1, etc.) are not checked for sequential numbering
  }

  // Check whole section sequence
  for (const [prefix, nums] of wholeSectionsByPrefix) {
    const sorted = [...nums].sort((a, b) => a - b);
    if (sorted.length === 0) continue;

    // Check if starts at 1
    if (sorted[0] !== 1) {
      const firstSection = sections.find(
        (s) => s.prefix === prefix && s.number === String(sorted[0])
      );
      if (firstSection) {
        issues.push({
          line: firstSection.line,
          severity: 'error',
          code: 'NUMBERING_GAP',
          message: `Sections for §${prefix} start at ${sorted[0]} instead of 1`,
        });
      }
    }

    // Check for gaps between consecutive numbers
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (curr !== prev + 1) {
        const currSection = sections.find((s) => s.prefix === prefix && s.number === String(curr));
        if (currSection) {
          const missing = curr - prev === 2 ? String(prev + 1) : `${prev + 1}-${curr - 1}`;
          issues.push({
            line: currSection.line,
            severity: 'error',
            code: 'NUMBERING_GAP',
            message: `Gap in §${prefix} numbering: missing ${missing} before ${curr}`,
          });
        }
      }
    }
  }

  // Check subsection sequence
  for (const [parentKey, subs] of subsectionsByParent) {
    const sorted = [...subs].sort((a, b) => a.subNum - b.subNum);
    if (sorted.length === 0) continue;

    // Check if starts at 1
    if (sorted[0].subNum !== 1) {
      issues.push({
        line: sorted[0].line,
        severity: 'error',
        code: 'NUMBERING_GAP',
        message: `Subsections under §${parentKey} start at .${sorted[0].subNum} instead of .1`,
      });
    }

    // Check for gaps between consecutive subsection numbers
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].subNum;
      const curr = sorted[i].subNum;
      if (curr !== prev + 1) {
        const missing = curr - prev === 2 ? String(prev + 1) : `${prev + 1}-${curr - 1}`;
        issues.push({
          line: sorted[i].line,
          severity: 'error',
          code: 'NUMBERING_GAP',
          message: `Gap in §${parentKey} subsections: missing .${missing} before .${curr}`,
        });
      }
    }
  }
}

/**
 * Format check result for human-readable output
 *
 * @param result - Check result to format
 * @param filePath - File path for display
 * @returns Formatted string with all issues
 */
export function formatCheckResult(result: CheckResult, filePath: string): string {
  const lines: string[] = [];

  if (result.valid && result.warnings === 0) {
    lines.push(`✓ ${filePath}: OK`);
    return lines.join('\n');
  }

  lines.push(`${result.valid ? '⚠' : '✗'} ${filePath}`);

  for (const issue of result.issues) {
    const icon = issue.severity === 'error' ? '  ✗' : '  ⚠';
    lines.push(`${icon} Line ${issue.line}: [${issue.code}] ${issue.message}`);
  }

  lines.push('');
  lines.push(`  ${result.errors} error(s), ${result.warnings} warning(s)`);

  return lines.join('\n');
}
