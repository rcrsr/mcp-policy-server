/**
 * MCP tool request handlers
 * Implements all tool handlers with chunking logic for large responses
 */

import * as fs from 'fs';
import { expandRange, findEmbeddedReferences, PREFIX_ONLY_PATTERN } from './parser.js';
import { fetchSectionsWithIndex, resolveSectionLocationsWithIndex } from './resolver.js';
import { validateFromIndex, formatDuplicateErrors } from './validator.js';
import { ServerConfig } from './config.js';
import { ensureFreshIndex } from './indexer.js';
import { IndexState, SectionIndex } from './types.js';

/**
 * Validate that array parameter is non-empty
 *
 * @param arr - Array to validate
 * @param paramName - Parameter name for error message
 * @throws {Error} If array is empty
 */
function validateNonEmptyArray(arr: unknown[], paramName: string): void {
  if (arr.length === 0) {
    throw new Error(`${paramName} parameter must be a non-empty array`);
  }
}

/**
 * Tool argument interfaces for type safety
 */
interface FetchArgs {
  sections: string[];
  continuation?: string | null;
}

interface ResolveReferencesArgs {
  sections: string[];
}

interface ExtractReferencesArgs {
  file_path: string;
}

interface ValidateReferencesArgs {
  references: string[];
}

/**
 * Type guard for FetchArgs
 */
function isFetchArgs(args: unknown): args is FetchArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    'sections' in args &&
    Array.isArray((args as FetchArgs).sections)
  );
}

/**
 * Type guard for ResolveReferencesArgs
 */
function isResolveReferencesArgs(args: unknown): args is ResolveReferencesArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    'sections' in args &&
    Array.isArray((args as ResolveReferencesArgs).sections)
  );
}

/**
 * Type guard for ExtractReferencesArgs
 */
function isExtractReferencesArgs(args: unknown): args is ExtractReferencesArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    'file_path' in args &&
    typeof (args as ExtractReferencesArgs).file_path === 'string'
  );
}

/**
 * Type guard for ValidateReferencesArgs
 */
