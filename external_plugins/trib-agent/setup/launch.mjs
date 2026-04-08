#!/usr/bin/env node
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = join(__dirname, 'setup-server.mjs');

const child = spawn(process.execPath, [server], {
  detached: true,
  stdio: 'ignore',
  cwd: dirname(__dirname),
  env: { ...process.env },
});
child.unref();

process.stdout.write('Config UI: http://localhost:3459\n', () => process.exit(0));
