/**
 * Core type definitions for policy server
 * Defines interfaces, types, and error classes used throughout the system
 */

import * as fs from 'fs';

/**
 * Parsed section notation without file resolution
 *
 * Represents a section reference that has been parsed but not yet
 * resolved to a specific policy file. The file property is null
 * until resolution occurs via configuration lookup.
 *
 * @example
 * ```typescript
 * const parsed: ParsedSection = {
 *   prefix: 'APP',
 *   section: '7',
 *   file: null
 * };
 * ```
 */
export interface ParsedSection {
  /**
   * Policy prefix identifying the documentation layer
   * Base prefixes: META, SYS, APP, USER
   * Extended prefixes: APP-HOOK, APP-PLG, APP-TPL, SYS-TPL
   */
  prefix: string;

  /**
   * Section number, possibly nested
   * Examples: "7", "4.1", "2.3.1"
   */
  section: string;

  /**
   * Policy file path, null when not yet resolved
   * Becomes string after file discovery completes
   */
  file: string | null;
}

/**
 * Fully resolved section with content
 *
 * Extends ParsedSection with the original notation, resolved file path,
 * and extracted content. Used after successful section extraction.
 *
 * @example
 * ```typescript
 * const resolved: ResolvedSection = {
 *   notation: '§APP.7',
 *   prefix: 'APP',
 *   section: '7',
 *   file: 'policy-application.md',
 *   content: '## {§APP.7}...'
 * };
 * ```
 */
export interface ResolvedSection extends ParsedSection {
  /**
   * Original section notation with § symbol
   * Examples: "§APP.7", "§META.1", "§SYS.5.2"
   */
  notation: string;

  /**
   * Policy file path (narrows null to string)
   * File is guaranteed to be resolved for this interface
   */
  file: string;

  /**
   * Extracted section content from policy file
   * Includes section header and all content up to next section marker
   */
  content: string;
}

/**
 * Section notation format: §PREFIX.NUMBER (whole sections) or §PREFIX.NUMBER.SUBSECTION[.SUBSECTION...] (subsections)
 * Examples: "§APP.7" (whole section), "§APP.7.1" (subsection), "§APP.7.1.2.3.4" (deeply nested subsection)
 * Supports arbitrary nesting depth
 * Type is string (not template literal) for efficient Map key usage in indexing
 */
export type SectionNotation = string;

/**
 * Section index with fast lookup and duplicate detection
 *
 * In-memory index built at startup and refreshed on file changes.
 * Provides O(1) section lookups and comprehensive duplicate tracking.
 */
export interface SectionIndex {
  /**
   * Fast lookup: section ID → absolute file path
   * Duplicates are excluded from this map (see duplicates map below)
   * Example: §APP.7 → "/absolute/path/to/policy-application.md"
   */
  sectionMap: Map<SectionNotation, string>;

  /**
   * Duplicate detection: section ID → all absolute file paths containing it
   * When fetch_policies encounters duplicate, returns error listing all files
   * Example: §APP.7 → ["/path/file1.md", "/path/file2.md"]
   */
  duplicates: Map<SectionNotation, string[]>;

  /**
   * File modification times for rebuild optimization
   * Example: "/absolute/path/to/policy-application.md" → mtime
   */
  fileMtimes: Map<string, Date>;

  /**
   * Cached per-file section lists for mtime optimization
   * Stores extracted sections for each file to avoid re-parsing unchanged files
   * Example: "/absolute/path/to/policy-application.md" → ["§APP.1", "§APP.2", ...]
   */
  fileSections: Map<string, SectionNotation[]>;

  /**
   * File sizes for robust change detection
   * Used alongside mtime to detect changes on low-precision filesystems
   * Example: "/absolute/path/to/policy-application.md" → 12345
   */
  fileSizes: Map<string, number>;

  /**
   * Timestamp of last index build
   */
  lastIndexed: Date;

  /**
   * Number of files indexed (includes files with zero sections)
   */
  fileCount: number;

  /**
   * Number of sections indexed
   */
  sectionCount: number;
}

/**
 * Index state with staleness tracking and file watchers
 *
 * Manages the section index lifecycle including lazy rebuilds
 * and file watching for automatic updates.
 */
export interface IndexState {
  /**
   * Current section index
   */
  index: SectionIndex;

  /**
   * Whether index is stale and needs rebuild
   */
  stale: boolean;

  /**
   * Prevents concurrent rebuilds if async file I/O used
   */
  rebuilding: boolean;

