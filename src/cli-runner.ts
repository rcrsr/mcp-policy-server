/**
 * CLI logic behind the policy-cli binary
 *
 * Argument parsing and every subcommand return plain data instead of
 * writing to stdout or calling process.exit, so the whole CLI can be
 * driven in-process. cli.ts maps the result onto the real process.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, ServerConfig } from './config.js';
import { buildSectionIndex, buildSectionDetails } from './indexer.js';
import { findEmbeddedReferences } from './parser.js';
import { resolveSectionLocationsWithIndex } from './resolver.js';
import { checkPolicyFile, formatCheckResult } from './checker.js';
import {
  expandSectionsWithIndex,
  extractReferences,
  fetchPoliciesForReferences,
  formatSourceList,
  validateReferences,
} from './operations.js';
import { SectionIndex } from './types.js';

export type Subcommand =
  | 'fetch-policies'
  | 'validate-references'
  | 'extract-references'
  | 'list-sources'
  | 'list-sections'
  | 'resolve-references'
  | 'check';

export const SUBCOMMANDS: readonly Subcommand[] = [
  'fetch-policies',
  'validate-references',
  'extract-references',
  'list-sources',
  'list-sections',
  'resolve-references',
  'check',
];

/**
 * Outcome of a CLI invocation
 */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Parsed command line
 */
export type ParsedArgs =
  | { kind: 'run'; subcommand: Subcommand; args: string[]; configPath?: string }
  | { kind: 'help'; subcommand?: Subcommand; exitCode: number }
  | { kind: 'error'; message: string };

export const USAGE = `
Usage: policy-cli <subcommand> [args] [options]

CLI for policy documentation operations.

Subcommands:
  fetch-policies      Fetch policy content for § references from a file
  validate-references Validate that § references exist and are unique
  extract-references  Extract § references from a file
  list-sources        List available policy files and section prefixes
  list-sections       List per-section detail (id, prefix, file, byteLength, refs) as JSON
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
  policy-cli list-sections
  policy-cli resolve-references §DOC.1 §DOC.2
`;

export const SUBCOMMAND_USAGE: Record<Subcommand, string> = {
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
  'list-sections': `
Usage: policy-cli list-sections [options]

List per-section detail (id, prefix, file, byteLength, refs) as JSON.

Each record's refs field is that section's outbound § references, computed
with the same fence/inline-code exclusion extract-references applies.

Options:
  -c, --config <path>  Path to policies.json or glob pattern
  -h, --help           Show this help

Example:
  policy-cli list-sections --config "./policies/*.md"
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

/**
 * Parse command line arguments (excluding node and script path)
 *
 * @param argv - Arguments after the binary name
 * @returns Parsed command, help request, or error
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { kind: 'help', exitCode: 1 };
  }

  const subcommandArg = argv[0];
  if (subcommandArg === '--help' || subcommandArg === '-h') {
    return { kind: 'help', exitCode: 0 };
  }

  if (!SUBCOMMANDS.includes(subcommandArg as Subcommand)) {
    if (argv.includes('--help') || argv.includes('-h')) {
      return { kind: 'help', exitCode: 0 };
    }
    return {
      kind: 'error',
      message: `Unknown subcommand: ${subcommandArg}\nAvailable subcommands: ${SUBCOMMANDS.join(', ')}`,
    };
  }

  const subcommand = subcommandArg as Subcommand;
  const remaining = argv.slice(1);
  let configPath: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i];

    if (arg === '--config' || arg === '-c') {
      configPath = remaining[++i];
      if (!configPath) {
        return { kind: 'error', message: '--config requires a path argument' };
      }
    } else if (arg === '--help' || arg === '-h') {
      return { kind: 'help', subcommand, exitCode: 0 };
    } else if (arg.startsWith('-')) {
      return { kind: 'error', message: `Unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  return { kind: 'run', subcommand, args: positional, configPath };
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string, exitCode = 1): CliResult {
  return { exitCode, stdout: '', stderr };
}

function usageError(subcommand: Subcommand, message: string): CliResult {
  return fail(`Error: ${message}\n${SUBCOMMAND_USAGE[subcommand]}`);
}

function loadConfigAndIndex(configPath?: string): { config: ServerConfig; index: SectionIndex } {
  const config = loadConfig(configPath);
  const index = buildSectionIndex(config);
  return { config, index };
}

/**
 * Resolve a user-supplied path against cwd and confirm it exists
 */
