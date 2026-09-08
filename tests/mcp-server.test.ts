/**
 * Tests for server.ts
 * Exercises the MCP server end to end over an in-memory transport
 */

import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerConfig } from '../src/config.js';
import { initializeIndexState, closeIndexState } from '../src/indexer.js';
import {
  buildAutoFetchPrompt,
  createServer,
  dispatchToolCall,
  PROMPT_DEFINITIONS,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_DEFINITIONS,
} from '../src/server.js';
import { IndexState } from '../src/types.js';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-policies');
const AGENT_FILE = path.resolve(__dirname, 'fixtures', 'test-agent.md');

const CONFIG: ServerConfig = {
  files: ['policy-test.md', 'policy-meta.md', 'policy-app.md', 'policy-sys.md'].map((n) =>
    path.join(FIXTURES_DIR, n)
  ),
  baseDir: FIXTURES_DIR,
  maxChunkTokens: 10000,
};

function textOf(result: unknown): string {
  const blocks = (result as { content: Array<{ type: string; text: string }> }).content;
  return blocks.map((b) => b.text).join('');
}

describe('MCP server', () => {
  let indexState: IndexState;
  let client: Client;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    indexState = initializeIndexState(CONFIG);

    const server = createServer(CONFIG, indexState);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    closeIndexState(indexState);
  });

  it('reports its name, version, and instructions during initialization', () => {
    expect(client.getServerVersion()).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(client.getInstructions()).toContain('fetch_policies');
  });

  it('lists all five tools with their schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'fetch_policies',
      'resolve_references',
      'extract_references',
      'validate_references',
      'list_sources',
    ]);
    expect(tools).toEqual(TOOL_DEFINITIONS);
    expect(tools[0].inputSchema.required).toEqual(['sections']);
  });

  it('lists the auto-fetch prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts).toEqual(PROMPT_DEFINITIONS);
  });

  it('fetches policies through the transport', async () => {
    const result = await client.callTool({
      name: 'fetch_policies',
      arguments: { sections: ['§META.1'] },
    });
    expect(textOf(result)).toContain('## {§META.1}');
  });

  it('resolves references through the transport', async () => {
    const result = await client.callTool({
      name: 'resolve_references',
      arguments: { sections: ['§SYS.1'] },
    });
    expect(JSON.parse(textOf(result))).toEqual({ 'policy-sys.md': ['§SYS.1'] });
  });

  it('extracts references through the transport', async () => {
    const result = await client.callTool({
      name: 'extract_references',
      arguments: { file_path: AGENT_FILE },
    });
    expect(JSON.parse(textOf(result))).toContain('§APP.7');
  });

  it('validates references through the transport', async () => {
    const result = await client.callTool({
      name: 'validate_references',
      arguments: { references: ['§META.1', '§META.77'] },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.valid).toBe(false);
    expect(parsed.invalid).toEqual(['§META.77']);
  });

  it('lists sources through the transport', async () => {
    const result = await client.callTool({ name: 'list_sources', arguments: {} });
    expect(textOf(result)).toContain('- §META');
  });

  it('surfaces handler errors as MCP errors', async () => {
    await expect(
      client.callTool({ name: 'fetch_policies', arguments: { sections: [] } })
    ).rejects.toThrow(/non-empty array/);
  });

  it('rejects unknown tools', async () => {
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(
      /Unknown tool: nope/
    );
  });

  it('serves the auto-fetch prompt listing indexed prefixes', async () => {
    const result = await client.getPrompt({ name: 'auto-fetch' });
    expect(result).toEqual(buildAutoFetchPrompt(indexState));
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain('- **§APP.N**');
    expect(text).toContain('- **§TEST.N**');
    expect(text).not.toContain('§DUP');
  });

  it('rejects unknown prompts', async () => {
    await expect(client.getPrompt({ name: 'nope' })).rejects.toThrow(/Unknown prompt: nope/);
  });

  describe('dispatchToolCall', () => {
    it('routes each tool name to its handler', () => {
      expect(textOf(dispatchToolCall('list_sources', {}, CONFIG, indexState))).toContain(
        'Policy Documentation Files'
      );
      expect(() => dispatchToolCall('missing', {}, CONFIG, indexState)).toThrow(
        'Unknown tool: missing'
      );
    });
  });
});
