import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from './config.js';

/** Validate workflow name — reject path traversal and invalid characters */
function isValidName(name) {
  return name && typeof name === 'string' && !/[\/\\]/.test(name) && !name.includes('..')
    && /^[a-zA-Z0-9._-]+$/.test(name);
}

/**
 * Returns the workflows directory path.
 * Creates it if it does not exist.
 */
export function getWorkflowDir() {
  const dir = join(getPluginData(), 'workflows');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * List all workflows: [{name, description}].
 * Reads only name + description from each JSON file.
 */
export function listWorkflows() {
  const dir = getWorkflowDir();
  const results = [];
  let files;
  try { files = readdirSync(dir); } catch { return results; }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (raw.name) {
        results.push({ name: raw.name, description: raw.description || '' });
      }
    } catch { /* skip malformed files */ }
  }
  return results;
}

/**
 * Get a specific workflow by name.
 * Returns the full JSON object or null if not found.
 */
export function getWorkflow(name) {
  if (!isValidName(name)) return null;
  const dir = getWorkflowDir();
  const filePath = join(dir, `${name}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

/**
 * Save a workflow. Uses data.name as the filename.
 * @param {object} data - Workflow object with name, description, steps.
 */
export function saveWorkflow(data) {
  if (!data || !data.name) throw new Error('workflow must have a name');
  if (!isValidName(data.name)) throw new Error('invalid workflow name');
  if (!Array.isArray(data.steps)) throw new Error('workflow must have a steps array');
  const dir = getWorkflowDir();
  const filePath = join(dir, `${data.name}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return data;
}

/**
 * Delete a workflow by name.
 * @returns {boolean} true if deleted, false if not found.
 */
export function deleteWorkflow(name) {
  if (!isValidName(name)) return false;
  const dir = getWorkflowDir();
  const filePath = join(dir, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}
