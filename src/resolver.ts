/**
 * Section resolver - automatically resolves all § reference chains
 * Uses prebuilt section index for O(1) section lookups
 */

import * as path from 'path';
import {
  parseSectionNotation,
  extractSection,
  findEmbeddedReferences,
  expandRange,
  isParentSection,
  sortSections,
  PREFIX_ONLY_PATTERN,
} from './parser.js';
import { GatheredSection, SectionNotation, SectionIndex } from './types.js';

/**
 * Resolve section notation to file path using section index
 *
 * Looks up section in prebuilt index for O(1) access. Checks for
 * duplicate sections first and returns error if section is ambiguous.
 *
 * @param section - Section notation (§APP.7, §META.1, etc.)
 * @param index - Section index with prebuilt mappings
 * @returns Absolute file path containing the section
 * @throws {Error} When section is a duplicate or not found
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 * const filePath = resolveSection('§APP.7', index);
 * // Returns: "/absolute/path/to/policy-application.md"
 * ```
 */
export function resolveSection(section: SectionNotation, index: SectionIndex): string {
  // Check if section is a duplicate
  if (index.duplicates.has(section)) {
    const files = index.duplicates.get(section)!;
    throw new Error(
      `Section ${section} found in multiple files:\n${files.map((f) => `  - ${f}`).join('\n')}\nPlease remove duplicates to resolve this section.`
    );
  }

  // Look up section in index
  const filePath = index.sectionMap.get(section);
  if (!filePath) {
    throw new Error(`Section ${section} not found in policy files`);
  }

  return filePath;
}

/**
 * Resolve section and extract its content using section index
 *
 * Looks up section location from index, reads file, and extracts
 * section content. Combines resolution and extraction in single call.
 *
 * @param section - Section notation (§APP.7, §META.1, etc.)
 * @param index - Section index with prebuilt mappings
 * @returns Section content string
 * @throws {Error} When section not found or is duplicate
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 * const content = resolveSectionWithContent('§APP.7', index);
 * // Returns: "## {§APP.7}\n[content]"
 * ```
 */
function resolveSectionWithContent(section: SectionNotation, index: SectionIndex): string {
  // Resolve section to file path
  const filePath = resolveSection(section, index);

  // Parse section notation to extract prefix and section number
  const parsed = parseSectionNotation(section);

  // Read file and extract section content
  const content = extractSection(filePath, parsed.prefix, parsed.section);

  if (!content || content.trim().length === 0) {
    throw new Error(
      `Section "${section}" not found. Verify the section exists with marker "## {${section}}" or "### {${section}}".`
    );
  }

  return content;
}

/**
 * Recursively gather all sections including embedded references (index-based API)
 *
 * Core recursive resolution function that:
 * 1. Extracts requested sections from policy files using index
 * 2. Finds § references in extracted content
 * 3. Queues referenced sections for extraction
 * 4. Repeats until no new references found
 * 5. Removes parent-child duplicates (§APP.4 supersedes §APP.4.1)
 *
 * Returns Map with section notation as key and gathered section data
 * as value. Sections are not sorted - use sortSections on keys for ordering.
 *
 * Parent-child deduplication ensures whole sections take precedence:
 * - If §APP.4 already processed, §APP.4.1 is skipped (child of parent)
 * - If §APP.4.1 processed first, then §APP.4 added, §APP.4.1 is removed
 *
 * @param initialSections - Starting section notations (may include ranges)
 * @param index - Section index with prebuilt mappings
 * @param baseDir - Base directory for policy files
 * @param options - Optional settings: lenient mode skips unresolvable sections
 * @returns Map of section notation to gathered section data
 * @throws {Error} When section not found or is duplicate (unless lenient mode)
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 *
 * // Single section with no embedded references
 * gatherSectionsWithIndex(['§APP.7'], index, config.baseDir)
 * // Returns: Map { '§APP.7' => { prefix: 'APP', section: '7', file: '...', content: '...' } }
 *
 * // Section with embedded § reference to §META.2
 * gatherSectionsWithIndex(['§APP.7'], index, config.baseDir)
 * // Returns: Map with both §APP.7 and §META.2 entries
 *
 * // Parent-child deduplication
 * gatherSectionsWithIndex(['§APP.4', '§APP.4.1'], index, config.baseDir)
 * // Returns: Map with only §APP.4 (parent supersedes child)
 * ```
 */
export interface GatherOptions {
  /** Skip unresolvable sections instead of throwing (for hook mode) */
  lenient?: boolean;
  /** Callback for warnings in lenient mode */
  onWarning?: (message: string) => void;
}

