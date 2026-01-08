/**
 * Section parser for policy documentation files
 * Extracts sections from policy-*.md files with multi-character prefix support
 */

import * as fs from 'fs';
import { ParsedSection, SectionNotation } from './types';

// Regex patterns for section notation parsing
// Prefix format: starts with letter, then letters/digits/hyphens (e.g., CODE, CODE2, APP-HOOK)
const SECTION_NOTATION_PATTERN = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\.([0-9.]+)$/;
const SECTION_ID_PATTERN =
  /§([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\.(\d+(?:\.\d+)*(?:-\d+(?:\.\d+)*)?)/g;
const FULL_RANGE_PATTERN = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\.(\d+)\.(\d+)-\2\.(\d+)$/;
const SHORT_RANGE_PATTERN = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\.(\d+)\.(\d+)-(\d+)$/;
const WHOLE_SECTION_RANGE_PATTERN = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\.(\d+)-(\d+)$/;
// Only match actual section headers, not inline references
const SECTION_MARKER_PATTERN = /^##?#? \{§/;

/**
 * Pattern for prefix-only notation (§PREFIX without section number)
 * Matches: §APP, §META, §SYS, §APP-HOOK, §CODE2, etc.
 * Used to fetch all sections from a document
 */
export const PREFIX_ONLY_PATTERN = /^§([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)$/;

// Sections are sorted alphabetically by prefix, then numerically by section number

/**
 * Extract base prefix from extended prefix notation
 *
 * Hyphenated extensions (APP-HOOK, APP-PLG, etc.) are reduced to
 * their base prefix for file resolution. Base prefixes are returned
 * unchanged.
 *
 * @param prefix - Policy prefix (META, SYS, APP, USER, APP-HOOK, APP-PLG, APP-TPL, SYS-TPL)
 * @returns Base prefix without extension (APP-HOOK → APP, META → META)
 *
 * @example
 * ```typescript
 * getBasePrefix('APP-HOOK') // Returns: 'APP'
 * getBasePrefix('META')     // Returns: 'META'
 * getBasePrefix('SYS-TPL')  // Returns: 'SYS'
 * ```
 */
export function getBasePrefix(prefix: string): string {
  const hyphenIndex = prefix.indexOf('-');
  if (hyphenIndex !== -1) {
    return prefix.substring(0, hyphenIndex);
  }
  return prefix;
}

/**
 * Parse section notation into prefix, section number, and optional file
 *
 * Validates § symbol presence and section format. When fileMap provided,
 * resolves prefix to policy file. Throws on invalid notation or unknown
 * prefix.
 *
 * @param input - Section notation with § symbol (§APP.7, §META.5.2)
 * @param fileMap - Optional prefix-to-file mapping for resolution
 * @returns Parsed section with prefix, section number, and file path
 * @throws {Error} When § symbol missing or format invalid
 * @throws {Error} When prefix unknown in provided fileMap
 *
 * @example
 * ```typescript
 * // Without file resolution
 * parseSectionNotation('§APP.7')
 * // Returns: { prefix: 'APP', section: '7', file: null }
 *
 * // With file resolution
 * const fileMap = { APP: 'policy-application.md' };
 * parseSectionNotation('§APP.7', fileMap)
 * // Returns: { prefix: 'APP', section: '7', file: 'policy-application.md' }
 * ```
 */
export function parseSectionNotation(
  input: string,
  fileMap: Record<string, string> | null = null
): ParsedSection {
  if (!input.startsWith('§')) {
    throw new Error(
      `Invalid section notation: "${input}". Must start with § symbol (e.g., §APP.7, §META.5)`
    );
  }

  const withoutSymbol = input.substring(1);
  const match = withoutSymbol.match(SECTION_NOTATION_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid section notation: "${input}". Expected format: §[PREFIX].[NUMBER] (e.g., §APP.7, §META.5.2)`
    );
  }

  const [, prefix, section] = match;

  // If fileMap provided, return file from map; otherwise just return parsed data
  if (fileMap) {
    const file = fileMap[prefix];
    if (!file) {
      throw new Error(
        `Unknown prefix: ${prefix}. Valid prefixes: ${Object.keys(fileMap).join(', ')}`
      );
    }
    return { prefix, section, file };
  }

  return { prefix, section, file: null };
}

/**
 * Expand range notation to array of individual section notations
 *
 * Supports three range formats:
 * - Full form: §APP.4.1-4.3 (must repeat major version)
 * - Abbreviated: §APP.4.1-3 (assumes same major version)
 * - Whole sections: §META.2-4 (expands to §META.2, §META.3, §META.4)
 *
 * Single sections (non-range) are returned as single-element array.
 *
 * @param input - Section notation with § symbol, optionally with range
 * @returns Array of section notations (single element if not a range)
 * @throws {Error} When § symbol missing
 *
 * @example
 * ```typescript
 * expandRange('§APP.7')          // Returns: ['§APP.7']
 * expandRange('§APP.4.1-3')      // Returns: ['§APP.4.1', '§APP.4.2', '§APP.4.3']
 * expandRange('§APP.4.1-4.3')    // Returns: ['§APP.4.1', '§APP.4.2', '§APP.4.3']
 * expandRange('§META.2-4')       // Returns: ['§META.2', '§META.3', '§META.4']
 * ```
 */
export function expandRange(input: string): SectionNotation[] {
  if (!input.startsWith('§')) {
    throw new Error(
      `Invalid section notation: "${input}". Must start with § symbol (e.g., §APP.7, §APP.4.1-3)`
    );
  }

  const withoutSymbol = input.substring(1);

  // Match §APP.4.1-4.3 pattern (full form)
  const fullRangeMatch = withoutSymbol.match(FULL_RANGE_PATTERN);
  if (fullRangeMatch) {
    const [, prefix, major, start, end] = fullRangeMatch;
    const sections: SectionNotation[] = [];
    for (let i = parseInt(start, 10); i <= parseInt(end, 10); i++) {
      sections.push(`§${prefix}.${major}.${i}` as SectionNotation);
    }
    return sections;
  }

  // Match §APP.4.1-3 pattern (abbreviated form)
  const shortRangeMatch = withoutSymbol.match(SHORT_RANGE_PATTERN);
  if (shortRangeMatch) {
    const [, prefix, major, start, end] = shortRangeMatch;
    const sections: SectionNotation[] = [];
    for (let i = parseInt(start, 10); i <= parseInt(end, 10); i++) {
      sections.push(`§${prefix}.${major}.${i}` as SectionNotation);
    }
    return sections;
  }

  // Match §META.2-4 pattern (whole section ranges)
  const wholeSectionRangeMatch = withoutSymbol.match(WHOLE_SECTION_RANGE_PATTERN);
  if (wholeSectionRangeMatch) {
    const [, prefix, start, end] = wholeSectionRangeMatch;
    const sections: SectionNotation[] = [];
    for (let i = parseInt(start, 10); i <= parseInt(end, 10); i++) {
      sections.push(`§${prefix}.${i}` as SectionNotation);
    }
    return sections;
  }

  // Not a range, return as-is with § prefix
  return [input as SectionNotation];
}

/**
 * Extract section content from policy file
 *
 * Reads file and extracts content between section marker and next section
 * or end marker. Subsections stop at any § marker, whole sections stop
 * only at next whole section or {§END}.
 *
 * @param filePath - Absolute path to policy markdown file
 * @param prefix - Policy prefix (APP, META, SYS, USER, etc.)
 * @param sectionNum - Section number (7, 4.1, 2.3.1, etc.)
 * @returns Extracted section content including header
 *
 * @example
 * ```typescript
 * // Extract whole section (stops at next ## section or {§END})
 * extractSection('/path/policy-application.md', 'APP', '7')
 *
 * // Extract subsection (stops at any § marker)
 * extractSection('/path/policy-application.md', 'APP', '4.1')
 * ```
 */
export function extractSection(filePath: string, prefix: string, sectionNum: string): string {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  const isSubsection = sectionNum.includes('.');

  if (isSubsection) {
    // Subsection (§APP.4.1): stop at any next § marker
    const startPattern = new RegExp(`^###? \\{§${prefix}\\.${sectionNum.replace(/\./g, '\\.')}\\}`);
    const stopPattern = SECTION_MARKER_PATTERN;
    return extractRange(lines, startPattern, stopPattern);
  } else {
    // Whole section (§APP.4): stop at next whole section, {§END}, or EOF
    const startPattern = new RegExp(`^## \\{§${prefix}\\.${sectionNum}\\}`);
    const stopPattern = new RegExp(`^## \\{§${prefix}\\.[0-9]|^\\{§END\\}`);
    return extractRange(lines, startPattern, stopPattern);
  }
}

/**
 * Extract lines between start and stop pattern markers
 *
 * Scans line array for start pattern, collects lines until stop pattern
 * encountered or EOF reached. Start line is included in output.
 * Ignores stop patterns inside fenced code blocks.
 *
 * @param lines - Array of file lines to scan
 * @param startPattern - Regex matching section start
 * @param stopPattern - Regex matching section end
 * @returns Joined lines as single string with newlines preserved
 *
 * @internal This is a helper function for extractSection
 */
function extractRange(lines: string[], startPattern: RegExp, stopPattern: RegExp): string {
  let inRange = false;
  let inCodeBlock = false;
  const extracted: string[] = [];

  for (const line of lines) {
    if (!inRange && startPattern.test(line)) {
      inRange = true;
      extracted.push(line);
      continue;
    }

    if (inRange) {
      // Track code block state - toggle on fence markers
      if (/^```/.test(line)) {
        inCodeBlock = !inCodeBlock;
      }

      // Only stop on pattern if not inside a code block
      if (!inCodeBlock && stopPattern.test(line)) {
        break;
      }
      extracted.push(line);
    }
  }

  return extracted.join('\n');
}

/**
 * Detect code block ranges in content for exclusion from parsing
 *
 * Finds all fenced code block ranges (```...```) in content to exclude them
 * from section detection or reference parsing. Handles proper fence length
 * matching and unclosed blocks common in extracted sections.
 *
 * Opening fences can have language specifiers (```js, ````markdown).
 * Closing fences should only be backticks without language specifiers.
 *
 * @param content - Text content to scan for code blocks
 * @returns Array of {start, end} positions for each code block
 *
 * @example
 * ```typescript
 * const content = '```js\ncode\n```\ntext';
 * const ranges = detectCodeBlockRanges(content);
 * // Returns: [{start: 0, end: 15}]
 * ```
 */
export function detectCodeBlockRanges(content: string): Array<{ start: number; end: number }> {
  const codeBlockRanges: Array<{ start: number; end: number }> = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeBlockStart = -1;
  let currentPosition = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const backtickMatch = /^(`{3,})(\S*)/.exec(line);

    if (backtickMatch) {
      const hasLanguage = backtickMatch[2].length > 0;

      if (!inCodeBlock) {
        // Any fence can open a block (with or without language)
        codeBlockStart = currentPosition;
        inCodeBlock = true;
      } else if (!hasLanguage) {
        // Only fences WITHOUT language specifier can close
        codeBlockRanges.push({
          start: codeBlockStart,
          end: currentPosition,
        });
        inCodeBlock = false;
        codeBlockStart = -1;
      }
      // If inCodeBlock && hasLanguage: ignore (it's content inside the block, not a closer)
    }

    currentPosition += line.length + 1; // +1 for newline
  }

  return codeBlockRanges;
}

/**
 * Find all § references embedded in content
 *
 * Scans content for § notation and extracts all valid section references.
 * Supports ranges (§APP.4.1-3), extended prefixes (§APP-HOOK.2), and
 * prefix-only references (§TS, §PY) that fetch entire documents.
 * Returns fully qualified references with § prefix intact.
 *
 * Excludes § references inside code blocks (backticks) to avoid false
 * positives from example code.
 *
 * @param content - Text content to scan for references
 * @returns Array of section notations found (with § prefix)
 *
 * @example
 * ```typescript
 * const content = 'See §APP.7 and §META.2.3 for details';
 * findEmbeddedReferences(content)
 * // Returns: ['§APP.7', '§META.2.3']
 *
 * const rangeContent = 'Refer to §APP.4.1-3 for implementation';
 * findEmbeddedReferences(rangeContent)
 * // Returns: ['§APP.4.1-3']
 *
 * const prefixContent = 'Follow §TS and §PY policies';
 * findEmbeddedReferences(prefixContent)
 * // Returns: ['§TS', '§PY']
 *
 * const codeContent = 'Example: `§APP.7` is shown here';
 * findEmbeddedReferences(codeContent)
 * // Returns: [] (excludes references in code blocks)
 * ```
 */
export function findEmbeddedReferences(content: string): SectionNotation[] {
  const matches: SectionNotation[] = [];

  // Remove all code blocks (inline and fenced) before scanning for references
  // This prevents § references in example code from being treated as real references
  let cleanedContent = content;

  // Remove fenced code blocks with proper fence length matching
  // Process from longest to shortest to handle nested fences correctly
  // Also handles unclosed fenced blocks (common in extracted sections)
  for (let tickCount = 10; tickCount >= 3; tickCount--) {
    const ticks = '`'.repeat(tickCount);
    // Match: ```[optional-language]\n content \n``` OR ```[optional-language]\n content (until end)
    const fencePattern = new RegExp(`${ticks}[^\\n]*\\n[\\s\\S]*?(?:\\n${ticks}|$)`, 'g');
    cleanedContent = cleanedContent.replace(fencePattern, '');
  }

  // Remove inline code blocks (`...`)
  cleanedContent = cleanedContent.replace(/`[^`]*`/g, '');

  // Match section references with numbers (§APP.7, §APP.4.1-3)
  const sectionPattern = new RegExp(SECTION_ID_PATTERN.source, SECTION_ID_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = sectionPattern.exec(cleanedContent)) !== null) {
    matches.push(`§${match[1]}.${match[2]}` as SectionNotation);
  }

  // Match prefix-only references (§TS, §PY, §APP-HOOK, §CODE2)
  // Negative lookahead excludes: dot (section number), hyphen (extended prefix), word chars
  // Excludes §END which is a special end-of-section marker
  const prefixPattern = /§([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)(?![.\w-])/g;
  while ((match = prefixPattern.exec(cleanedContent)) !== null) {
    if (match[1] !== 'END') {
      matches.push(`§${match[1]}` as SectionNotation);
    }
  }

  return matches;
}

/**
 * Check if sectionA is parent of sectionB
 *
 * Tests parent-child relationship based on prefix match and section
 * number hierarchy. §APP.4 is parent of §APP.4.1, but not §APP.5.
 *
 * @param sectionA - Potential parent section (§APP.4)
 * @param sectionB - Potential child section (§APP.4.1)
 * @returns True when A is parent of B, false otherwise
 *
 * @example
 * ```typescript
 * isParentSection('§APP.4', '§APP.4.1')   // Returns: true
 * isParentSection('§APP.4', '§APP.5')     // Returns: false
 * isParentSection('§APP.4', '§META.4.1')  // Returns: false (different prefix)
 * isParentSection('§APP.4.1', '§APP.4')   // Returns: false (child cannot be parent of ancestor)
 * ```
 */
export function isParentSection(sectionA: SectionNotation, sectionB: SectionNotation): boolean {
  // Extract prefix (after §, before first .)
  const prefixA = sectionA.substring(1, sectionA.indexOf('.'));
  const prefixB = sectionB.substring(1, sectionB.indexOf('.'));

  if (prefixA !== prefixB) return false;

  return sectionB.startsWith(sectionA + '.');
}

/**
 * Sort section notations alphabetically by prefix, then numerically
 *
 * Orders sections alphabetically by prefix, then numerically within same
 * prefix. Handles multi-level section numbers (4.1.2) and extended prefixes
 * (APP-HOOK, SYS-TPL).
 *
 * @param notations - Array of section notations to sort
 * @returns Sorted array (mutates original array and returns it)
 *
 * @example
 * ```typescript
 * const sections = ['§SYS.2', '§APP.4.2', '§META.1', '§APP.4.1'];
 * sortSections(sections)
 * // Returns: ['§APP.4.1', '§APP.4.2', '§META.1', '§SYS.2']
 *
 * const withExtended = ['§APP-HOOK.2', '§APP.4', '§META.1'];
 * sortSections(withExtended)
 * // Returns: ['§APP.4', '§APP-HOOK.2', '§META.1']
 * ```
 */
export function sortSections(notations: SectionNotation[]): SectionNotation[] {
  return notations.sort((a, b) => {
    // Extract prefix (after §, before first .)
    const aPrefixEnd = a.indexOf('.');
    const bPrefixEnd = b.indexOf('.');
    const aPrefix = a.substring(1, aPrefixEnd);
    const bPrefix = b.substring(1, bPrefixEnd);

    // Compare alphabetically by prefix
    const prefixCompare = aPrefix.localeCompare(bPrefix);
    if (prefixCompare !== 0) {
      return prefixCompare;
    }

    // Same prefix - extract section numbers (everything after §PREFIX.)
    const aSection = a
      .substring(aPrefixEnd + 1)
      .split('.')
      .map(Number);
    const bSection = b
      .substring(bPrefixEnd + 1)
      .split('.')
      .map(Number);

    for (let i = 0; i < Math.max(aSection.length, bSection.length); i++) {
      const aPart = aSection[i] ?? 0;
      const bPart = bSection[i] ?? 0;

      if (aPart !== bPart) {
        return aPart - bPart;
      }
    }

    return 0;
  });
}
