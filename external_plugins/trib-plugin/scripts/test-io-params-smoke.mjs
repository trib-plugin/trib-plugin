#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeBuiltinTool } from '../src/agent/orchestrator/tools/builtin.mjs';
import { executePatchTool } from '../src/agent/orchestrator/tools/patch.mjs';
import { executeBashSessionTool } from '../src/agent/orchestrator/tools/bash-session.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function extractJobId(text) {
  return /\[job: ([^\]\r\n]+)\]/.exec(String(text || ''))?.[1] || null;
}

function extractSessionId(text) {
  return /\[session: ([^\]\r\n]+)\]/.exec(String(text || ''))?.[1] || null;
}

function makeLargeFileBody() {
  const lines = [];
  for (let i = 1; i <= 650; i++) {
    lines.push(`line-${String(i).padStart(4, '0')} ${'x'.repeat(60)}`);
  }
  return lines.join('\n') + '\n';
}

const root = mkdtempSync(join(tmpdir(), 'trib-io-params-'));
const dataDir = join(root, 'plugin-data');
const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;

try {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, '.hidden'), { recursive: true });

  writeFileSync(join(root, 'alpha.txt'), 'line1\nline2\nline3\nline4\n', 'utf8');
  writeFileSync(join(root, 'new.txt'), 'hello\nworld\n', 'utf8');
  writeFileSync(join(root, 'range.txt'), 'r1\nr2\nr3\nr4\n', 'utf8');
  writeFileSync(join(root, 'multi.txt'), 'foo\nfoo\nfoo\n', 'utf8');
  writeFileSync(join(root, 'batch.txt'), 'dup\ndup\n', 'utf8');
  writeFileSync(join(root, 'notes.md'), 'CaseSensitiveNeedle\n', 'utf8');
  writeFileSync(join(root, 'other.md'), 'casesensitiveneedle\n', 'utf8');
  writeFileSync(join(root, 'grep.txt'), 'before\nMATCH target\nafter\n', 'utf8');
  writeFileSync(join(root, 'multiline.txt'), 'alpha(\n  beta\n)\n', 'utf8');
  writeFileSync(join(root, 'big.txt'), makeLargeFileBody(), 'utf8');
  writeFileSync(join(root, '.hidden', 'secret.txt'), 'secret\n', 'utf8');
  writeFileSync(join(root, 'sub', 'beta.js'), 'export const beta = 1;\nconsole.log(beta);\n', 'utf8');
  writeFileSync(join(root, 'sub', 'gamma.py'), 'def gamma(x):\n    return x\n', 'utf8');
  writeFileSync(join(root, 'sub', 'tiny.bin.txt'), 'xx\n', 'utf8');

  // read: path(string), mode(full/head/tail/count), n, offset, limit, full, path(array)
  {
    const out = await executeBuiltinTool('read', { path: join(root, 'new.txt') }, root);
    assert(out.includes('1\thello') && out.includes('2\tworld'), 'read default path:string');
  }
  {
    const out = await executeBuiltinTool('read', { path: [join(root, 'alpha.txt'), join(root, 'new.txt')] }, root);
    assert(out.includes('###') && out.includes('alpha.txt') && out.includes('new.txt'), 'read path:array');
  }
  {
    const out = await executeBuiltinTool('read', { path: join(root, 'alpha.txt'), mode: 'head', n: 2 }, root);
    assert(out.includes('1\tline1') && out.includes('2\tline2'), 'read mode=head n');
  }
  {
    const out = await executeBuiltinTool('read', { path: join(root, 'alpha.txt'), mode: 'tail', n: 2 }, root);
    assert(out.includes('3\tline3') && out.includes('4\tline4'), 'read mode=tail n');
  }
  {
    const out = await executeBuiltinTool('read', { path: join(root, 'alpha.txt'), mode: 'count' }, root);
    assert(/lines/i.test(out) || /\b4\b/.test(out), 'read mode=count');
  }
  {
    const out = await executeBuiltinTool('read', { path: join(root, 'alpha.txt'), mode: 'full', offset: 1, limit: 2 }, root);
    assert(out.includes('2\tline2') && out.includes('3\tline3') && !out.includes('1\tline1'), 'read mode=full offset/limit');
  }
  {
    const capped = await executeBuiltinTool('read', { path: join(root, 'big.txt') }, root);
    const full = await executeBuiltinTool('read', { path: join(root, 'big.txt'), full: true }, root);
    assert(capped.includes('[TRUNCATED'), 'read big-file smart cap');
    assert(!full.includes('[TRUNCATED') && full.includes('650\tline-0650'), 'read full:true');
  }

  // edit: path, old_string, new_string, replace_all, edits[], item.path, item.replace_all
  await executeBuiltinTool('read', { path: join(root, 'multi.txt') }, root);
  {
    const out = await executeBuiltinTool('edit', {
      path: join(root, 'multi.txt'),
      old_string: 'foo',
      new_string: 'FOO',
      replace_all: true,
    }, root);
    assert(/Edited:/.test(out) && readFileSync(join(root, 'multi.txt'), 'utf8').includes('FOO\nFOO\nFOO'), 'edit single replace_all');
  }
  await executeBuiltinTool('read', { path: join(root, 'alpha.txt') }, root);
  {
    const out = await executeBuiltinTool('edit', {
      path: join(root, 'alpha.txt'),
      edits: [
        { old_string: 'line1', new_string: 'LINE1' },
        { old_string: 'line4', new_string: 'LINE4' },
      ],
    }, root);
    const body = readFileSync(join(root, 'alpha.txt'), 'utf8');
    assert(/Edited:/.test(out) && body.includes('LINE1') && body.includes('LINE4'), 'edit edits[] with top-level path fallback');
  }
  await executeBuiltinTool('read', { path: join(root, 'new.txt') }, root);
  await executeBuiltinTool('read', { path: join(root, 'batch.txt') }, root);
  {
    const out = await executeBuiltinTool('edit', {
      edits: [
        { path: join(root, 'new.txt'), old_string: 'hello', new_string: 'HELLO' },
        { path: join(root, 'batch.txt'), old_string: 'dup', new_string: 'DUP', replace_all: true },
      ],
    }, root);
    assert(out.includes('OK') && readFileSync(join(root, 'batch.txt'), 'utf8').includes('DUP\nDUP'), 'edit edits[] item.path/item.replace_all');
  }

  // edit_lines: path, start_line, end_line, new_content
  await executeBuiltinTool('read', { path: join(root, 'range.txt') }, root);
  {
    const out = await executeBuiltinTool('edit_lines', {
      path: join(root, 'range.txt'),
      start_line: 2,
      end_line: 3,
      new_content: 'R2\nR3',
    }, root);
    const body = readFileSync(join(root, 'range.txt'), 'utf8');
    assert(/Edited:/.test(out) && body.includes('R2\nR3'), 'edit_lines');
  }

  // grep: pattern(string/array), path, glob(string/array), output_mode(all), head_limit, offset, -i, -n, -A, -B, -C, context, multiline
  {
    const out = await executeBuiltinTool('grep', {
      pattern: 'casesensitiveneedle',
      path: root,
      glob: '*.md',
      output_mode: 'files_with_matches',
      head_limit: 1,
      offset: 1,
      '-i': true,
    }, root);
    assert(out.includes('other.md') || out.includes('notes.md'), 'grep files_with_matches path/glob/head_limit/offset/-i');
  }
  {
    const out = await executeBuiltinTool('grep', {
      pattern: ['MATCH', 'before'],
      path: root,
      glob: ['*.txt', '*.md'],
      output_mode: 'content',
      '-n': false,
      '-A': 1,
      '-B': 1,
    }, root);
    assert(out.includes('before') && out.includes('after') && !/grep\.txt:\d+/.test(out), 'grep content pattern[] glob[] -n -A -B');
  }
  {
    const out = await executeBuiltinTool('grep', {
      pattern: 'MATCH',
      path: root,
      output_mode: 'content',
      '-C': 1,
    }, root);
    assert(out.includes('before') && out.includes('after'), 'grep -C');
  }
  {
    const out = await executeBuiltinTool('grep', {
      pattern: 'MATCH',
      path: root,
      output_mode: 'content',
      context: 1,
    }, root);
    assert(out.includes('before') && out.includes('after'), 'grep context alias');
  }
  {
    const out = await executeBuiltinTool('grep', {
      pattern: 'alpha\\([\\s\\S]*beta[\\s\\S]*\\)',
      path: root,
      glob: 'multiline.txt',
      output_mode: 'count',
      multiline: true,
    }, root);
    assert(/\b1\b/.test(out), 'grep output_mode=count multiline');
  }

  // glob: pattern(string/array), path, head_limit, offset
  {
    const out = await executeBuiltinTool('glob', {
      pattern: '*.txt',
      path: root,
      head_limit: 2,
      offset: 1,
    }, root);
    assert(typeof out === 'string' && out.length > 0, 'glob string head_limit offset');
  }
  {
    const out = await executeBuiltinTool('glob', {
      pattern: ['*.js', '*.py'],
      path: root,
    }, root);
    assert(out.includes('beta.js') && out.includes('gamma.py'), 'glob pattern[]');
  }

  // list: path, mode(list/tree/find), depth, hidden, sort(name/mtime/size), type(any/file/dir), head_limit, offset, name, min_size, max_size, modified_after, modified_before
  {
    const out = await executeBuiltinTool('list', {
      path: root,
      mode: 'list',
      depth: 2,
      hidden: true,
      sort: 'name',
      type: 'any',
      head_limit: 20,
      offset: 0,
    }, root);
    assert(out.includes('.hidden') && out.includes('alpha.txt'), 'list mode=list hidden sort=name type=any');
  }
  {
    const out = await executeBuiltinTool('list', {
      path: root,
      mode: 'list',
      depth: 2,
      sort: 'mtime',
      type: 'dir',
      head_limit: 10,
    }, root);
    assert(out.includes('sub') || out.includes('.hidden'), 'list sort=mtime type=dir');
  }
  {
    const out = await executeBuiltinTool('list', {
      path: root,
      mode: 'list',
      depth: 2,
      sort: 'size',
      type: 'file',
      head_limit: 10,
      offset: 1,
    }, root);
    assert(out.includes('.txt') || out.includes('.md') || out.includes('.js'), 'list sort=size type=file offset');
  }
  {
    const out = await executeBuiltinTool('list', {
      path: root,
      mode: 'tree',
      depth: 2,
      hidden: true,
      head_limit: 10,
      offset: 1,
    }, root);
    assert(out.includes('alpha.txt') || out.includes('sub/'), 'list mode=tree hidden head_limit offset');
  }
  {
    const out = await executeBuiltinTool('list', {
      path: root,
      mode: 'find',
      name: '*.txt',
      type: 'file',
      min_size: 2,
      max_size: 50000,
      modified_after: '1h',
      modified_before: '2099-01-01T00:00:00Z',
      head_limit: 20,
      offset: 0,
    }, root);
    assert(out.includes('alpha.txt') && out.includes('new.txt'), 'list mode=find name/min_size/max_size/modified_after/modified_before');
  }

  // diff: from/to, from_text, to_text, context, file-path mode
  {
    const out = await executeBuiltinTool('diff', {
      from: 'a\nb\n',
      to: 'a\nB\n',
      from_text: true,
      to_text: true,
      context: 1,
    }, root);
    assert(out.includes('---') && out.includes('+++') && out.includes('+B'), 'diff text/context');
  }
  {
    const out = await executeBuiltinTool('diff', {
      from: join(root, 'alpha.txt'),
      to: join(root, 'range.txt'),
    }, root);
    assert(out.includes('---') && out.includes('+++'), 'diff file paths');
  }

  // bash: command, timeout, merge_stderr, run_in_background
  {
    const out = await executeBuiltinTool('bash', {
      command: `cd ${root} && printf 'OUT' && printf 'ERR' 1>&2`,
      timeout: 2000,
      merge_stderr: true,
    }, root);
    assert(out.includes('OUTERR'), 'bash timeout/merge_stderr');
  }

  let jobId = null;
  {
    const out = await executeBuiltinTool('bash', {
      command: `cd ${root} && printf 'OUT1\\nOUT2\\n' && printf 'ERR1\\nERR2\\n' 1>&2 && sleep 0.3`,
      run_in_background: true,
    }, root);
    jobId = extractJobId(out);
    assert(!!jobId && out.includes('[stdout:') && out.includes('[stderr:'), 'bash run_in_background');
  }
  {
    const out = await executeBuiltinTool('jobs_list', {}, root);
    assert(out.includes(jobId), 'jobs_list');
  }
  {
    const out = await executeBuiltinTool('job_status', { job_id: jobId }, root);
    assert(out.includes(jobId), 'job_status job_id');
  }
  {
    const out = await executeBuiltinTool('job_wait', {
      job_id: jobId,
      timeout_ms: 5000,
      poll_ms: 50,
    }, root);
    assert(out.includes('"status"') && /completed|failed|cancelled/.test(out), 'job_wait timeout_ms/poll_ms');
  }
  {
    const out = await executeBuiltinTool('job_read', {
      job_id: jobId,
      stream: 'stdout',
      mode: 'head',
      n: 1,
    }, root);
    assert(out.includes('OUT1'), 'job_read stream=stdout mode=head n');
  }
  {
    const out = await executeBuiltinTool('job_read', {
      job_id: jobId,
      stream: 'stderr',
      mode: 'tail',
      n: 1,
    }, root);
    assert(out.includes('ERR2'), 'job_read stream=stderr mode=tail n');
  }
  {
    const out = await executeBuiltinTool('job_read', {
      job_id: jobId,
      stream: 'stdout',
      mode: 'full',
      offset: 1,
      limit: 1,
    }, root);
    assert(out.includes('OUT2') && !out.includes('OUT1'), 'job_read mode=full offset/limit');
  }
  {
    const out = await executeBuiltinTool('job_read', {
      job_id: jobId,
      mode: 'count',
    }, root);
    assert(/lines/i.test(out) || /\b2\b/.test(out), 'job_read mode=count');
  }

  let cancelJobId = null;
  {
    const out = await executeBuiltinTool('bash', {
      command: 'sleep 30',
      run_in_background: true,
    }, root);
    cancelJobId = extractJobId(out);
    assert(!!cancelJobId, 'background job for cancel');
  }
  {
    const out = await executeBuiltinTool('job_cancel', { job_id: cancelJobId }, root);
    assert(/Cancelled job/.test(out) || /no longer running/.test(out), 'job_cancel job_id');
  }

  // bash_session: command, session_id, timeout, close
  {
    const first = await executeBashSessionTool('bash_session', { command: `cd ${root} && export IO_SMOKE=ok && echo primed` });
    const sessionId = extractSessionId(first);
    const second = await executeBashSessionTool('bash_session', {
      session_id: sessionId,
      command: 'echo "$IO_SMOKE"',
      close: true,
    });
    const timeoutRes = await executeBashSessionTool('bash_session', {
      command: 'sleep 2',
      timeout: 1000,
      close: true,
    });
    assert(!!sessionId && second.includes('ok') && second.includes('[closed]'), 'bash_session session_id/close');
    assert(timeoutRes.includes('[timeout: 1000 ms') && timeoutRes.includes('[closed]'), 'bash_session timeout');
  }

  // apply_patch: patch, base_path, dry_run, reject_partial
  {
    const patch = [
      '--- a/new.txt',
      '+++ b/new.txt',
      '@@ -1,2 +1,2 @@',
      '-HELLO',
      '+PATCHED',
      ' world',
      '',
    ].join('\n');
    const dryRun = await executePatchTool('apply_patch', { patch, base_path: root, dry_run: true }, root);
    assert(/dry-run: 1 file/.test(dryRun) && readFileSync(join(root, 'new.txt'), 'utf8').includes('HELLO'), 'apply_patch dry_run/base_path');
  }
  {
    writeFileSync(join(root, 'partial-ok.txt'), 'old\n', 'utf8');
    writeFileSync(join(root, 'partial-bad.txt'), 'keep\n', 'utf8');
    const patch = [
      '--- a/partial-ok.txt',
      '+++ b/partial-ok.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/partial-bad.txt',
      '+++ b/partial-bad.txt',
      '@@ -1 +1 @@',
      '-missing',
      '+still-missing',
      '',
    ].join('\n');
    const out = await executePatchTool('apply_patch', {
      patch,
      base_path: root,
      reject_partial: false,
    }, root);
    assert(/failed/.test(out) && readFileSync(join(root, 'partial-ok.txt'), 'utf8').includes('new'), 'apply_patch reject_partial=false');
  }
} finally {
  if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
  rmSync(root, { recursive: true, force: true });
}

console.log(`test-io-params-smoke: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