export function gatherSectionsWithIndex(
  initialSections: string[],
  index: SectionIndex,
  baseDir: string,
  options?: GatherOptions
): Map<string, GatheredSection> {
  const { lenient = false, onWarning } = options ?? {};
  const gathered = new Map<string, GatheredSection>();
  const queue: Array<{ notation: string; referredBy: string | null }> = initialSections.map(
    (n) => ({
      notation: n,
      referredBy: null,
    })
  );
  const processed = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;

    const { notation, referredBy } = item;

    if (processed.has(notation)) continue;

    // Check if any already-processed section is a parent of this one
    let hasParent = false;
    for (const existing of Array.from(processed)) {
      if (isParentSection(existing as SectionNotation, notation as SectionNotation)) {
        hasParent = true;
        break;
      }
    }
    if (hasParent) continue;

    // Check if this section is a parent of any already-processed sections
    const childrenToRemove: string[] = [];
    for (const existing of Array.from(processed)) {
      if (isParentSection(notation as SectionNotation, existing as SectionNotation)) {
        childrenToRemove.push(existing);
      }
    }
    for (const child of childrenToRemove) {
      processed.delete(child);
      gathered.delete(child);
    }

    processed.add(notation);

    let parsed;
    try {
      parsed = parseSectionNotation(notation);
    } catch (error) {
      const refContext = referredBy ? ` (referenced by ${referredBy})` : '';
      const message = `Invalid section notation "${notation}"${refContext}: ${error instanceof Error ? error.message : String(error)}`;
      if (lenient) {
        onWarning?.(message);
        continue;
      }
      throw new Error(message);
    }

    // Resolve section using index and extract content
    let content: string;
    let filePath: string;

    try {
      filePath = resolveSection(notation as SectionNotation, index);
      content = resolveSectionWithContent(notation as SectionNotation, index);
    } catch (error) {
      const refContext = referredBy ? ` (referenced by ${referredBy})` : '';
      const message = `Failed to resolve section "${notation}"${refContext}: ${error instanceof Error ? error.message : String(error)}`;
      if (lenient) {
        onWarning?.(message);
        continue;
      }
      throw new Error(message);
    }

    // Extract relative file name from absolute path for backward compatibility
    const file = path.relative(baseDir, filePath);

    gathered.set(notation, {
      prefix: parsed.prefix,
      section: parsed.section,
      file,
      content,
    });

    // Find embedded references in extracted content
    const embedded = findEmbeddedReferences(content);
    // Expand any range or prefix-only notation in embedded references
    const expandedEmbedded = embedded.flatMap((ref) => {
      const prefixMatch = ref.match(PREFIX_ONLY_PATTERN);
      if (prefixMatch) {
        // Prefix-only reference: expand to all sections with that prefix
        const prefix = prefixMatch[1];
        return Array.from(index.sectionMap.keys()).filter((section) =>
          section.startsWith(`§${prefix}.`)
        );
      }
      return expandRange(ref);
    });
    for (const ref of expandedEmbedded) {
      if (!processed.has(ref) && !queue.some((item) => item.notation === ref)) {
        queue.push({ notation: ref, referredBy: notation });
      }
    }
  }

  return gathered;
}

/**
 * Fetch and combine sections with separators (index-based API)
 *
 * High-level function that gathers all sections (including recursive references),
 * sorts them by prefix and section number, then combines content with '---'
 * separators. Primary function for retrieving formatted policy content.
 *
 * @param sections - Section notations (may include ranges like §APP.4.1-3)
 * @param index - Section index with prebuilt mappings
 * @param baseDir - Base directory for policy files
 * @returns Combined section content with '---' separators
 * @throws {Error} When any section not found or is duplicate
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 *
 * // Single section
 * fetchSectionsWithIndex(['§APP.7'], index, config.baseDir)
 * // Returns: "## {§APP.7}\n[content]"
 *
 * // Multiple sections with separator
 * fetchSectionsWithIndex(['§APP.7', '§META.2'], index, config.baseDir)
 * // Returns: "## {§META.2}\n[content]\n---\n\n## {§APP.7}\n[content]"
 *
 * // Range notation expanded automatically
 * fetchSectionsWithIndex(['§APP.4.1-3'], index, config.baseDir)
 * // Returns: "[§APP.4.1 content]\n---\n\n[§APP.4.2 content]\n---\n\n[§APP.4.3 content]"
 * ```
 */
export function fetchSectionsWithIndex(
  sections: string[],
  index: SectionIndex,
  baseDir: string,
  options?: GatherOptions
): string {
  const gathered = gatherSectionsWithIndex(sections, index, baseDir, options);

  const sortedNotations = sortSections(Array.from(gathered.keys()) as SectionNotation[]);

  const parts: string[] = [];
  for (const notation of sortedNotations) {
    const section = gathered.get(notation);
    if (section) {
      parts.push(section.content);
    }
  }

  // Join sections without adding separators - sections already have trailing separators in the markdown
  return parts.join('\n');
}

/**
 * Resolve section locations (index-based API)
 *
 * Returns mapping of policy files to sorted section arrays. Useful for
 * understanding which sections come from which files after recursive
 * resolution completes.
 *
 * @param sections - Section notations (may include ranges)
 * @param index - Section index with prebuilt mappings
 * @param baseDir - Base directory for policy files
 * @returns Map of policy file to array of section notations (sorted)
 * @throws {Error} When any section not found or is duplicate
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 *
 * resolveSectionLocationsWithIndex(['§APP.7', '§META.2', '§APP.4'], index, config.baseDir)
 * // Returns: {
 * //   'policy-application.md': ['§APP.4', '§APP.7'],
 * //   'policy-meta.md': ['§META.2']
 * // }
 * ```
 */
export function resolveSectionLocationsWithIndex(
  sections: string[],
  index: SectionIndex,
  baseDir: string
): Record<string, string[]> {
  const gathered = gatherSectionsWithIndex(sections, index, baseDir);

  // Group by file: { file -> [notations] }
  const fileMap: Record<string, string[]> = {};
  for (const [notation, data] of Array.from(gathered.entries())) {
    if (!fileMap[data.file]) {
      fileMap[data.file] = [];
    }
    fileMap[data.file].push(notation);
  }

  // Sort files and their notation arrays
  const sortedResult: Record<string, string[]> = {};
  const sortedFiles = Object.keys(fileMap).sort();

  for (const file of sortedFiles) {
    sortedResult[file] = sortSections(fileMap[file] as SectionNotation[]);
  }

  return sortedResult;
}
