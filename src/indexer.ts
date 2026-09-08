/**
 * Section indexing and file watching system
 * Provides fast section lookups, duplicate detection, and automatic index refresh
 */

import * as fs from 'fs';
import { ServerConfig } from './config.js';
import { SectionNotation, SectionIndex, IndexState, SectionDetail } from './types.js';
import { detectCodeBlockRanges, extractSection, findEmbeddedReferences } from './parser.js';

/**
 * Pattern for splitting a section id into prefix and section number
 * Matches the convention used elsewhere (cli.ts, index.ts) for parsing
 * fully-qualified section ids like §APP.4.1 into ('APP', '4.1')
 */
const SECTION_ID_SPLIT_PATTERN = /^§([A-Z][A-Z0-9-]*)\.(.+)$/;

/**
 * Debounce state for file change handling
 * Maps each IndexState to its pending debounce timer
 */
const rebuildDebounceTimers = new Map<IndexState, NodeJS.Timeout>();

/**
 * Debounce delay for file change events (ms)
 * Waits for file writes to complete before marking index stale
 */
const REBUILD_DEBOUNCE_MS = 300;

/**
 * Extract sections from file with error handling
 *
 * Wraps extractAllSections with standardized error handling for
 * index build operations. Logs error details and returns null
 * instead of throwing, allowing build to continue with other files.
 *
 * @param filePath - Absolute path to policy file
 * @returns Array of section IDs, or null if extraction failed
 */
