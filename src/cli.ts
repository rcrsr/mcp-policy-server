#!/usr/bin/env node
/**
 * CLI binary for policy operations
 *
 * Subcommands:
 *   fetch-policies      Fetch policy content for § references
 *   validate-references Validate § references exist and are unique
 *   extract-references  Extract § references from a file
 *   list-sources        List available policy files and prefixes
 *   list-sections       List per-section detail (id, prefix, file, byteLength, refs)
 *   resolve-references  Map § references to source files
 *   check               Validate policy file format
 *
 * Usage:
 *   policy-cli <subcommand> [args] [--config <path>]
 */

import { runCli } from './cli-runner.js';

const result = runCli(process.argv.slice(2));

if (result.stderr) {
  process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
}
if (result.stdout) {
  process.stdout.write(result.stdout);
}

process.exitCode = result.exitCode;