function isValidateReferencesArgs(args: unknown): args is ValidateReferencesArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    'references' in args &&
    Array.isArray((args as ValidateReferencesArgs).references)
  );
}

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
 *
 * @example
 * ```typescript
 * // Prefix-only expands to all matching sections
 * expandSectionsWithIndex(['§FE'], index)
 * // Returns: ['§FE.1', '§FE.2', '§FE.2.1', '§FE.3']
 *
 * // Mixed notation types
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
 * Chunk result structure
 *
 * Represents a single chunk of content from a large response.
 * Contains continuation token for retrieving subsequent chunks.
 */
interface ChunkResult {
  /** Content for this chunk */
  content: string;
  /** Whether more chunks are available */
  hasMore: boolean;
  /** Continuation token for next chunk, null if last chunk */
  continuation: string | null;
}

/**
 * MCP tool response structure
 *
 * Standard response format for all tool handlers.
 * Contains array of content blocks with type and text.
 * Index signature required for MCP SDK compatibility.
 */
interface ToolResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  [key: string]: unknown;
}

/**
 * Estimate token count from text
 *
 * Rough approximation: 1 token ≈ 4 characters.
 * Used for chunking decisions only, not exact tokenization.
 *
 * @param text - Text to estimate tokens for
 * @returns Approximate token count
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split content into chunks at section boundaries
 *
 * Splits large content to stay within token limits while keeping
 * sections intact. Uses section headers as split points to avoid
 * breaking sections mid-content.
 *
 * @param content - Full content to chunk
 * @param maxTokens - Maximum tokens per chunk (default 10000)
 * @returns Array of chunk results with continuation tokens
 *
 * @example
 * ```typescript
 * const chunks = chunkContent(largeContent, 10000);
 * console.log(`Split into ${chunks.length} chunks`);
 * console.log(`Next token: ${chunks[0].continuation}`);
 * ```
 */
export function chunkContent(content: string, maxTokens: number = 10000): ChunkResult[] {
  const estimatedTokens = estimateTokens(content);

  console.error(
    `[DEBUG] chunkContent: total content ~${estimatedTokens} tokens, maxTokens=${maxTokens}`
  );

  if (estimatedTokens <= maxTokens) {
    console.error(`[DEBUG] chunkContent: fits in single chunk`);
    return [{ content, hasMore: false, continuation: null }];
  }

  // Split by section boundaries to keep sections intact
  const sectionPattern = /^## \{§[A-Z]+(?:-[A-Z]+)*\.\d+(?:\.\d+)?\}/gm;
  const sections: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sectionPattern.exec(content)) !== null) {
    if (lastIndex < match.index) {
      sections.push(content.substring(lastIndex, match.index));
    }
    lastIndex = match.index;
  }

  // Add remaining content
  if (lastIndex < content.length) {
    sections.push(content.substring(lastIndex));
  }

  // Group sections into chunks under token limit
  const chunks: ChunkResult[] = [];
  let currentChunk = '';

  for (const section of sections) {
    const sectionTokens = estimateTokens(section);
    const currentTokens = estimateTokens(currentChunk);

    if (currentTokens + sectionTokens > maxTokens && currentChunk) {
      // Save current chunk and start new one
      chunks.push({
        content: currentChunk,
        hasMore: true,
        continuation: `chunk:${chunks.length + 1}`,
      });
      currentChunk = section;
    } else {
      currentChunk += section;
    }
  }

  // Add final chunk
  if (currentChunk) {
    chunks.push({
      content: currentChunk,
      hasMore: false,
      continuation: null,
    });
  }

  console.error(`[DEBUG] chunkContent: created ${chunks.length} chunks`);
  chunks.forEach((c, i) => {
    console.error(
      `[DEBUG]   Chunk ${i}: ~${estimateTokens(c.content)} tokens, hasMore=${c.hasMore}, continuation=${c.continuation}`
    );
  });

  return chunks;
}

/**
 * Handle fetch tool request
 *
 * Fetches policy sections with automatic recursive resolution of
 * embedded § references. Supports range notation and automatic
 * chunking for large responses.
 *
 * @param args - Tool arguments containing sections array and optional continuation token
 * @param config - Server configuration with policy mappings
 * @param indexState - Index state for section lookups
 * @returns Tool response with section content or chunk
 * @throws Error if sections parameter is invalid or continuation token is invalid
 *
 * @example
 * ```typescript
 * // Initial request
 * const response = handleFetch(
 *   { sections: ['§APP.7', '§SYS.5'] },
 *   config,
 *   indexState
 * );
 *
 * // Continuation request
 * const nextChunk = handleFetch(
 *   { sections: ['§APP.7', '§SYS.5'], continuation: 'chunk:1' },
 *   config,
 *   indexState
 * );
 * ```
 */
export function handleFetch(
  args: unknown,
  config: ServerConfig,
  indexState: IndexState
): ToolResponse {
  if (!isFetchArgs(args)) {
    throw new Error('Invalid arguments: expected { sections: string[], continuation?: string }');
  }

  const { sections, continuation = null } = args;

  validateNonEmptyArray(sections, 'sections');

  // Ensure index is fresh (lazy rebuild if files changed)
  const index = ensureFreshIndex(indexState, config);

  // Expand prefix-only notation and ranges
  const expandedSections = expandSectionsWithIndex(sections, index);

  try {
    const fullContent = fetchSectionsWithIndex(expandedSections, index, config.baseDir);
    const chunks = chunkContent(fullContent, config.maxChunkTokens);

    // Debug logging
    console.error(`[DEBUG] fetch: generated ${chunks.length} chunks`);
    console.error(`[DEBUG] continuation token: ${continuation ?? 'none'}`);

    // Determine which chunk to return
    let chunkIndex = 0;
    if (continuation?.startsWith('chunk:')) {
      chunkIndex = parseInt(continuation.split(':')[1], 10);
      console.error(`[DEBUG] parsed continuation: requesting chunk index ${chunkIndex}`);
    }

    if (chunkIndex >= chunks.length) {
      console.error(`[DEBUG] ERROR: chunkIndex ${chunkIndex} >= chunks.length ${chunks.length}`);
      console.error(
        `[DEBUG] Chunk continuations: ${chunks.map((c, i) => `[${i}]="${c.continuation}"`).join(', ')}`
      );
      throw new Error(
        `Invalid continuation token: ${continuation} (requested chunk ${chunkIndex} but only ${chunks.length} chunks exist)`
      );
    }

    const chunk = chunks[chunkIndex];

    // Remove trailing divider and whitespace from chunk content before adding continuation
    let content = chunk.content;
    if (chunk.hasMore) {
      // Remove trailing --- divider and surrounding whitespace
      content = content.replace(/\n*---\n*\s*$/, '').trimEnd();
    }

    const response: ToolResponse = {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };

    // Add metadata about chunking
    if (chunk.hasMore) {
      response.content.push({
        type: 'text',
        text: `\n\n---\n**CRITICAL: INCOMPLETE RESPONSE - MANDATORY CONTINUATION REQUIRED**\n\nCall fetch again with: sections=${JSON.stringify(sections)}, continuation="${chunk.continuation}"`,
      });
    }

    return response;
  } catch (error) {
    throw new Error(
      `Failed to fetch sections: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Handle resolve_references tool request
 *
 * Resolves section locations with automatic recursive resolution.
 * Returns map of policy file to sorted array of section IDs.
 *
 * @param args - Tool arguments containing sections array
 * @param config - Server configuration with policy mappings
 * @param indexState - Index state for section lookups
 * @returns Tool response with file-to-sections mapping as JSON
 * @throws Error if sections parameter is invalid
 *
 * @example
 * ```typescript
 * const response = handleResolveReferences(
 *   { sections: ['§APP.7', '§SYS.5'] },
 *   config,
 *   indexState
 * );
 * // Returns: {"policy-application.md": ["§APP.7"], "policy-system.md": ["§SYS.5"]}
 * ```
 */
