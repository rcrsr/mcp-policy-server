#!/usr/bin/env node
/**
 * CLI binary for policy operations
 *
 * Subcommands:
 *   fetch-policies      Fetch policy content for § references
 *   validate-references Validate § references exist and are unique
 *   extract-references  Extract § references from a file
 *   list-sources        List available policy files and prefixes
 *   resolve-references  Map § references to source files
 *
 * Usage:
 *   policy-cli <subcommand> [args] [--config <path>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, ServerConfig } from './config.js';
import { expandSectionsWithIndex } from './handlers.js';
import { buildSectionIndex } from './indexer.js';
import { findEmbeddedReferences, expandRange } from './parser.js';
import { fetchSectionsWithIndex, resolveSectionLocationsWithIndex } from './resolver.js';
import { validateFromIndex, formatDuplicateErrors } from './validator.js';
import { checkPolicyFile, formatCheckResult } from './checker.js';
import { SectionNotation, SectionIndex } from './types.js';

type Subcommand =
  | 'fetch-policies'
  | 'validate-references'
  | 'extract-references'
  | 'list-sources'
  | 'resolve-references'
  | 'check';

interface ParsedArgs {
  subcommand: Subcommand | null;
  args: string[];
  configPath?: string;
}

const SUBCOMMANDS: Subcommand[] = [
  'fetch-policies',
  'validate-references',
  'extract-references',
  'list-sources',
  'resolve-references',
  'check',
];

/**
 * Parse command line arguments
 */
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  // First non-option argument should be the subcommand
  const subcommandArg = args[0];
  if (!SUBCOMMANDS.includes(subcommandArg as Subcommand)) {
    console.error(`Error: Unknown subcommand: ${subcommandArg}`);
    console.error(`Available subcommands: ${SUBCOMMANDS.join(', ')}`);
    process.exit(1);
  }

  const subcommand = subcommandArg as Subcommand;
  const remainingArgs = args.slice(1);

  let configPath: string | undefined;
  const positionalArgs: string[] = [];

  for (let i = 0; i < remainingArgs.length; i++) {
    const arg = remainingArgs[i];

    if (arg === '--config' || arg === '-c') {
      configPath = remainingArgs[++i];
      if (!configPath) {
        console.error('Error: --config requires a path argument');
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      printSubcommandUsage(subcommand);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error(`Error: Unknown option: ${arg}`);
      process.exit(1);
    } else {
      positionalArgs.push(arg);
    }
  }

  return { subcommand, args: positionalArgs, configPath };
}

/**
 * Print main usage information
 */
function printUsage(): void {
  console.error(`
Usage: policy-cli <subcommand> [args] [options]

CLI for policy documentation operations.

Subcommands:
  fetch-policies      Fetch policy content for § references from a file
  validate-references Validate that § references exist and are unique
  extract-references  Extract § references from a file
  list-sources        List available policy files and section prefixes
  resolve-references  Map § references to their source files
  check               Validate policy file format (sections, numbering, fencing)

Options:
  -c, --config <path>  Path to policies.json or glob pattern
                       (defaults to MCP_POLICY_CONFIG env var or ./policies.json)
  -h, --help           Show help (use after subcommand for subcommand help)

Examples:
  policy-cli fetch-policies document.md --config "./policies/*.md"
  policy-cli validate-references §DOC.1 §DOC.2
  policy-cli extract-references agent.md
  policy-cli list-sources
  policy-cli resolve-references §DOC.1 §DOC.2
`);
}

/**
 * Print subcommand-specific usage
 */