function tryExtractSections(filePath: string): SectionNotation[] | null {
  try {
    return extractAllSections(filePath);
  } catch (error) {
    console.error(
      `[ERROR] Failed to extract sections from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error(`  Skipping this file in current index build`);
    return null;
  }
}

/**
 * Extract all section IDs from a policy file
 *
 * Parses markdown to find section headers matching §PREFIX.NUMBER pattern.
 * Supports both whole sections (§DOC.4) and subsections (§DOC.4.1).
 *
 * @param filePath - Absolute path to policy file
 * @returns Array of section IDs found in file
 *
 * @example
 * ```typescript
 * const sections = extractAllSections('/path/to/policy-app.md');
 * // Returns: ['§APP.1', '§APP.2', '§APP.2.1', '§APP.3']
 * ```
 */
export function extractAllSections(filePath: string): SectionNotation[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const sections: SectionNotation[] = [];

  // Find all code block ranges to exclude them from section detection
  const codeBlockRanges = detectCodeBlockRanges(content);

  // Match markdown headers containing section IDs
  // Whole sections: ## {§PREFIX.NUMBER}
  // Subsections: ### {§PREFIX.NUMBER.SUBSECTION[.SUBSECTION...]}
  const headerRegex = /^###?\s*\{(§[A-Z][A-Z0-9-]*\.\d+(?:\.\d+)*)\}/gm;

  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(content)) !== null) {
    const matchPosition = match.index;

    // Check if this match is inside a code block
    const insideCodeBlock = codeBlockRanges.some(
      (range) => matchPosition >= range.start && matchPosition < range.end
    );

    if (!insideCodeBlock) {
      sections.push(match[1]);
    }
  }

  return sections;
}

/**
 * Validate section index for duplicates
 *
 * Populates index.duplicates Map with sections appearing in multiple files.
 * Excludes duplicates from index.sectionMap.
 * Logs warnings for each duplicate with all file locations.
 *
 * @param index - Section index to validate (mutated in place)
 * @param fileSections - Per-file section lists for duplicate detection
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 * // validateIndex is called internally with fileSections
 * // Logs: [WARN] Duplicate section §APP.7 found in:
 * //         /path/file1.md
 * //         /path/file2.md
 * ```
 */
export function validateIndex(
  index: SectionIndex,
  fileSections: Map<string, SectionNotation[]>
): void {
  const allSections = new Map<SectionNotation, Set<string>>();

  // Build map of section → all files containing it (using Set to deduplicate)
  for (const [filePath, sections] of fileSections.entries()) {
    for (const section of sections) {
      if (!allSections.has(section)) {
        allSections.set(section, new Set());
      }
      allSections.get(section)!.add(filePath);
    }
  }

  // Find duplicates and update index
  for (const [section, fileSet] of allSections.entries()) {
    const files = Array.from(fileSet);
    if (files.length > 1) {
      index.duplicates.set(section, files);
      index.sectionMap.delete(section); // Remove from sectionMap

      console.error(`[WARN] Duplicate section ${section} found in:`);
      for (const file of files) {
        console.error(`  ${file}`);
      }
    } else if (fileSet.size > 1) {
      // This should never happen, but log if it does
      console.error(
        `[BUG] Section ${section} has ${fileSet.size} files in Set but array length is ${files.length}`
      );
    }
  }

  // Also warn about sections appearing multiple times in the same file
  for (const [filePath, sections] of fileSections.entries()) {
    const sectionCounts = new Map<SectionNotation, number>();
    for (const section of sections) {
      sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
    }
    for (const [section, count] of sectionCounts.entries()) {
      if (count > 1) {
        console.error(`[WARN] Section ${section} appears ${count} times in same file: ${filePath}`);
      }
    }
  }
}

/**
 * Build section index from all configured policy files
 *
 * Scans all files in config.files array and extracts section IDs.
 * Builds sectionMap and duplicates Map with fast O(1) lookups.
 * Tracks file mtimes and sizes for rebuild optimization.
 * Skips unchanged files when prevIndex provided (dual mtime+size check).
 *
 * IMPORTANT: Uses synchronous file I/O (fs.readFileSync, fs.statSync) to maintain
 * single-threaded guarantees and prevent concurrent rebuilds via rebuilding flag.
 *
 * @param config - Server configuration with file list
 * @param prevIndex - Previous section index for optimization (optional)
 * @returns Complete section index with metadata
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 * // Initial build
 *
 * const updatedIndex = buildSectionIndex(config, index);
 * // Rebuild with mtime+size optimization
 * ```
 */
export function buildSectionIndex(config: ServerConfig, prevIndex?: SectionIndex): SectionIndex {
  const startTime = Date.now();
  const sectionMap = new Map<SectionNotation, string>();
  const fileMtimes = new Map<string, Date>();
  const fileSizes = new Map<string, number>();
  const fileSections = new Map<string, SectionNotation[]>();

  let unchangedCount = 0;
  let changedCount = 0;
  let skippedCount = 0;
  let reparsedCount = 0;
  let errorCount = 0;

  // Extract previous data if available
  const prevMtimes = prevIndex?.fileMtimes;
  const prevSizes = prevIndex?.fileSizes;
  const prevFileSections = prevIndex?.fileSections;

  // Scan all files
  for (const filePath of config.files) {
    let stats: fs.Stats;

    // Wrap fs.statSync in try-catch for deleted/inaccessible files
    try {
      stats = fs.statSync(filePath);
    } catch (error) {
      console.error(
        `[ERROR] Failed to stat ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      console.error(`  File may have been deleted - skipping in this index build`);
      errorCount++;
      continue;
    }

    const currentMtime = stats.mtime;
    const currentSize = stats.size;
    fileMtimes.set(filePath, currentMtime);
    fileSizes.set(filePath, currentSize);

    let sections: SectionNotation[];

    // Check if we can skip re-parsing this file (dual mtime+size check)
    if (prevMtimes && prevSizes && prevFileSections) {
      const prevMtime = prevMtimes.get(filePath);
      const prevSize = prevSizes.get(filePath);
      const cachedSections = prevFileSections.get(filePath);

      // Both mtime and size must match for safe cache reuse
      const unchanged =
        prevMtime &&
        prevSize !== undefined &&
        cachedSections &&
        currentMtime.getTime() === prevMtime.getTime() &&
        currentSize === prevSize;

      if (unchanged) {
        unchangedCount++;
        sections = cachedSections;
        skippedCount++;
      } else {
        changedCount++;
        // File changed - re-parse with error handling
        const extracted = tryExtractSections(filePath);
        if (extracted === null) {
          errorCount++;
          continue;
        }
        sections = extracted;
        reparsedCount++;
      }
    } else {
      // Initial build - always parse with error handling
      const extracted = tryExtractSections(filePath);
      if (extracted === null) {
        errorCount++;
        continue;
      }
      sections = extracted;
      reparsedCount++;
    }

    fileSections.set(filePath, sections);

    // Simple population - no duplicate checking here
    for (const section of sections) {
      sectionMap.set(section, filePath);
    }
  }

  const buildTime = Date.now() - startTime;

  // Create index object
  const index: SectionIndex = {
    sectionMap,
    duplicates: new Map(), // Empty - will be populated by validateIndex
    fileMtimes,
    fileSections,
    fileSizes,
    lastIndexed: new Date(),
    fileCount: config.files.length,
    sectionCount: sectionMap.size,
  };

  // Pass fileSections to validator
  validateIndex(index, fileSections);

  // Log results
  if (prevIndex) {
    // Rebuild log with optimization details
    console.error(
      `[INDEX] mtime+size check: ${unchangedCount} files unchanged, ${changedCount} files changed`
    );
    console.error(
      `[INDEX] parse optimization: ${skippedCount} files skipped, ${reparsedCount} files re-parsed`
    );
    if (errorCount > 0) {
      console.error(`[INDEX] errors: ${errorCount} files failed to process`);
    }
    console.error(
      `[INDEX] Rebuilt index: ${index.fileCount} files, ${index.sectionCount} sections, ${index.duplicates.size} duplicates, ${buildTime}ms`
    );
  } else {
    // Initial build log
    console.error('Building section index...');
    console.error(`  Scanned: ${index.fileCount} files`);
    console.error(`  Indexed: ${index.sectionCount} sections`);
    console.error(`  Duplicates: ${index.duplicates.size}`);
    if (errorCount > 0) {
      console.error(`  Errors: ${errorCount} files failed to process`);
    }
    console.error(`  Build time: ${buildTime}ms`);
  }

  return index;
}

/**
 * Initialize index state with file watchers
 *
 * Builds initial section index and sets up fs.watch() for all files.
 * Attaches error handlers to watchers to prevent crashes.
 *
 * @param config - Server configuration with file list
 * @returns Index state with watchers ready
 *
 * @example
 * ```typescript
 * const state = initializeIndexState(config);
 * console.error(`Setting up file watchers for ${state.watchers.length} files...`);
 * ```
 */
export function initializeIndexState(config: ServerConfig): IndexState {
  const index = buildSectionIndex(config);

  // Create state first
  const state: IndexState = {
    index,
    stale: false,
    rebuilding: false,
    watchers: [], // Empty initially
  };

  // Then set up watchers with state reference
  for (const filePath of config.files) {
    try {
      const watcher = fs.watch(filePath, (eventType, _filename) => {
        handleFileChange(state, filePath, eventType); // Now state is defined
      });

      watcher.on('error', (error) => {
        console.error(
          `[WATCH] Watcher error for ${filePath}: ${error.message}, continuing without watching this file`
        );
      });

      state.watchers.push(watcher);
    } catch (error) {
      console.error(
        `[WATCH] Failed to watch ${filePath}: ${error instanceof Error ? error.message : String(error)}, continuing without watching this file`
      );
    }
  }

  console.error(`Setting up file watchers for ${state.watchers.length} files...`);
  return state;
}

/**
 * Close all file watchers and clean up resources
 *
 * Closes all watchers in state.watchers array and clears the array.
 * Clears any pending debounce timers to prevent memory leaks.
 * Called during server shutdown to prevent resource leaks.
 *
 * @param state - Index state with active watchers
 *
 * @example
 * ```typescript
 * process.on('SIGINT', () => {
 *   console.error('[SHUTDOWN] Received SIGINT, closing watchers...');
 *   closeIndexState(indexState);
 *   process.exit(0);
 * });
 * ```
 */
export function closeIndexState(state: IndexState): void {
  // Clear debounce timer if exists
  const timer = rebuildDebounceTimers.get(state);
  if (timer) {
    clearTimeout(timer);
    rebuildDebounceTimers.delete(state);
  }

  // Close all watchers
  for (const watcher of state.watchers) {
    try {
      watcher.close();
    } catch (error) {
      // Ignore errors during shutdown
      console.error(
        `[SHUTDOWN] Error closing watcher: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  state.watchers = [];
}

/**
 * Handle file change event from fs.watch
 *
 * Debounces file change events to handle rapid successive changes.
 * Marks index as stale after debounce period expires.
 * Actual rebuild happens lazily on next tool call.
 *
 * @param state - Index state to mark stale
 * @param filePath - Absolute path to changed file (from closure)
 * @param eventType - Event type from fs.watch ('change' or 'rename')
 *
 * @example
 * ```typescript
 * // Called by fs.watch callback
 * handleFileChange(state, '/path/to/policy-app.md', 'change');
 * // Logs: [WATCH] /path/to/policy-app.md change, scheduling rebuild
 * // After 300ms: [WATCH] Debounce period ended, index marked stale
 * ```
 */
export function handleFileChange(state: IndexState, filePath: string, eventType: string): void {
  console.error(`[WATCH] ${filePath} ${eventType}, scheduling rebuild`);
  state.stale = true;

  // Clear existing debounce timer for this state
  const existingTimer = rebuildDebounceTimers.get(state);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new debounce timer
  const timer = setTimeout(() => {
    console.error('[WATCH] Debounce period ended, index marked stale for next tool call');
    rebuildDebounceTimers.delete(state);
  }, REBUILD_DEBOUNCE_MS);

  rebuildDebounceTimers.set(state, timer);
}

/**
 * Ensure index is fresh, rebuilding if stale
 *
 * Checks stale flag and rebuilds index if needed.
 * Uses rebuilding flag to prevent concurrent rebuilds.
 * Passes previous index for mtime+size optimization.
 * Mutates state.index and returns it for convenience.
 *
 * @param state - Index state to check and potentially rebuild
 * @param config - Server configuration for rebuild
 * @returns Fresh section index (same reference as state.index)
 *
 * @example
 * ```typescript
 * // At start of tool handler
 * const index = ensureFreshIndex(state, config);
 * const file = index.sectionMap.get('§APP.7');
 * ```
 */
export function ensureFreshIndex(state: IndexState, config: ServerConfig): SectionIndex {
  if (state.stale && !state.rebuilding) {
    console.error('[INDEX] Rebuilding stale index');
    state.rebuilding = true;
    try {
      // Rebuild with mtime+size optimization - pass previous index
      state.index = buildSectionIndex(config, state.index);
      state.stale = false;
    } finally {
      state.rebuilding = false;
    }
  }
  return state.index;
}

/**
 * Build per-section detail records for list-sections output
 *
 * Iterates the canonical (non-duplicate) sections in index.sectionMap,
 * extracts each section's content, and computes its outbound § references
 * using the same fence/inline-code exclusion findEmbeddedReferences applies.
 *
 * @param index - Section index to build details from
 * @returns Array of section detail records sorted by section id
 *
 * @example
 * ```typescript
 * const index = buildSectionIndex(config);
 * const details = buildSectionDetails(index);
 * // Returns: [{ id: '§APP.1', prefix: 'APP', file: '/path/policy-app.md',
 * //             byteLength: 123, refs: ['§META.2'] }, ...]
 * ```
 */
export function buildSectionDetails(index: SectionIndex): SectionDetail[] {
  const details: SectionDetail[] = [];

  for (const [id, filePath] of index.sectionMap.entries()) {
    const match = SECTION_ID_SPLIT_PATTERN.exec(id);
    if (!match) {
      console.error(`[ERROR] Section id ${id} does not match expected §PREFIX.NUMBER format`);
      console.error(`  Skipping this section in list-sections output`);
      continue;
    }

    const [, prefix, sectionNum] = match;

    try {
      const content = extractSection(filePath, prefix, sectionNum);
      const byteLength = Buffer.byteLength(content, 'utf8');
      const refs = Array.from(new Set(findEmbeddedReferences(content))).sort();

      details.push({ id, prefix, file: filePath, byteLength, refs });
    } catch (error) {
      console.error(
        `[ERROR] Failed to extract section ${id} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      console.error(`  Skipping this section in list-sections output`);
    }
  }

  return details.sort((a, b) => a.id.localeCompare(b.id));
}