export function handleResolveReferences(
  args: unknown,
  config: ServerConfig,
  indexState: IndexState
): ToolResponse {
  if (!isResolveReferencesArgs(args)) {
    throw new Error('Invalid arguments: expected { sections: string[] }');
  }

  const { sections } = args;

  validateNonEmptyArray(sections, 'sections');

  // Ensure index is fresh (lazy rebuild if files changed)
  const index = ensureFreshIndex(indexState, config);

  // Expand prefix-only notation and ranges
  const expandedSections = expandSectionsWithIndex(sections, index);

  try {
    const locations = resolveSectionLocationsWithIndex(expandedSections, index, config.baseDir);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(locations, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new Error(
      `Failed to resolve section locations: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Handle extract_references tool request
 *
 * Extracts all § references from a file. Expands ranges and
 * returns unique sorted array of section notations.
 *
 * @param args - Tool arguments containing file_path
 * @param _config - Server configuration (unused but kept for consistency)
 * @returns Tool response with extracted references as JSON array
 * @throws Error if file_path is missing or file cannot be read
 *
 * @example
 * ```typescript
 * const response = handleExtractReferences(
 *   { file_path: '/path/to/agent.md' },
 *   config
 * );
 * // Returns: ["§APP.7", "§SYS.5", "§META.1"]
 * ```
 */
export function handleExtractReferences(args: unknown, _config: ServerConfig): ToolResponse {
  if (!isExtractReferencesArgs(args)) {
    throw new Error('Invalid arguments: expected { file_path: string }');
  }

  const { file_path } = args;

  try {
    // Read file content
    const content = fs.readFileSync(file_path, 'utf8');

    // Extract all § references
    const references = findEmbeddedReferences(content);

    // Expand ranges before returning
    const expandedRefs = references.flatMap((ref: string) => expandRange(ref));

    // Return unique references, sorted
    const uniqueRefs = Array.from(new Set(expandedRefs)).sort();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(uniqueRefs, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new Error(
      `Failed to extract references from file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Handle validate_references tool request
 *
 * Validates that policy section references exist and are unique.
 * Checks each reference against policy files and reports invalid
 * or duplicate sections.
 *
 * @param args - Tool arguments containing references array
 * @param config - Server configuration with policy mappings
 * @param indexState - Index state for section lookups
 * @returns Tool response with validation result as JSON
 * @throws Error if references parameter is invalid
 *
 * @example
 * ```typescript
 * const response = handleValidateReferences(
 *   { references: ['§APP.7', '§SYS.5'] },
 *   config,
 *   indexState
 * );
 * // Returns: {valid: true, checked: 2, invalid: [], details: []}
 * ```
 */
export function handleValidateReferences(
  args: unknown,
  config: ServerConfig,
  indexState: IndexState
): ToolResponse {
  if (!isValidateReferencesArgs(args)) {
    throw new Error('Invalid arguments: expected { references: string[] }');
  }

  const { references } = args;

  validateNonEmptyArray(references, 'references');

  // Ensure index is fresh (lazy rebuild if files changed)
  const index = ensureFreshIndex(indexState, config);

  try {
    // Validate section uniqueness using index
    const validationResult = validateFromIndex(index);

    const result = {
      valid: true,
      checked: references.length,
      invalid: [] as string[],
      details: [] as string[],
    };

    // Check if there are duplicate sections globally
    if (!validationResult.valid) {
      result.valid = false;
      result.details.push('Global validation errors:');
      result.details.push(formatDuplicateErrors(validationResult.errors ?? []));
    }

    // Check each reference exists
    const expandedRefs = expandSectionsWithIndex(references, index);
    for (const ref of expandedRefs) {
      // Check if section is in duplicates map (error case)
      if (index.duplicates.has(ref)) {
        result.valid = false;
        result.invalid.push(ref);
        const files = index.duplicates.get(ref)!;
        result.details.push(
          `${ref}: Found in multiple files:\n${files.map((f) => `  - ${f}`).join('\n')}`
        );
        continue;
      }

      // Check if section exists in sectionMap
      if (!index.sectionMap.has(ref)) {
        result.valid = false;
        result.invalid.push(ref);
        result.details.push(`${ref}: Section not found in policy files`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new Error(
      `Failed to validate references: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Handle list_sources tool request
 *
 * Lists all available policy documentation files with usage examples.
 *
 * @param _args - Tool arguments (unused)
 * @param config - Server configuration with file list
 * @param indexState - Index state for section lookups
 * @returns Tool response with formatted source list
 *
 * @example
 * ```typescript
 * const response = handleListSources({}, config, indexState);
 * // Returns formatted markdown with all available sources
 * ```
 */
export function handleListSources(
  _args: unknown,
  config: ServerConfig,
  indexState: IndexState
): ToolResponse {
  // Ensure index is fresh (lazy rebuild if files changed)
  const index = ensureFreshIndex(indexState, config);

  const sourceList = `# Policy Documentation Files

${config.files.map((file) => `- ${file}`).join('\n')}

## Index Statistics

- Files indexed: ${index.fileCount}
- Sections indexed: ${index.sectionCount}
- Duplicate sections: ${index.duplicates.size}
- Last indexed: ${index.lastIndexed.toISOString()}

## Format

Sections use § prefix: §APP.7, §SYS.5
Ranges expand: §APP.4.1-3 → §APP.4.1, §APP.4.2, §APP.4.3
`;

  return {
    content: [
      {
        type: 'text',
        text: sourceList,
      },
    ],
  };
}