function printSubcommandUsage(subcommand: Subcommand): void {
  const usageMap: Record<Subcommand, string> = {
    'fetch-policies': `
Usage: policy-cli fetch-policies <file> [options]

Fetch policy content for § references found in a file.

Arguments:
  <file>  File to extract § references from

Options:
  -c, --config <path>  Path to policies.json or glob pattern
  -h, --help           Show this help

Example:
  policy-cli fetch-policies agent.md --config "./policies/*.md"
`,
    'validate-references': `
Usage: policy-cli validate-references <ref>... [options]

Validate that § references exist and are unique in policy files.

Arguments:
  <ref>...  One or more § references to validate (e.g., §DOC.1 §DOC.2)

Options:
  -c, --config <path>  Path to policies.json or glob pattern
  -h, --help           Show this help

Example:
  policy-cli validate-references §DOC.1 §DOC.2 --config "./policies/*.md"
`,
    'extract-references': `
Usage: policy-cli extract-references <file> [options]

Extract all § references from a file.

Arguments:
  <file>  File to scan for § references

Options:
  -c, --config <path>  Path to policies.json or glob pattern (not required)
  -h, --help           Show this help

Example:
  policy-cli extract-references agent.md
`,
    'list-sources': `
Usage: policy-cli list-sources [options]

List all available policy files and their section prefixes.

Options:
  -c, --config <path>  Path to policies.json or glob pattern
  -h, --help           Show this help

Example:
  policy-cli list-sources --config "./policies/*.md"
`,
    'resolve-references': `
Usage: policy-cli resolve-references <ref>... [options]

Map § references to their source files (without fetching content).

Arguments:
  <ref>...  One or more § references to resolve (e.g., §DOC.1 §DOC.2)

Options:
  -c, --config <path>  Path to policies.json or glob pattern
  -h, --help           Show this help

Example:
  policy-cli resolve-references §DOC.1 §DOC.2 --config "./policies/*.md"
`,
    check: `
Usage: policy-cli check <file> [options]

Validate policy file format including sections, numbering, and code fencing.

Checks performed:
  - Section header format ({§PREFIX.NUMBER})
  - Heading level correctness (## for sections, ### for subsections)
  - Code fence matching (all opened blocks closed)
  - Orphan subsections (subsections without parent section)
  - Section numbering gaps

Arguments:
  <file>  Policy file to validate

Options:
  -h, --help  Show this help

Exit codes:
  0  No errors (warnings may exist)
  1  Format errors found

Example:
  policy-cli check policy-app.md
`,
  };

  console.error(usageMap[subcommand]);
}

/**
 * Load config and build index, with error handling
 */
function loadConfigAndIndex(configPath?: string): { config: ServerConfig; index: SectionIndex } {
  const config = loadConfig(configPath);
  const index = buildSectionIndex(config);
  return { config, index };
}

/**
 * Handle fetch-policies subcommand
 */
function handleFetchPolicies(args: string[], configPath?: string): void {
  if (args.length === 0) {
    console.error('Error: fetch-policies requires a file argument');
    printSubcommandUsage('fetch-policies');
    process.exit(1);
  }

  const filePath = path.isAbsolute(args[0]) ? args[0] : path.resolve(process.cwd(), args[0]);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const references = findEmbeddedReferences(content);

  if (references.length === 0) {
    // No references found, exit silently
    process.exit(0);
  }

  const { config, index } = loadConfigAndIndex(configPath);

  const expandedRefs = expandSectionsWithIndex(references, index);
  const uniqueRefs = Array.from(new Set(expandedRefs)).sort() as SectionNotation[];

  const result = fetchSectionsWithIndex(uniqueRefs, index, config.baseDir);
  process.stdout.write(result);
}

/**
 * Handle validate-references subcommand
 */
