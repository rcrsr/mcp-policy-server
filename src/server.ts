/**
 * MCP server assembly
 *
 * Declares the tool and prompt surface and wires requests to handlers.
 * Kept separate from the stdio entry point (index.ts) so the server can
 * be exercised in-process over an in-memory transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CallToolResult,
  GetPromptResult,
  Prompt,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  handleFetch,
  handleResolveReferences,
  handleExtractReferences,
  handleValidateReferences,
  handleListSources,
} from './handlers.js';
import { listPrefixes } from './operations.js';
import { ServerConfig } from './config.js';
import { IndexState } from './types.js';
import packageJson from '../package.json';

/** Server name reported during MCP initialization */
export const SERVER_NAME = 'policy-server';

/** Server version reported during MCP initialization */
export const SERVER_VERSION: string = packageJson.version;

/** Instructions surfaced to clients on initialization */
const SERVER_INSTRUCTIONS =
  'Use fetch_policies for § references. Pass sections array with § prefix. Ranges auto-expand. Embedded refs resolve recursively. Only fetch when needed.';

const SECTIONS_PROPERTY = {
  type: 'array',
  items: { type: 'string' },
  description: 'Section notations with § prefix (e.g., ["§PREFIX.1", "§PREFIX.2.3"])',
} as const;

/**
 * Tool definitions advertised via tools/list
 */
export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'fetch_policies',
    description:
      'Fetch policy sections with recursive § resolution. Supports ranges and mixed sections. Auto-chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: SECTIONS_PROPERTY,
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
        sections: SECTIONS_PROPERTY,
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
];

/**
 * Prompt definitions advertised via prompts/list
 */
export const PROMPT_DEFINITIONS: Prompt[] = [
  {
    name: 'auto-fetch',
    description:
      'Automatically fetch policy documentation sections when § references are encountered',
    arguments: [],
  },
];

/**
 * Build the auto-fetch prompt from the prefixes currently indexed
 *
 * @param indexState - Index state whose section map supplies the prefixes
 * @returns Prompt result with a single user message
 */
export function buildAutoFetchPrompt(indexState: IndexState): GetPromptResult {
  const prefixDocs = listPrefixes(indexState.index)
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
2. Call fetch_policies with sections array
3. Use content for task

Skip if already in context or purely informational.`,
        },
      },
    ],
  };
}

/**
 * Dispatch a tool call to its handler
 *
 * @param name - Tool name from the request
 * @param args - Raw tool arguments
 * @param config - Server configuration
 * @param indexState - Index state for section lookups
 * @returns Tool result
 * @throws {Error} For unknown tool names or handler failures
 */
export function dispatchToolCall(
  name: string,
  args: unknown,
  config: ServerConfig,
  indexState: IndexState
): CallToolResult {
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
}

/**
 * Create a fully wired MCP server
 *
 * Config and index state are captured in closures; no module-level
 * mutable state is used, so several servers can coexist in one process.
 *
 * @param config - Server configuration
 * @param indexState - Index state for section lookups
 * @returns Server ready to be connected to a transport
 */
export function createServer(config: ServerConfig, indexState: IndexState): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPT_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    try {
      return dispatchToolCall(name, args, config, indexState);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Tool execution failed: ${String(error)}`);
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    if (name === 'auto-fetch') {
      return buildAutoFetchPrompt(indexState);
    }
    throw new Error(`Unknown prompt: ${name}`);
  });

  return server;
}
