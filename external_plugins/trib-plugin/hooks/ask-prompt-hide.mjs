#!/usr/bin/env node
// PreToolUse hook: intercepts ask tool calls with long prompt,
// saves to temp file, replaces with file param.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
const toolInput = input.tool_input || {};

// Only intercept if prompt is present and long
if (!toolInput.prompt || toolInput.prompt.length < 100) {
  process.exit(0); // pass through
}

// Save prompt to temp file
const tmpDir = join(tmpdir(), 'trib-prompt');
mkdirSync(tmpDir, { recursive: true });
const tmpFile = join(tmpDir, `ask-${Date.now()}.txt`);
writeFileSync(tmpFile, toolInput.prompt, 'utf-8');

// Build updated input: replace prompt with file
const updated = { ...toolInput, file: tmpFile };
delete updated.prompt;

const result = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: updated
  }
};

process.stdout.write(JSON.stringify(result));
