// LSP-backed symbol tools — definition / references / document symbols.
//
// Why these and not `explore` (glob+grep)?
//   grep matches text; LSP matches symbols. For any non-trivial name
//   (method called `get`, variable called `x`, a type re-exported via
//   barrel) a textual search returns dozens of unrelated hits. LSP knows
//   which occurrence is THE definition, which sites reference it, and
//   what kind (class / function / variable) a symbol is — all the context
//   the caller needs to navigate without reading thousands of lines.
//
// Scope: TypeScript / JavaScript only. We spawn one
// typescript-language-server instance per plugin server (shared across
// calls), open each requested document lazily, and kill the child after
// 90s of idle time to avoid hoarding RAM. The query loop is:
//
//   1. open file (didOpen) if unseen
//   2. locate the symbol name with a word-boundary regex to get a cursor
//      position (line/col the server can work from)
//   3. send textDocument/definition | references | documentSymbol
//   4. format the response into a compact `path:line:col` listing
//
// Step 2 is deliberately naive — if the symbol appears multiple times,
// we pick the first occurrence and let the LSP server do the actual
// semantic resolution from that cursor. For ambiguous names the caller
// can pass a narrower `file` to pin the starting document.
//
// All paths in the output are rendered relative to the call's cwd for
// compact display; absolute paths flow internally.

import { spawn } from 'node:child_process';
import { resolve as pathResolve, extname, isAbsolute, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { normalizeInputPath, normalizeOutputPath, toDisplayPath } from './builtin.mjs';

const LANG_BY_EXT = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

const IDLE_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;

let _state = null;

function freshState() {
  return {
    child: null,
    cwd: null,
    initialized: false,
    pending: new Map(),
    docs: new Map(),
    nextId: 1,
    stdoutBuf: Buffer.alloc(0),
    idleTimer: null,
    initPromise: null,
  };
}

function resetIdleTimer() {
  if (!_state) return;
  if (_state.idleTimer) clearTimeout(_state.idleTimer);
  _state.idleTimer = setTimeout(() => killServer('idle'), IDLE_MS);
}

function killServer(reason = 'manual') {
  if (!_state) return;
  const st = _state;
  _state = null;
  if (st.idleTimer) clearTimeout(st.idleTimer);
  for (const { reject } of st.pending.values()) {
    try { reject(new Error(`LSP server shut down (${reason})`)); } catch {}
  }
  try { st.child?.kill(); } catch {}
}

async function resolveLspExe() {
  // typescript-language-server is a peer / direct dep. Resolve it via
  // require.resolve so the symlinked .bin lookup works the same on every
  // platform (spawn('.bin/tsserver.cmd') is brittle on Windows when the
  // plugin is linked from a custom marketplace path).
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve('typescript-language-server/package.json');
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['typescript-language-server'];
    if (!bin) throw new Error('typescript-language-server package has no bin entry');
    return pathResolve(dirname(pkgJson), bin);
  } catch (e) {
    const hint = 'Install with: npm install --prefix ' + (process.env.CLAUDE_PLUGIN_ROOT || 'plugin-root')
      + ' typescript-language-server typescript';
    throw new Error(`typescript-language-server not found (${e.message}). ${hint}`);
  }
}

async function startServer(cwd) {
  if (_state && _state.initialized && _state.cwd === cwd) {
    resetIdleTimer();
    return _state;
  }
  if (_state && _state.cwd !== cwd) {
    // Different workspace root — tear the old one down. Keeping a stale
    // rootUri would make the server resolve tsconfig.json / node_modules
    // from the wrong tree.
    killServer('cwd-change');
  }
  if (_state && _state.initPromise) return _state.initPromise;

  _state = freshState();
  _state.cwd = cwd;
  _state.initPromise = (async () => {
    const exe = await resolveLspExe();
    const child = spawn(process.execPath, [exe, '--stdio'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });
    _state.child = child;
    child.on('error', (e) => {
      process.stderr.write(`[lsp] spawn error: ${e.message}\n`);
      killServer('spawn-error');
    });
    child.on('exit', (code, sig) => {
      process.stderr.write(`[lsp] server exit code=${code} sig=${sig || '-'}\n`);
      if (_state) killServer('child-exit');
    });
    child.stdout.on('data', (chunk) => {
      if (!_state) return;
      _state.stdoutBuf = Buffer.concat([_state.stdoutBuf, chunk]);
      parseMessages();
    });
    child.stderr.on('data', (c) => {
      const line = c.toString('utf8').trim();
      if (line) process.stderr.write(`[lsp] ${line}\n`);
    });

    const initResult = await sendRequest('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(cwd).href,
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
      clientInfo: { name: 'trib-plugin-lsp', version: '0.1' },
    });
    sendNotification('initialized', {});
    _state.initialized = true;
    _state.capabilities = initResult?.capabilities || {};
    resetIdleTimer();
    return _state;
  })();

  try {
    return await _state.initPromise;
  } catch (e) {
    killServer('init-failed');
    throw e;
  }
}

