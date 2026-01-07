import { agentHasPolicyTool } from '../src/hook';

describe('agentHasPolicyTool', () => {
  it('should return true for direct MCP policy tool', () => {
    const content = `---
name: test-agent
tools: Read, Write, mcp__policy-server__fetch_policies
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should return true for plugin-namespaced policy tool', () => {
    const content = `---
name: test-agent
tools: Read, mcp__plugin_para_policy-server__fetch_policies, Write
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should return true for multi-segment plugin namespace', () => {
    const content = `---
name: test-agent
tools: mcp__plugin_foo_bar_policy-server__fetch_policies
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should return false when no policy tool present', () => {
    const content = `---
name: test-agent
tools: Read, Write, Edit, Grep, Bash
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false for other MCP tools', () => {
    const content = `---
name: test-agent
tools: mcp__other-server__some_tool
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false when no frontmatter', () => {
    const content = `# Agent without frontmatter
Some content here`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false when no tools in frontmatter', () => {
    const content = `---
name: test-agent
description: No tools defined
---
# Agent content`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should return false for unclosed frontmatter', () => {
    const content = `---
name: test-agent
tools: mcp__policy-server__fetch_policies
# Missing closing delimiter`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });

  it('should handle policy tool as only tool', () => {
    const content = `---
tools: mcp__policy-server__fetch_policies
---`;
    expect(agentHasPolicyTool(content)).toBe(true);
  });

  it('should not match partial tool names', () => {
    const content = `---
tools: mcp__policy-server__validate_references
---`;
    expect(agentHasPolicyTool(content)).toBe(false);
  });
});
