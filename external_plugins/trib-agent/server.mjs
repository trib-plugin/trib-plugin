import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const INSTRUCTIONS = [
  '## Agent Orchestration',
  '',
  'This server manages agent workflow and team orchestration.',
  'The agent skill handles workflow enforcement automatically.',
  '',
  '### NEVER',
  '- NEVER start code changes, investigation, or any work without invoking the workflow skill first',
  '- NEVER use Explore or Plan subagents — Workers handle exploration + execution',
  '- NEVER spawn agents without team_name assignment',
  '- NEVER terminate Workers without explicit user approval',
  '- NEVER propose stopping or wrapping up unless user asks',
  '',
  'Future: agent registry, context management, session handoff tools.',
].join('\n');

const server = new Server(
  { name: 'trib-agent', version: '0.0.3' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

const transport = new StdioServerTransport();
await server.connect(transport);
