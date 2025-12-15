#!/usr/bin/env node

/**
 * Policy Documentation MCP Server
 * Exposes policy documentation via MCP tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  handleFetch,
  handleResolveReferences,
  handleExtractReferences,
  handleValidateReferences,
  handleListSources,
} from './handlers.js';
import { loadConfig, validateConfiguration, ServerConfig } from './config.js';
import { initializeIndexState, closeIndexState } from './indexer.js';
import { IndexState } from './types.js';
import packageJson from '../package.json';

// Create server instance
const server = new Server(
  {
    name: 'policy-server',
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
    instructions: `Use fetch_policies for § references. Pass sections array with § prefix. Ranges auto-expand. Embedded refs resolve recursively. Only fetch when needed.`,
  }
);

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'fetch_policies',
        description:
          'Fetch policy sections with recursive § resolution. Supports ranges and mixed sections. Auto-chunks.',
        inputSchema: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              items: { type: 'string' },
              description: 'Section notations with § prefix (e.g., ["§PREFIX.1", "§PREFIX.2.3"])',
            },
            continuation: {
              type: 'string',
              description: 'Continuation token (e.g., "chunk:1"). Omit for first call.',
              default: null,
            },
          },
          required: ['sections'],
        },
      },
      {
        name: 'resolve_references',
        description:
          'Resolve section locations with recursive § resolution. Returns file-to-sections map not content.',
        inputSchema: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              items: { type: 'string' },
              description: 'Section notations with § prefix (e.g., ["§PREFIX.1", "§PREFIX.2.3"])',
            },
          },
          required: ['sections'],
        },
      },
      {
        name: 'extract_references',
        description: 'Extract § references from file. Returns array of notations.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute path to the file to scan for § references',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'validate_references',
        description: 'Validate § references exist and are unique. Reports invalid/duplicates.',
        inputSchema: {
          type: 'object',
          properties: {
            references: {
              type: 'array',
              items: { type: 'string' },
              description: 'Section notations to validate (e.g., ["§PREFIX.1", "§PREFIX.2.3"])',
            },
          },
          required: ['references'],
        },
      },
      {
        name: 'list_sources',
        description: 'List all available policy documentation files and their section prefixes',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

/**
 * Setup request handlers with configuration and index state
 *
 * Creates closure over config and indexState to avoid global mutable state
 */
function setupRequestHandlers(config: ServerConfig, indexState: IndexState): void {
  /**
   * Handle tool calls
   */
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'fetch_policies':
          return handleFetch(args, config, indexState);

        case 'resolve_references':
          return handleResolveReferences(args, config, indexState);

        case 'extract_references':
          return handleExtractReferences(args, config);

        case 'validate_references':
          return handleValidateReferences(args, config, indexState);

        case 'list_sources':
          return handleListSources(args, config, indexState);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Tool execution failed: ${String(error)}`);
    }
  });

  /**
   * Get prompt content
   */
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === 'auto-fetch') {
      // Extract unique prefixes from indexed sections
      const prefixes = new Set<string>();
      for (const section of indexState.index.sectionMap.keys()) {
        const match = section.match(/^§([A-Z-]+)\./);
        if (match) {
          prefixes.add(match[1]);
        }
      }

      const prefixDocs = Array.from(prefixes)
        .sort()
        .map((prefix) => `- **§${prefix}.N** - Section N from policy files`)
        .join('\n');

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# Auto-Fetch § References

Auto-fetch § references from agent/system files using fetch_policies.

Available sections:
${prefixDocs}

When you see § refs:
1. Extract notations (§APP.7, §SYS.5)
2. Call fetch with sections array
3. Use content for task

Skip if already in context or purely informational.`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });
}

/**
 * List available prompts
 */
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: 'auto-fetch',
        description:
          'Automatically fetch policy documentation sections when § references are encountered',
        arguments: [],
      },
    ],
  };
});

/**
 * Start the server
 */
async function main(): Promise<void> {
  try {
    // Load and validate configuration
    const config = loadConfig();
    validateConfiguration(config);

    console.error('Policy server configuration loaded:');
    console.error(`  Base directory: ${config.baseDir}`);
    console.error(`  Files: ${config.files.length} configured`);

    // Initialize index with file watching
    console.error('[STARTUP] Initializing section index...');
    const indexState = initializeIndexState(config);
    console.error('[STARTUP] Index initialized successfully');

    // Setup signal handlers for clean shutdown
    process.on('SIGINT', () => {
      console.error('[SHUTDOWN] Received SIGINT, closing watchers...');
      closeIndexState(indexState);
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error('[SHUTDOWN] Received SIGTERM, closing watchers...');
      closeIndexState(indexState);
      process.exit(0);
    });

    // Setup request handlers with config and indexState closure
    setupRequestHandlers(config, indexState);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Policy Documentation MCP Server running on stdio');
  } catch (error) {
    if (error instanceof Error) {
      console.error('Fatal error during startup:', error.message);
    } else {
      console.error('Fatal error during startup:', String(error));
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error('Fatal error:', error.message);
  } else {
    console.error('Fatal error:', String(error));
  }
  process.exit(1);
});