function parseMessages() {
  while (_state) {
    const headerEnd = _state.stdoutBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = _state.stdoutBuf.slice(0, headerEnd).toString('utf8');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      _state.stdoutBuf = _state.stdoutBuf.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (_state.stdoutBuf.length < start + len) return;
    const body = _state.stdoutBuf.slice(start, start + len).toString('utf8');
    _state.stdoutBuf = _state.stdoutBuf.slice(start + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id != null && _state.pending.has(msg.id)) {
      const entry = _state.pending.get(msg.id);
      _state.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`LSP ${msg.error.code || ''}: ${msg.error.message || 'error'}`));
      else entry.resolve(msg.result);
    }
    // Notifications (diagnostics, window/logMessage) are ignored — we
    // don't surface them through the tool result. If that becomes useful
    // later, add routing on msg.method here.
  }
}

function sendRaw(msg) {
  if (!_state?.child?.stdin?.writable) throw new Error('LSP server not writable');
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  _state.child.stdin.write(header + body);
}

function sendRequest(method, params) {
  if (!_state) return Promise.reject(new Error('LSP server not started'));
  const id = _state.nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (_state?.pending.has(id)) {
        _state.pending.delete(id);
        reject(new Error(`LSP request timeout (${REQUEST_TIMEOUT_MS}ms): ${method}`));
      }
    }, REQUEST_TIMEOUT_MS);
    const wrap = {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    };
    _state.pending.set(id, wrap);
    try { sendRaw({ jsonrpc: '2.0', id, method, params }); }
    catch (e) { _state.pending.delete(id); clearTimeout(t); reject(e); }
  });
}

function sendNotification(method, params) {
  sendRaw({ jsonrpc: '2.0', method, params });
}

async function ensureDocOpen(absPath) {
  if (_state.docs.has(absPath)) return _state.docs.get(absPath);
  const ext = extname(absPath).toLowerCase();
  const lang = LANG_BY_EXT[ext];
  if (!lang) throw new Error(`unsupported file extension for LSP: ${ext || '(none)'}`);
  // F4 fix: single readFile syscall replaces the prior access() + readFile
  // pair. ENOENT is surfaced with the friendly "file does not exist"
  // message the callers used to emit via access().catch, so the user-
  // facing behaviour is unchanged but one fs round-trip is saved.
  let text;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error(`file does not exist: ${normalizeOutputPath(absPath)}`);
    }
    throw e;
  }
  const uri = pathToFileURL(absPath).href;
  sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: lang, version: 1, text },
  });
  const doc = { uri, lang, text, version: 1 };
  _state.docs.set(absPath, doc);
  // F3 fix: the fixed 150ms sleep was a hot-path penalty on every
  // first-touch file. Cold-index races still happen, but callers now
  // do a single short retry (see queryWithRetry below) only when the
  // first response comes back empty, so the common fast-path incurs
  // zero delay and cold queries pay 50ms once instead of 150ms always.
  return doc;
}

// Retry helper for cold-index races: if the first query returns a
// null / empty-array result (typical on the very first request against
// a file the server hasn't finished indexing), sleep 50ms and retry
// exactly once. sendRequest already has a 30s hard timeout so this
// cannot hang indefinitely. Definition / references / documentSymbol
// all funnel through here so the retry logic is a single location.
async function queryWithRetry(method, params) {
  const first = await sendRequest(method, params);
  if (first && (!Array.isArray(first) || first.length > 0)) return first;
  await new Promise(r => setTimeout(r, 50));
  return sendRequest(method, params);
}

