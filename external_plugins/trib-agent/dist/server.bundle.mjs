// server.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
var INSTRUCTIONS = [
  "Tools: `TeamCreate`, `TaskCreate`, `Agent`(subagent_type=Worker/Reviewer, team_name required).",
  "Lead delegates all work to Workers via `Agent`. Lead never uses Read/Write/Edit/Bash/Glob/Grep.",
  "Workflow skill must be invoked before any work begins."
].join("\n");
var server = new Server(
  { name: "trib-agent", version: "0.0.4" },
  { capabilities: {}, instructions: INSTRUCTIONS }
);
var transport = new StdioServerTransport();
await server.connect(transport);