  /**
   * File watchers (one watcher per file, created at startup, closed at shutdown)
   */
  watchers: fs.FSWatcher[];
}

/**
 * Gathered section with all required fields
 *
 * Used in resolver Map to store sections during recursive resolution.
 * Similar to ResolvedSection but without notation field and with
 * stricter guarantees that all fields are populated.
 *
 * @example
 * ```typescript
 * const gathered: GatheredSection = {
 *   prefix: 'APP',
 *   section: '7',
 *   file: 'policy-application.md',
 *   content: '## {§APP.7}...'
 * };
 * ```
 */
export interface GatheredSection {
  /**
   * Policy prefix (META, SYS, APP, USER, APP-HOOK, etc.)
   */
  prefix: string;

  /**
   * Section number (7, 4.1, 2.3.1, etc.)
   */
  section: string;

  /**
   * Resolved policy file path
   * Guaranteed to be a valid file path string
   */
  file: string;

  /**
   * Extracted section content
   * Guaranteed to be non-empty after successful extraction
   */
  content: string;
}

/**
 * Validation result for section uniqueness checks
 *
 * Returned by validation functions to indicate success or failure
 * with details about duplicate section IDs across policy files.
 *
 * @example
 * ```typescript
 * // Success case
 * const success: ValidationResult = { valid: true };
 *
 * // Failure case with duplicate sections
 * const failure: ValidationResult = {
 *   valid: false,
 *   errors: [
 *     { section: '§APP.7', files: ['policy-application.md', 'policy-app-extra.md'] }
 *   ]
 * };
 * ```
 */
export interface ValidationResult {
  /**
   * Whether all sections are unique across policy files
   */
  valid: boolean;

  /**
   * Array of duplicate section errors
   * Only present when valid is false
   */
  errors?: Array<{
    /** Section ID that appears multiple times */
    section: string;
    /** Files containing the duplicate section */
    files: string[];
  }>;
}

/**
 * Configuration error exception
 *
 * Thrown when configuration files are missing, malformed,
 * or contain invalid values. Used during server startup
 * and configuration loading.
 *
 * @example
 * ```typescript
 * throw new ConfigError('Policy configuration not found: .claude/policy-config.json');
 * ```
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * Section not found error exception
 *
 * Thrown when a requested section cannot be located in any
 * discovered policy file. Indicates either invalid section
 * reference or missing documentation.
 *
 * @example
 * ```typescript
 * throw new SectionNotFoundError(
 *   'Section not found: §APP.99 in policy-application.md'
 * );
 * ```
 */
export class SectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionNotFoundError';
    Object.setPrototypeOf(this, SectionNotFoundError.prototype);
  }
}

/**
 * Validation error exception
 *
 * Thrown when section validation fails, such as duplicate
 * section IDs across policy files or invalid section format.
 *
 * @example
 * ```typescript
 * throw new ValidationError(
 *   'Duplicate section §APP.7 found in policy-application.md and policy-app-extra.md'
 * );
 * ```
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Severity levels for policy file format issues
 */
export type CheckSeverity = 'error' | 'warning';

/**
 * Single issue found during policy file format check
 *
 * Represents a specific format problem at a given location
 * in a policy file, with severity and descriptive message.
 *
 * @example
 * ```typescript
 * const issue: CheckIssue = {
 *   line: 15,
 *   severity: 'error',
 *   code: 'UNCLOSED_FENCE',
 *   message: 'Code block opened at line 10 is never closed'
 * };
 * ```
 */
export interface CheckIssue {
  /** Line number where issue was detected (1-based) */
  line: number;

  /** Severity level: error (must fix) or warning (should fix) */
  severity: CheckSeverity;

  /** Machine-readable error code for programmatic handling */
  code: string;

  /** Human-readable description of the issue */
  message: string;
}

/**
 * Result of policy file format check
 *
 * Contains all issues found and summary statistics.
 * A file passes validation when errors is 0.
 *
 * @example
 * ```typescript
 * const result: CheckResult = {
 *   valid: false,
 *   errors: 2,
 *   warnings: 1,
 *   issues: [...]
 * };
 * ```
 */
export interface CheckResult {
  /** True when no errors found (warnings allowed) */
  valid: boolean;

  /** Count of error-level issues */
  errors: number;

  /** Count of warning-level issues */
  warnings: number;

  /** All issues found during check */
  issues: CheckIssue[];
}