// Lines that are entirely a comment — skip these when anchoring the
// cursor, otherwise the LSP server sees a position inside a comment
// token and returns no definition. Doesn't try to parse mid-line /*…*/
// blocks; the declaration-first pass below handles those by preferring
// real declarations over in-line mentions.
function _isCommentOnlyLine(line) {
  return /^\s*(?:\/\/|\*\s|\*$|\/\*|\*\/)/.test(line);
}

function findSymbolPosition(text, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = text.split(/\r?\n/);

  // Pass 1 — declaration-shaped occurrence. Catches
  //   function foo / async function foo / class foo / const|let|var foo /
  //   export function foo / export class foo / foo = function / foo:
  // so the cursor lands on the defining identifier rather than a stray
  // mention inside a string literal or a re-export.
  const declRe = new RegExp(
    '(?:^|[^A-Za-z0-9_$])'
    + '(?:(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+)'
    + `(${escaped})\\b`,
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (_isCommentOnlyLine(line)) continue;
    const m = line.match(declRe);
    if (m) {
      const idx = line.indexOf(symbol, m.index);
      if (idx >= 0) return { line: i, character: idx };
    }
  }

  // Pass 2 — any word-bounded occurrence on a non-comment line. The LSP
  // server will resolve the cursor semantically from whatever position
  // we give it, so an ordinary usage site works fine as an anchor.
  const anyRe = new RegExp(`\\b${escaped}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (_isCommentOnlyLine(line)) continue;
    const m = line.match(anyRe);
    if (m) return { line: i, character: m.index };
  }
  return null;
}

function resolveAbs(cwd, file) {
  if (!file) return null;
  return isAbsolute(file) ? pathResolve(file) : pathResolve(cwd, file);
}

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

// F7: the former `relativePath(cwd, abs)` helper is now `toDisplayPath`
// in builtin.mjs — one shared function covers every tool that renders
// a cwd-relative, forward-slash path for the model.

// LSP SymbolKind enum (1..26) → short label.
const SYMBOL_KIND = [
  '', 'file', 'module', 'namespace', 'package', 'class', 'method',
  'property', 'field', 'constructor', 'enum', 'interface', 'function',
  'variable', 'constant', 'string', 'number', 'boolean', 'array',
  'object', 'key', 'null', 'enumMember', 'struct', 'event', 'operator',
  'typeParameter',
];

function formatLocations(result, cwd) {
  if (!result) return '(no locations)';
  const arr = Array.isArray(result) ? result : [result];
  if (arr.length === 0) return '(no locations)';
  const lines = [];
  for (const loc of arr) {
    // Location | LocationLink
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetRange || loc.targetSelectionRange;
    if (!uri || !range) continue;
    const p = toDisplayPath(uriToPath(uri), cwd);
    lines.push(`${p}:${range.start.line + 1}:${range.start.character + 1}`);
  }
  return lines.length ? lines.join('\n') : '(no locations)';
}

function formatDocumentSymbols(result) {
  if (!Array.isArray(result) || result.length === 0) return '(no symbols)';
  const lines = [];
  // DocumentSymbol has `children`, SymbolInformation is flat with
  // `location`. Handle both.
  const isHierarchical = result[0] && 'range' in result[0];
  if (isHierarchical) {
    const walk = (syms, indent) => {
      for (const s of syms) {
        const kind = SYMBOL_KIND[s.kind] || 'symbol';
        const ln = (s.selectionRange?.start?.line ?? s.range?.start?.line ?? 0) + 1;
        lines.push(`${'  '.repeat(indent)}${kind} ${s.name} (L${ln})`);
        if (Array.isArray(s.children)) walk(s.children, indent + 1);
      }
    };
    walk(result, 0);
  } else {
    for (const s of result) {
      const kind = SYMBOL_KIND[s.kind] || 'symbol';
      const ln = (s.location?.range?.start?.line ?? 0) + 1;
      const container = s.containerName ? ` [${s.containerName}]` : '';
      lines.push(`${kind} ${s.name}${container} (L${ln})`);
    }
  }
  return lines.join('\n');
}

async function definitionOrReferences(kind, args, cwd) {
  const { symbol, file } = args || {};
  const normFile = normalizeInputPath(file);
  if (!symbol) throw new Error(`${kind}: "symbol" is required`);
  const abs = resolveAbs(cwd, normFile);
  if (!abs) throw new Error(`${kind}: "file" is required (path to a file that contains or imports the symbol)`);
  await startServer(cwd);
  // F4 fix: ensureDocOpen handles ENOENT via a readFile catch so the
  // separate access() probe is gone. Prefix the error with the tool name
  // for callers that still pattern-match on the `kind:` prefix.
  let doc;
  try {
    doc = await ensureDocOpen(abs);
  } catch (e) {
    if (e && /file does not exist/.test(e.message)) {
      throw new Error(`${kind}: ${e.message}`);
    }
    throw e;
  }
  const pos = findSymbolPosition(doc.text, symbol);
  if (!pos) return `symbol "${symbol}" not found in ${toDisplayPath(abs, cwd)}`;
  const method = kind === 'lsp_definition' ? 'textDocument/definition' : 'textDocument/references';
  const params = {
    textDocument: { uri: doc.uri },
    position: pos,
  };
  if (kind === 'lsp_references') params.context = { includeDeclaration: true };
  // F3: cold-index safe retry instead of a blanket 150ms sleep.
  const result = await queryWithRetry(method, params);
  resetIdleTimer();
  return formatLocations(result, cwd);
}

async function documentSymbols(args, cwd) {
  const { file } = args || {};
  const normFile = normalizeInputPath(file);
  const abs = resolveAbs(cwd, normFile);
  if (!abs) throw new Error('lsp_symbols: "file" is required');
  await startServer(cwd);
  let doc;
  try {
    doc = await ensureDocOpen(abs);
  } catch (e) {
    if (e && /file does not exist/.test(e.message)) {
      throw new Error(`lsp_symbols: ${e.message}`);
    }
    throw e;
  }
  const result = await queryWithRetry('textDocument/documentSymbol', {
    textDocument: { uri: doc.uri },
  });
  resetIdleTimer();
  return formatDocumentSymbols(result);
}

// Tool definitions consumed by build-tools-manifest. Shape mirrors
// tools.json — title / annotations / description / inputSchema — so the
// build output is bit-identical to the hand-maintained entries before
// this file was integrated into MODULES.
export const LSP_TOOL_DEFS = [
  {
    name: 'lsp_definition',
    title: 'LSP Definition',
    annotations: { title: 'LSP Definition', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Resolve a symbol to its canonical definition via the TypeScript language server. Pass `symbol` (the name to resolve) and `file` (a TS/JS/MJS file that contains or imports the symbol). Returns one or more `path:line:col` locations. Prefer this over `grep` for any symbol that appears in multiple files — the LSP picks THE definition, grep picks every textual match. Only TypeScript / JavaScript files are supported (.ts .tsx .js .jsx .mjs .cjs).',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to resolve (identifier, class, function, method).' },
        file: { type: 'string', description: 'Absolute or cwd-relative path to a file that contains or imports the symbol. The server anchors its semantic analysis from this document.' },
      },
      required: ['symbol', 'file'],
    },
  },
  {
    name: 'lsp_references',
    title: 'LSP References',
    annotations: { title: 'LSP References', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'List every call site / reference of a symbol across the workspace, using the TypeScript language server. Pass `symbol` and `file` (same contract as `lsp_definition`). Returns a newline-separated `path:line:col` listing, declaration included. Unlike grep, unrelated occurrences of the same name (different scopes, shadowed vars) are excluded.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to look up references for.' },
        file: { type: 'string', description: 'Absolute or cwd-relative path to a file that contains the symbol. Used to anchor the LSP cursor.' },
      },
      required: ['symbol', 'file'],
    },
  },
  {
    name: 'lsp_symbols',
    title: 'LSP Document Symbols',
    annotations: { title: 'LSP Document Symbols', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Outline a TS/JS file: class / function / method / variable declarations with line numbers, hierarchical when the server supports it. Pass `file`. Good first pass before diving in — shows the shape of a file without reading its body.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute or cwd-relative path to the TS/JS file to outline.' },
      },
      required: ['file'],
    },
  },
];

export async function executeLspTool(name, args, cwd) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'lsp_definition': return definitionOrReferences('lsp_definition', args, effectiveCwd);
    case 'lsp_references': return definitionOrReferences('lsp_references', args, effectiveCwd);
    case 'lsp_symbols': return documentSymbols(args, effectiveCwd);
    default: throw new Error(`Unknown LSP tool: ${name}`);
  }
}

export function shutdownLspServer() { killServer('shutdown'); }
