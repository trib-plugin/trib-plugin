#!/usr/bin/env node
/**
 * MCP server launcher for trib-plugin.
 * Starts the server.mjs in stdio mode.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'server.mjs');

// Spawn the server with stdio inheritance
const proc = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: process.env,
});

process.on('SIGTERM', () => {
  proc.kill('SIGTERM');
});

process.on('SIGINT', () => {
  proc.kill('SIGINT');
});

proc.on('exit', (code) => {
  process.exit(code || 0);
});