function handleValidateReferences(args: string[], configPath?: string): void {
  if (args.length === 0) {
    console.error('Error: validate-references requires at least one § reference');
    printSubcommandUsage('validate-references');
    process.exit(1);
  }

  const { index } = loadConfigAndIndex(configPath);

  // Validate global index first
  const globalValidation = validateFromIndex(index);

  const result = {
    valid: true,
    checked: args.length,
    invalid: [] as string[],
    details: [] as string[],
  };

  if (!globalValidation.valid) {
    result.valid = false;
    result.details.push('Global validation errors:');
    result.details.push(formatDuplicateErrors(globalValidation.errors ?? []));
  }

  // Expand and check each reference
  const expandedRefs = expandSectionsWithIndex(args, index);
  for (const ref of expandedRefs) {
    if (index.duplicates.has(ref)) {
      result.valid = false;
      result.invalid.push(ref);
      const files = index.duplicates.get(ref)!;
      result.details.push(
        `${ref}: Found in multiple files:\n${files.map((f) => `  - ${f}`).join('\n')}`
      );
      continue;
    }

    if (!index.sectionMap.has(ref)) {
      result.valid = false;
      result.invalid.push(ref);
      result.details.push(`${ref}: Section not found in policy files`);
    }
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

/**
 * Handle extract-references subcommand
 */
function handleExtractReferences(args: string[]): void {
  if (args.length === 0) {
    console.error('Error: extract-references requires a file argument');
    printSubcommandUsage('extract-references');
    process.exit(1);
  }

  const filePath = path.isAbsolute(args[0]) ? args[0] : path.resolve(process.cwd(), args[0]);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const references = findEmbeddedReferences(content);

  // Expand ranges
  const expandedRefs = references.flatMap((ref: string) => expandRange(ref));
  const uniqueRefs = Array.from(new Set(expandedRefs)).sort();

  console.log(JSON.stringify(uniqueRefs, null, 2));
}

/**
 * Handle list-sources subcommand
 */
function handleListSources(configPath?: string): void {
  const { config, index } = loadConfigAndIndex(configPath);

  const output = `# Policy Documentation Files

${config.files.map((file) => `- ${file}`).join('\n')}

## Index Statistics

- Files indexed: ${index.fileCount}
- Sections indexed: ${index.sectionCount}
- Duplicate sections: ${index.duplicates.size}
- Last indexed: ${index.lastIndexed.toISOString()}

## Available Prefixes

${Array.from(
  new Set(
    Array.from(index.sectionMap.keys())
      .map((s) => s.match(/^§([A-Z-]+)\./)?.[1])
      .filter(Boolean)
  )
)
  .sort()
  .map((p) => `- §${p}`)
  .join('\n')}
`;

  console.log(output);
}

/**
 * Handle resolve-references subcommand
 */
function handleResolveReferences(args: string[], configPath?: string): void {
  if (args.length === 0) {
    console.error('Error: resolve-references requires at least one § reference');
    printSubcommandUsage('resolve-references');
    process.exit(1);
  }

  const { config, index } = loadConfigAndIndex(configPath);

  const expandedRefs = expandSectionsWithIndex(args, index);
  const locations = resolveSectionLocationsWithIndex(expandedRefs, index, config.baseDir);

  console.log(JSON.stringify(locations, null, 2));
}

/**
 * Handle check subcommand
 */
function handleCheck(args: string[]): void {
  if (args.length === 0) {
    console.error('Error: check requires a file argument');
    printSubcommandUsage('check');
    process.exit(1);
  }

  const filePath = path.isAbsolute(args[0]) ? args[0] : path.resolve(process.cwd(), args[0]);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const result = checkPolicyFile(filePath);
  console.log(formatCheckResult(result, args[0]));

  process.exit(result.valid ? 0 : 1);
}

/**
 * Main entry point
 */
function main(): void {
  const { subcommand, args, configPath } = parseArgs();

  if (!subcommand) {
    printUsage();
    process.exit(1);
  }

  try {
    switch (subcommand) {
      case 'fetch-policies':
        handleFetchPolicies(args, configPath);
        break;
      case 'validate-references':
        handleValidateReferences(args, configPath);
        break;
      case 'extract-references':
        handleExtractReferences(args);
        break;
      case 'list-sources':
        handleListSources(configPath);
        break;
      case 'resolve-references':
        handleResolveReferences(args, configPath);
        break;
      case 'check':
        handleCheck(args);
        break;
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Only run main when executed directly
const isDirectRun =
  process.argv[1]?.endsWith('cli.js') ||
  process.argv[1]?.endsWith('cli.ts') ||
  process.argv[1]?.endsWith('policy-cli');

if (isDirectRun) {
  main();
}
