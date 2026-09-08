#!/usr/bin/env node

/**
 * Policy Documentation MCP Server
 * Stdio entry point: loads configuration, builds the index, serves requests
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, validateConfiguration } from './config.js';
import { initializeIndexState, closeIndexState } from './indexer.js';
import { createServer } from './server.js';

/**
 * Start the server
 */
async function main(): Promise<void> {
  try {
    const config = loadConfig();
    validateConfiguration(config);

    console.error('[STARTUP] Initializing section index...');
    const indexState = initializeIndexState(config);
    console.error('[STARTUP] Index initialized successfully');

    const shutdown = (signal: string): void => {
      console.error(`[SHUTDOWN] Received ${signal}, closing watchers...`);
      closeIndexState(indexState);
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    const server = createServer(config, indexState);
    await server.connect(new StdioServerTransport());
    console.error('Policy Documentation MCP Server running on stdio');
  } catch (error) {
    console.error(
      'Fatal error during startup:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