function resolveExistingFile(
  arg: string,
  cwd: string
): { ok: true; filePath: string } | { ok: false; result: CliResult } {
  const filePath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
  if (!fs.existsSync(filePath)) {
    return { ok: false, result: fail(`Error: File not found: ${filePath}`) };
  }
  return { ok: true, filePath };
}

function fetchPolicies(args: string[], configPath: string | undefined, cwd: string): CliResult {
  if (args.length === 0) {
    return usageError('fetch-policies', 'fetch-policies requires a file argument');
  }

  const resolved = resolveExistingFile(args[0], cwd);
  if (!resolved.ok) return resolved.result;

  const content = fs.readFileSync(resolved.filePath, 'utf8');
  const references = findEmbeddedReferences(content);
  if (references.length === 0) {
    return ok('');
  }

  const { config, index } = loadConfigAndIndex(configPath);
  return ok(fetchPoliciesForReferences(references, index, config.baseDir));
}

function validate(args: string[], configPath: string | undefined): CliResult {
  if (args.length === 0) {
    return usageError(
      'validate-references',
      'validate-references requires at least one § reference'
    );
  }

  const { index } = loadConfigAndIndex(configPath);
  const result = validateReferences(args, index);
  return {
    exitCode: result.valid ? 0 : 1,
    stdout: JSON.stringify(result, null, 2) + '\n',
    stderr: '',
  };
}

function extract(args: string[], cwd: string): CliResult {
  if (args.length === 0) {
    return usageError('extract-references', 'extract-references requires a file argument');
  }

  const resolved = resolveExistingFile(args[0], cwd);
  if (!resolved.ok) return resolved.result;

  const content = fs.readFileSync(resolved.filePath, 'utf8');
  return ok(JSON.stringify(extractReferences(content), null, 2) + '\n');
}

function listSources(configPath: string | undefined): CliResult {
  const { config, index } = loadConfigAndIndex(configPath);
  return ok(formatSourceList(config, index) + '\n');
}

function listSections(configPath: string | undefined): CliResult {
  const { config, index } = loadConfigAndIndex(configPath);
  const { details, skipped } = buildSectionDetails(index, config.baseDir);

  let stderr = '';
  if (skipped.length > 0) {
    stderr = `Skipped sections: ${skipped.length}\n`;
    for (const { id, reason } of skipped) {
      stderr += `  - ${id}: ${reason}\n`;
    }
  }

  return {
    exitCode: skipped.length > 0 ? 1 : 0,
    stdout: JSON.stringify({ details, skipped }, null, 2) + '\n',
    stderr,
  };
}

function resolve(args: string[], configPath: string | undefined): CliResult {
  if (args.length === 0) {
    return usageError('resolve-references', 'resolve-references requires at least one § reference');
  }

  const { config, index } = loadConfigAndIndex(configPath);
  const expanded = expandSectionsWithIndex(args, index);
  const locations = resolveSectionLocationsWithIndex(expanded, index, config.baseDir);
  return ok(JSON.stringify(locations, null, 2) + '\n');
}

function check(args: string[], cwd: string): CliResult {
  if (args.length === 0) {
    return usageError('check', 'check requires a file argument');
  }

  const resolved = resolveExistingFile(args[0], cwd);
  if (!resolved.ok) return resolved.result;

  const result = checkPolicyFile(resolved.filePath);
  return {
    exitCode: result.valid ? 0 : 1,
    stdout: formatCheckResult(result, args[0]) + '\n',
    stderr: '',
  };
}

/**
 * Run the CLI in-process
 *
 * @param argv - Arguments after the binary name
 * @param cwd - Working directory for relative file arguments
 * @returns Exit code and output streams
 */
export function runCli(argv: string[], cwd: string = process.cwd()): CliResult {
  const parsed = parseArgs(argv);

  if (parsed.kind === 'help') {
    const text = parsed.subcommand ? SUBCOMMAND_USAGE[parsed.subcommand] : USAGE;
    return { exitCode: parsed.exitCode, stdout: '', stderr: text };
  }

  if (parsed.kind === 'error') {
    return fail(`Error: ${parsed.message}`);
  }

  const { subcommand, args, configPath } = parsed;

  try {
    switch (subcommand) {
      case 'fetch-policies':
        return fetchPolicies(args, configPath, cwd);
      case 'validate-references':
        return validate(args, configPath);
      case 'extract-references':
        return extract(args, cwd);
      case 'list-sources':
        return listSources(configPath);
      case 'list-sections':
        return listSections(configPath);
      case 'resolve-references':
        return resolve(args, configPath);
      case 'check':
        return check(args, cwd);
    }
  } catch (error) {
    return fail(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
