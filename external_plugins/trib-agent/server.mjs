import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const INSTRUCTIONS = [
  '## Agent Orchestration',
  '',
  'This server manages agent workflow and team orchestration.',
  'The agent skill handles workflow enforcement automatically.',
  '',
  'Future: agent registry, context management, session handoff tools.',
].join('\n');

const server = new Server(
  { name: 'trib-agent', version: '0.0.1' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

const transport = new StdioServerTransport();
await server.connect(transport);
