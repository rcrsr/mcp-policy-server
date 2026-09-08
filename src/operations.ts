/**
 * Shared policy operations
 *
 * Transport-agnostic logic reused by the MCP tool handlers, the CLI, and
 * the PreToolUse hook. Each entry point formats these results for its own
 * output channel; the behaviour lives here exactly once.
 */

import { expandRange, findEmbeddedReferences, PREFIX_ONLY_PATTERN } from './parser.js';
import { fetchSectionsWithIndex } from './resolver.js';
import { validateFromIndex, formatDuplicateErrors } from './validator.js';
import { ServerConfig } from './config.js';
import { SectionIndex, SectionNotation } from './types.js';

/**
 * Pattern extracting the prefix from a fully-qualified section id (§APP.7 → APP)
 */
const SECTION_PREFIX_PATTERN = /^§([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\./;

/**
 * Expand section notations including prefix-only shorthand
 *
 * Handles three notation types:
 * - Prefix-only (§APP): Expands to all sections with that prefix from index
 * - Range (§APP.4.1-3): Expands via expandRange()
 * - Single section (§APP.7): Returns as-is via expandRange()
 *
 * @param sections - Array of section notations to expand
 * @param index - Section index for prefix-only lookups
 * @returns Expanded array of section notations
 * @throws {Error} When a prefix-only notation matches no indexed section
 *
 * @example
 * ```typescript
 * expandSectionsWithIndex(['§FE'], index)
 * // Returns: ['§FE.1', '§FE.2', '§FE.2.1', '§FE.3']
 *
 * expandSectionsWithIndex(['§APP', '§META.2-3'], index)
 * // Returns: ['§APP.1', '§APP.2', '§META.2', '§META.3']
 * ```
 */
export function expandSectionsWithIndex(sections: string[], index: SectionIndex): string[] {
  return sections.flatMap((s) => {
    const prefixMatch = s.match(PREFIX_ONLY_PATTERN);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      const matchingSections = Array.from(index.sectionMap.keys()).filter((section) =>
        section.startsWith(`§${prefix}.`)
      );
      if (matchingSections.length === 0) {
        throw new Error(`No sections found for prefix: ${prefix}`);
      }
      return matchingSections;
    }
    return expandRange(s);
  });
}

/**
 * Extract § references from content as a unique, sorted, range-expanded list
 *
 * Applies the same fenced/inline code exclusion as findEmbeddedReferences.
 * Prefix-only references (§APP) are kept as-is since expanding them
 * requires an index.
 *
 * @param content - Text to scan
 * @returns Unique sorted section notations
 *
 * @example
 * ```typescript
 * extractReferences('See §APP.4.1-2 and §META.1, also §APP.4.1')
 * // Returns: ['§APP.4.1', '§APP.4.2', '§META.1']
 * ```
 */
export function extractReferences(content: string): SectionNotation[] {
  const references = findEmbeddedReferences(content);
  const expanded = references.flatMap((ref) => expandRange(ref));
  return Array.from(new Set(expanded)).sort();
}

/**
 * Drop specific references already covered by a prefix-only reference
 *
 * When an agent file references both §META and §META.2, the prefix-only
 * reference fetches every §META section, so §META.2 is redundant.
 * Duplicates are removed as well. Input order is preserved.
 *
 * @param references - Raw references as found in content
 * @param onSuperseded - Optional callback invoked for each dropped reference
 * @returns References with duplicates and superseded entries removed
 *
 * @example
 * ```typescript
 * dedupeSupersededReferences(['§META', '§META.2', '§APP.1', '§APP.1'])
 * // Returns: ['§META', '§APP.1']
 * ```
 */
export function dedupeSupersededReferences(
  references: string[],
  onSuperseded?: (reference: string, prefix: string) => void
): string[] {
  const unique = Array.from(new Set(references));
  const prefixOnly = new Set(unique.filter((r) => PREFIX_ONLY_PATTERN.test(r)));

  return unique.filter((ref) => {
    if (prefixOnly.has(ref)) return true;
    const prefix = ref.match(SECTION_PREFIX_PATTERN)?.[1];
    if (prefix && prefixOnly.has(`§${prefix}`)) {
      onSuperseded?.(ref, prefix);
      return false;
    }
    return true;
  });
}

/**
 * Fetch policy content for a list of references
 *
 * Expands prefix-only and range notation against the index, deduplicates,
 * sorts, then fetches with recursive § resolution.
 *
 * @param references - Section notations (any supported form)
 * @param index - Section index
 * @param baseDir - Base directory for relative file names
 * @returns Combined section content
 * @throws {Error} When a reference cannot be resolved
 */
export function fetchPoliciesForReferences(
  references: string[],
  index: SectionIndex,
  baseDir: string
): string {
  const expanded = expandSectionsWithIndex(references, index);
  const unique = Array.from(new Set(expanded)).sort() as SectionNotation[];
  return fetchSectionsWithIndex(unique, index, baseDir);
}

/**
 * Result of validating a set of references against the index
 */
export interface ReferenceValidationResult {
  /** False when any global duplicate exists or any reference is invalid */
  valid: boolean;
  /** Number of references passed in (before expansion) */
  checked: number;
  /** Expanded references that are missing or ambiguous */
  invalid: string[];
  /** Human-readable explanations, one entry per problem */
  details: string[];
}

/**
 * Validate that references exist in the index and are unique
 *
 * Reports global duplicate sections first, then checks each expanded
 * reference for ambiguity (present in duplicates) or absence.
 *
 * @param references - Section notations to validate (any supported form)
 * @param index - Section index
 * @returns Validation result
 * @throws {Error} When a prefix-only notation matches no indexed section
 */
export function validateReferences(
  references: string[],
  index: SectionIndex
): ReferenceValidationResult {
  const globalValidation = validateFromIndex(index);

  const result: ReferenceValidationResult = {
    valid: true,
    checked: references.length,
    invalid: [],
    details: [],
  };

  if (!globalValidation.valid) {
    result.valid = false;
    result.details.push('Global validation errors:');
    result.details.push(formatDuplicateErrors(globalValidation.errors ?? []));
  }

  for (const ref of expandSectionsWithIndex(references, index)) {
    const duplicateFiles = index.duplicates.get(ref);
    if (duplicateFiles) {
      result.valid = false;
      result.invalid.push(ref);
      result.details.push(
        `${ref}: Found in multiple files:\n${duplicateFiles.map((f) => `  - ${f}`).join('\n')}`
      );
      continue;
    }

    if (!index.sectionMap.has(ref)) {
      result.valid = false;
      result.invalid.push(ref);
      result.details.push(`${ref}: Section not found in policy files`);
    }
  }

  return result;
}

/**
 * List the distinct section prefixes present in the index, sorted
 *
 * @param index - Section index
 * @returns Prefixes without the § symbol (e.g. ['APP', 'APP-HOOK', 'META'])
 */
export function listPrefixes(index: SectionIndex): string[] {
  const prefixes = new Set<string>();
  for (const section of index.sectionMap.keys()) {
    const prefix = section.match(SECTION_PREFIX_PATTERN)?.[1];
    if (prefix) {
      prefixes.add(prefix);
    }
  }
  return Array.from(prefixes).sort();
}

/**
 * Format the policy source overview shown by list_sources / list-sources
 *
 * @param config - Server configuration with file list
 * @param index - Section index
 * @returns Markdown overview of files, index statistics, prefixes, and notation format
 */
export function formatSourceList(config: ServerConfig, index: SectionIndex): string {
  return `# Policy Documentation Files

${config.files.map((file) => `- ${file}`).join('\n')}

## Index Statistics

- Files indexed: ${index.fileCount}
- Sections indexed: ${index.sectionCount}
- Duplicate sections: ${index.duplicates.size}
- Last indexed: ${index.lastIndexed.toISOString()}

## Available Prefixes

${listPrefixes(index)
  .map((p) => `- §${p}`)
  .join('\n')}

## Format

Sections use § prefix: §APP.7, §SYS.5
Ranges expand: §APP.4.1-3 → §APP.4.1, §APP.4.2, §APP.4.3
`;
}
