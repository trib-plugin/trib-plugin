import { createHash } from 'node:crypto';
import { resolve as pathResolve, extname, isAbsolute, dirname, relative as pathRelative, join } from 'node:path';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import {
  normalizeInputPath,
  normalizeOutputPath,
  toDisplayPath,
  isSafePath,
  computeUnifiedDiff,
} from './builtin.mjs';
import { executePatchTool } from './patch.mjs';
import { getPluginData } from '../config.mjs';

const CODE_GRAPH_TTL_MS = 30_000;
const CODE_GRAPH_MAX_FILES = 10_000;
const CODE_GRAPH_DISK_FILE = 'code-graph-cache.json';
const CODE_GRAPH_DISK_MAX_ENTRIES = 24;
const CODE_GRAPH_EXT_LANG = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
});
const _codeGraphCache = new Map();
const _diskCodeGraphCache = new Map();
let _diskCodeGraphCacheLoaded = false;
let _diskCodeGraphCacheFlushTimer = null;
const _codeGraphCacheStats = {
  memoryHits: 0,
  memoryMisses: 0,
  diskHits: 0,
  diskMisses: 0,
  reusedNodes: 0,
  rebuiltNodes: 0,
};

function _isCommentOnlyLine(line) {
  return /^\s*(?:\/\/|\*\s|\*$|\/\*|\*\/|#)/.test(line);
}

function _graphLanguage(absPath) {
  return CODE_GRAPH_EXT_LANG[extname(absPath).toLowerCase()] || null;
}

function _isGraphFile(absPath) {
  return Boolean(_graphLanguage(absPath));
}

function _walkGraphFiles(root, acc) {
  if (acc.length >= CODE_GRAPH_MAX_FILES) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (acc.length >= CODE_GRAPH_MAX_FILES) return;
    if (entry.name === 'node_modules'
      || entry.name === '.git'
      || entry.name === 'dist'
      || entry.name === 'build'
      || entry.name === 'target'
      || entry.name === 'vendor'
      || entry.name === '__pycache__'
      || entry.name === 'coverage'
      || entry.name === '.next'
      || entry.name === '.nuxt'
      || entry.name === 'testdata') continue;
    const full = pathResolve(root, entry.name);
    if (entry.isDirectory()) {
      _walkGraphFiles(full, acc);
      continue;
    }
    if (_isGraphFile(full)) acc.push(full);
  }
}

function _normalizeImportSpec(spec) {
  return String(spec || '').trim().replace(/\\/g, '/');
}

function _codeGraphDiskPath() {
  return join(getPluginData(), CODE_GRAPH_DISK_FILE);
}

function _fileFingerprint(rel, stat) {
  return `${rel}|${Number(stat?.mtimeMs || 0)}|${Number(stat?.size || 0)}`;
}

function _computeGraphSignature(fileMetas) {
  const hash = createHash('sha1');
  for (const meta of fileMetas) hash.update(`${meta.fp}\n`);
  return hash.digest('hex');
}

function _serializeGraph(graph) {
  return {
    builtAt: Number(graph?.builtAt || Date.now()),
    signature: String(graph?.signature || ''),
    nodes: [...(graph?.nodes?.values?.() || [])].map((node) => ({
      rel: node.rel,
      lang: node.lang,
      fingerprint: node.fingerprint || '',
      rawImports: Array.isArray(node.rawImports) ? node.rawImports : [],
      resolvedImports: Array.isArray(node.resolvedImportsRel) ? node.resolvedImportsRel : [],
      packageName: node.packageName || '',
      namespaceName: node.namespaceName || '',
      goPackageName: node.goPackageName || '',
      goImportPath: node.goImportPath || '',
      topLevelTypes: Array.isArray(node.topLevelTypes) ? node.topLevelTypes : [],
    })),
  };
}

function _deserializeGraph(cwd, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.nodes)) return null;
  const nodes = new Map();
  const reverse = new Map();
  for (const item of payload.nodes) {
    if (!item || typeof item.rel !== 'string' || typeof item.lang !== 'string') continue;
    const resolvedImportsRel = Array.isArray(item.resolvedImports) ? item.resolvedImports.filter((v) => typeof v === 'string') : [];
    const node = {
      abs: pathResolve(cwd, item.rel),
      rel: item.rel,
      lang: item.lang,
      fingerprint: item.fingerprint || '',
      rawImports: Array.isArray(item.rawImports) ? item.rawImports : [],
      resolvedImportsRel,
      resolvedImports: resolvedImportsRel.map((rel) => pathResolve(cwd, rel)),
      packageName: item.packageName || '',
      namespaceName: item.namespaceName || '',
      goPackageName: item.goPackageName || '',
      goImportPath: item.goImportPath || '',
      topLevelTypes: Array.isArray(item.topLevelTypes) ? item.topLevelTypes : [],
    };
    nodes.set(node.rel, node);
    for (const depRel of resolvedImportsRel) {
      if (!reverse.has(depRel)) reverse.set(depRel, new Set());
      reverse.get(depRel).add(node.rel);
    }
  }
  return {
    cwd,
    nodes,
    reverse,
    builtAt: Number(payload.builtAt || Date.now()),
    signature: String(payload.signature || ''),
  };
}

function _pruneDiskCodeGraphEntries(now = Date.now()) {
  for (const [cwd, entry] of _diskCodeGraphCache) {
    if (!entry || typeof entry !== 'object') {
      _diskCodeGraphCache.delete(cwd);
      continue;
    }
    if (now - Number(entry.builtAt || 0) > CODE_GRAPH_TTL_MS) _diskCodeGraphCache.delete(cwd);
  }
  while (_diskCodeGraphCache.size > CODE_GRAPH_DISK_MAX_ENTRIES) {
    const oldest = _diskCodeGraphCache.keys().next().value;
    if (!oldest) break;
    _diskCodeGraphCache.delete(oldest);
  }
}

function _loadDiskCodeGraphCache(now = Date.now()) {
  if (_diskCodeGraphCacheLoaded) return;
  _diskCodeGraphCacheLoaded = true;
  try {
    const path = _codeGraphDiskPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    for (const [cwd, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      _diskCodeGraphCache.set(cwd, entry);
    }
    _pruneDiskCodeGraphEntries(now);
  } catch {
    // Best-effort only.
  }
}

function _persistDiskCodeGraphCacheNow() {
  try {
    _loadDiskCodeGraphCache();
    _pruneDiskCodeGraphEntries();
    const path = _codeGraphDiskPath();
    mkdirSync(getPluginData(), { recursive: true });
    const payload = Object.fromEntries(_diskCodeGraphCache.entries());
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, path);
  } catch {
    // Best-effort only.
  }
}

function _scheduleDiskCodeGraphCacheFlush() {
  if (_diskCodeGraphCacheFlushTimer) return;
  _diskCodeGraphCacheFlushTimer = setTimeout(() => {
    _diskCodeGraphCacheFlushTimer = null;
    _persistDiskCodeGraphCacheNow();
  }, 250);
  if (typeof _diskCodeGraphCacheFlushTimer.unref === 'function') _diskCodeGraphCacheFlushTimer.unref();
}

function _setDiskCodeGraphEntry(cwd, graph) {
  _loadDiskCodeGraphCache();
  _diskCodeGraphCache.set(cwd, _serializeGraph(graph));
  _pruneDiskCodeGraphEntries();
  _scheduleDiskCodeGraphCacheFlush();
}

function resetCodeGraphCachesForTesting() {
  _codeGraphCache.clear();
  _diskCodeGraphCache.clear();
  _diskCodeGraphCacheLoaded = false;
  _codeGraphCacheStats.memoryHits = 0;
  _codeGraphCacheStats.memoryMisses = 0;
  _codeGraphCacheStats.diskHits = 0;
  _codeGraphCacheStats.diskMisses = 0;
  _codeGraphCacheStats.reusedNodes = 0;
  _codeGraphCacheStats.rebuiltNodes = 0;
  if (_diskCodeGraphCacheFlushTimer) {
    clearTimeout(_diskCodeGraphCacheFlushTimer);
    _diskCodeGraphCacheFlushTimer = null;
  }
}

function _pushIndexSet(map, key, value) {
  if (!key || !value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function _resolveJsLikeImport(absPath, spec) {
  if (!spec.startsWith('.')) return null;
  const base = pathResolve(dirname(absPath), spec);
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    pathResolve(base, 'index.ts'),
    pathResolve(base, 'index.tsx'),
    pathResolve(base, 'index.js'),
    pathResolve(base, 'index.jsx'),
    pathResolve(base, 'index.mjs'),
    pathResolve(base, 'index.cjs'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function _resolvePyImport(absPath, spec, rootDir) {
  if (!spec) return null;
  if (spec.startsWith('.')) {
    const levels = spec.match(/^\.+/)?.[0]?.length || 0;
    const moduleTail = spec.slice(levels).replace(/\./g, '/');
    let base = dirname(absPath);
    for (let i = 1; i < levels; i++) base = dirname(base);
    const target = moduleTail ? pathResolve(base, moduleTail) : base;
    return [`${target}.py`, pathResolve(target, '__init__.py')].find((p) => existsSync(p)) || null;
  }
  const target = pathResolve(rootDir, spec.replace(/\./g, '/'));
  return [`${target}.py`, pathResolve(target, '__init__.py')].find((p) => existsSync(p)) || null;
}

function _resolveInclude(absPath, spec, rootDir) {
  const norm = _normalizeImportSpec(spec);
  const rel = pathResolve(dirname(absPath), norm);
  if (existsSync(rel)) return rel;
  const root = pathResolve(rootDir, norm);
  if (existsSync(root)) return root;
  return null;
}

function _resolveRubyImport(absPath, spec, rootDir) {
  const norm = _normalizeImportSpec(spec);
  const relBase = pathResolve(dirname(absPath), norm);
  const rootBase = pathResolve(rootDir, norm);
  const candidates = [
    `${relBase}.rb`,
    pathResolve(relBase, 'index.rb'),
    `${rootBase}.rb`,
    pathResolve(rootBase, 'index.rb'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function _extractPackageName(text, lang) {
  if (lang === 'java' || lang === 'kotlin') {
    return /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?\s*$/m.exec(String(text || ''))?.[1] || '';
  }
  return '';
}

function _extractNamespaceName(text, lang) {
  if (lang === 'csharp') {
    return /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*[;{]/m.exec(String(text || ''))?.[1] || '';
  }
  return '';
}

function _extractGoPackageName(text) {
  return /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/m.exec(String(text || ''))?.[1] || '';
}

function _extractTopLevelTypeNames(text, lang) {
  const out = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    let match = null;
    if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
      match = /\b(?:class|interface|enum|record|object|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    } else if (lang === 'go') {
      match = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    }
    if (match?.[1]) out.add(match[1]);
  }
  return [...out];
}

function _parseGoModulePath(text) {
  return /^\s*module\s+(\S+)\s*$/m.exec(String(text || ''))?.[1] || '';
}

function _findNearestGoModule(absPath, rootDir, cache) {
  const rootAbs = pathResolve(rootDir);
  let dir = dirname(absPath);
  while (dir.startsWith(rootAbs)) {
    if (cache.has(dir)) return cache.get(dir);
    const goModAbs = pathResolve(dir, 'go.mod');
    if (existsSync(goModAbs)) {
      let modulePath = '';
      try { modulePath = _parseGoModulePath(readFileSync(goModAbs, 'utf8')); } catch { /* ignore */ }
      const info = modulePath ? { moduleRoot: dir, modulePath } : null;
      cache.set(dir, info);
      return info;
    }
    if (dir === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function _extractRawImports(text, lang) {
  const imports = [];
  const push = (v) => { if (v) imports.push(_normalizeImportSpec(v)); };
  if (lang === 'typescript' || lang === 'javascript') {
    const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(text))) push(m[1] || m[2] || m[3]);
  } else if (lang === 'python') {
    let m;
    const fromRe = /^\s*from\s+([.\w]+)\s+import\s+/gm;
    while ((m = fromRe.exec(text))) push(m[1]);
    const importRe = /^\s*import\s+([A-Za-z0-9_., ]+)/gm;
    while ((m = importRe.exec(text))) {
      for (const part of m[1].split(',')) push(part.trim().split(/\s+as\s+/i)[0]);
    }
  } else if (lang === 'go') {
    const re = /import\s*(?:\(([\s\S]*?)\)|"([^"]+)")/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2]) { push(m[2]); continue; }
      const block = m[1] || '';
      const strRe = /"([^"]+)"/g;
      let sm;
      while ((sm = strRe.exec(block))) push(sm[1]);
    }
  } else if (lang === 'rust') {
    let m;
    const re = /^\s*use\s+([^;]+);/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'java' || lang === 'kotlin') {
    let m;
    const re = /^\s*import\s+([^;]+);?$/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'csharp') {
    let m;
    const re = /^\s*using\s+([^;]+);$/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'c' || lang === 'cpp') {
    let m;
    const re = /^\s*#include\s+"([^"]+)"/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'ruby') {
    let m;
    const re = /^\s*require(?:_relative)?\s+["']([^"']+)["']/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'php') {
    let m;
    const re = /^\s*use\s+([^;]+);$/gm;
    while ((m = re.exec(text))) push(m[1]);
  }
  return Array.from(new Set(imports));
}

function _resolveGraphImport(absPath, spec, lang, rootDir) {
  if (lang === 'typescript' || lang === 'javascript') return _resolveJsLikeImport(absPath, spec);
  if (lang === 'python') return _resolvePyImport(absPath, spec, rootDir);
  if (lang === 'c' || lang === 'cpp') return _resolveInclude(absPath, spec, rootDir);
  if (lang === 'ruby') return _resolveRubyImport(absPath, spec, rootDir);
  return null;
}

function _buildGraphIndex(fileInfos) {
  const index = {
    packageMembers: new Map(),
    typeByFqcn: new Map(),
    csharpNamespaces: new Map(),
    goImportPaths: new Map(),
  };
  for (const info of fileInfos) {
    if (info.lang === 'java' || info.lang === 'kotlin') {
      if (info.packageName) _pushIndexSet(index.packageMembers, info.packageName, info.abs);
      for (const typeName of info.topLevelTypes) {
        const fqcn = info.packageName ? `${info.packageName}.${typeName}` : typeName;
        _pushIndexSet(index.typeByFqcn, fqcn, info.abs);
      }
      continue;
    }
    if (info.lang === 'csharp') {
      if (info.namespaceName) _pushIndexSet(index.csharpNamespaces, info.namespaceName, info.abs);
      continue;
    }
    if (info.lang === 'go') {
      if (info.goImportPath) _pushIndexSet(index.goImportPaths, info.goImportPath, info.abs);
    }
  }
  return index;
}

function _normalizeJavaLikeImport(spec) {
  let cleaned = _normalizeImportSpec(spec).replace(/^static\s+/i, '');
  while (cleaned.split('.').length > 1) {
    if (cleaned.endsWith('.*')) return cleaned;
    return cleaned;
  }
  return cleaned;
}

function _resolveIndexedGraphImport(info, spec, rootDir, index) {
  const normalized = _normalizeImportSpec(spec);
  if (!normalized) return [];
  const direct = _resolveGraphImport(info.abs, normalized, info.lang, rootDir);
  if (direct) return [direct];

  if (info.lang === 'go') {
    return [...(index.goImportPaths.get(normalized) || [])];
  }

  if (info.lang === 'java' || info.lang === 'kotlin') {
    let cleaned = _normalizeJavaLikeImport(normalized);
    if (cleaned.endsWith('.*')) {
      return [...(index.packageMembers.get(cleaned.slice(0, -2)) || [])];
    }
    if (index.typeByFqcn.has(cleaned)) return [...index.typeByFqcn.get(cleaned)];
    while (cleaned.split('.').length > 1) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf('.'));
      if (index.typeByFqcn.has(cleaned)) return [...index.typeByFqcn.get(cleaned)];
    }
    return [];
  }

  if (info.lang === 'csharp') {
    let cleaned = normalized.replace(/^static\s+/i, '').trim();
    const alias = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(cleaned);
    if (alias?.[1]) cleaned = alias[1].trim();
    if (index.csharpNamespaces.has(cleaned)) return [...index.csharpNamespaces.get(cleaned)];
    while (cleaned.includes('.')) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf('.'));
      if (index.csharpNamespaces.has(cleaned)) return [...index.csharpNamespaces.get(cleaned)];
    }
    return [];
  }

  return [];
}

function _extractSymbolsCheap(text, lang) {
  const out = _collectCheapSymbols(text, lang).map((item) => `${item.kind} ${item.name} (L${item.line})`);
  return out.length ? out.join('\n') : '(no symbols)';
}

function _collectCheapSymbols(text, lang) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const push = (kind, name, idx) => {
    if (!name) return;
    out.push({ kind, name, line: idx + 1 });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = null;
    if (lang === 'python') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('function', m[1], i);
    } else if (lang === 'go') {
      if ((m = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'rust') {
      if ((m = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
      if ((m = /\b(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'c' || lang === 'cpp') {
      if ((m = /\b(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /^\s*[A-Za-z_][\w\s:*<>~]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'ruby' || lang === 'php') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_:]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_!?=]*)/.exec(line))) push('function', m[1], i);
    }
  }
  return out;
}

function _graphRel(absPath, cwd) {
  return toDisplayPath(absPath, cwd);
}

function _splitLinesKeep(text) {
  const parts = String(text || '').split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '' && String(text || '').endsWith('\n')) parts.pop();
  return parts;
}

function _makeCreatePatch(relPath, content) {
  const lines = _splitLinesKeep(content);
  return [
    `--- /dev/null`,
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function _makeDeletePatch(relPath, content) {
  const lines = _splitLinesKeep(content);
  return [
    `--- a/${relPath}`,
    `+++ /dev/null`,
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((l) => `-${l}`),
    '',
  ].join('\n');
}

function _makeModifyPatch(relPath, before, after) {
  return computeUnifiedDiff(
    _splitLinesKeep(before),
    _splitLinesKeep(after),
    3,
    `a/${relPath}`,
    `b/${relPath}`,
  );
}

function _normalizeRelativeModuleSpec(spec) {
  let out = String(spec || '').replace(/\\/g, '/');
  if (!out.startsWith('.')) out = `./${out}`;
  try { out = out.normalize('NFC'); } catch { /* ignore */ }
  return out;
}

function _hasExplicitExtension(spec) {
  return /\.[A-Za-z0-9]+$/.test(String(spec || ''));
}

function _makeRelativeImportSpec(fromAbs, targetAbs, originalSpec) {
  let relativeSpec = normalizeInputPath(pathRelative(dirname(fromAbs), targetAbs)).replace(/\\/g, '/');
  relativeSpec = _normalizeRelativeModuleSpec(relativeSpec);
  if (!_hasExplicitExtension(originalSpec)) {
    relativeSpec = relativeSpec.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
    if (!/index$/i.test(String(originalSpec || ''))) {
      relativeSpec = relativeSpec.replace(/\/index$/i, '');
    }
  }
  return relativeSpec;
}

function _moduleSpecFromPyPath(absPath, rootDir) {
  const rel = normalizeInputPath(pathRelative(rootDir, absPath)).replace(/\\/g, '/');
  const withoutExt = rel.replace(/\.py$/i, '');
  const noInit = withoutExt.replace(/\/__init__$/i, '');
  return noInit.split('/').filter(Boolean);
}

function _makeRelativePyModuleSpec(fromAbs, targetAbs, originalSpec, rootDir) {
  const targetParts = _moduleSpecFromPyPath(targetAbs, rootDir);
  if (!String(originalSpec || '').startsWith('.')) {
    return targetParts.join('.');
  }
  const fromParts = _moduleSpecFromPyPath(fromAbs, rootDir);
  const fromPkg = extname(fromAbs).toLowerCase() === '.py' && !/__init__\.py$/i.test(fromAbs)
    ? fromParts.slice(0, -1)
    : fromParts;
  let common = 0;
  while (common < fromPkg.length && common < targetParts.length && fromPkg[common] === targetParts[common]) {
    common++;
  }
  const levelsUp = fromPkg.length - common;
  const tail = targetParts.slice(common);
  return `${'.'.repeat(levelsUp + 1)}${tail.join('.')}`;
}

function _makeRelativeIncludeSpec(fromAbs, targetAbs) {
  return normalizeInputPath(pathRelative(dirname(fromAbs), targetAbs)).replace(/\\/g, '/');
}

function _makeRelativeRubySpec(fromAbs, targetAbs) {
  let rel = normalizeInputPath(pathRelative(dirname(fromAbs), targetAbs)).replace(/\\/g, '/');
  rel = rel.replace(/\.rb$/i, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function _rewriteJsModuleText(text, fileAbs, rootDir, rewriter) {
  const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?(["'])([^"']+)\1|require\(\s*(["'])([^"']+)\3\s*\)|import\(\s*(["'])([^"']+)\5\s*\)/g;
  return String(text || '').replace(re, (match, q1, s1, q2, s2, q3, s3) => {
    const spec = s1 || s2 || s3 || '';
    const resolved = _resolveJsLikeImport(fileAbs, spec) || _resolveGraphImport(fileAbs, spec, _graphLanguage(fileAbs), rootDir);
    const next = rewriter(spec, resolved);
    if (!next || next === spec) return match;
    return match.replace(spec, next);
  });
}

function _rewritePyModuleText(text, fileAbs, rootDir, rewriter) {
  let out = String(text || '');
  out = out.replace(/^(\s*from\s+)([.\w]+)(\s+import\s+)/gm, (match, head, spec, tail) => {
    const resolved = _resolvePyImport(fileAbs, spec, rootDir);
    const next = rewriter(spec, resolved, { kind: 'from' });
    return !next || next === spec ? match : `${head}${next}${tail}`;
  });
  out = out.replace(/^(\s*import\s+)([A-Za-z0-9_., ]+)$/gm, (match, head, specList) => {
    const parts = specList.split(',').map((part) => {
      const trimmed = part.trim();
      const base = trimmed.split(/\s+as\s+/i)[0];
      const alias = trimmed.slice(base.length);
      const resolved = _resolvePyImport(fileAbs, base, rootDir);
      const next = rewriter(base, resolved, { kind: 'import' });
      return `${next || base}${alias}`;
    });
    return `${head}${parts.join(', ')}`;
  });
  return out;
}

function _rewriteIncludeText(text, fileAbs, rootDir, rewriter) {
  return String(text || '').replace(/^(\s*#include\s+")([^"]+)(")/gm, (match, head, spec, tail) => {
    const resolved = _resolveInclude(fileAbs, spec, rootDir);
    const next = rewriter(spec, resolved, { kind: 'include' });
    return !next || next === spec ? match : `${head}${next}${tail}`;
  });
}

function _rewriteRubyModuleText(text, fileAbs, rootDir, rewriter) {
  return String(text || '').replace(/^(\s*require(?:_relative)?\s+["'])([^"']+)(["'])/gm, (match, head, spec, tail) => {
    const resolved = _resolveRubyImport(fileAbs, spec, rootDir);
    const next = rewriter(spec, resolved, { kind: 'require' });
    return !next || next === spec ? match : `${head}${next}${tail}`;
  });
}

function _rewriteModuleText(text, fileAbs, rootDir, lang, rewriter) {
  if (lang === 'typescript' || lang === 'javascript') {
    return _rewriteJsModuleText(text, fileAbs, rootDir, rewriter);
  }
  if (lang === 'python') {
    return _rewritePyModuleText(text, fileAbs, rootDir, rewriter);
  }
  if (lang === 'c' || lang === 'cpp') {
    return _rewriteIncludeText(text, fileAbs, rootDir, rewriter);
  }
  if (lang === 'ruby') {
    return _rewriteRubyModuleText(text, fileAbs, rootDir, rewriter);
  }
  return text;
}

function _supportsHashComments(lang) {
  return lang === 'python' || lang === 'ruby' || lang === 'php';
}

function _supportsSlashComments(lang) {
  return lang !== 'python' && lang !== 'ruby';
}

function _supportsSingleQuoteStrings(lang) {
  return lang === 'typescript'
    || lang === 'javascript'
    || lang === 'python'
    || lang === 'ruby'
    || lang === 'php';
}

function _supportsBacktickStrings(lang) {
  return lang === 'typescript' || lang === 'javascript' || lang === 'go';
}

function _supportsTripleQuoteStrings(lang) {
  return lang === 'python' || lang === 'kotlin';
}

function _maskNonCodeText(text, lang) {
  const src = String(text || '');
  const out = src.split('');
  let i = 0;
  let blockComment = false;
  let stringDelim = null;
  while (i < src.length) {
    if (blockComment) {
      if (src.startsWith('*/', i)) {
        out[i] = ' ';
        if (i + 1 < out.length) out[i + 1] = ' ';
        i += 2;
        blockComment = false;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (stringDelim) {
      if ((stringDelim === "'''" || stringDelim === '"""') && src.startsWith(stringDelim, i)) {
        for (let j = 0; j < stringDelim.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += stringDelim.length;
        stringDelim = null;
        continue;
      }
      if ((stringDelim === '\'' || stringDelim === '"' || stringDelim === '`') && src[i] === '\\') {
        if (src[i] !== '\n') out[i] = ' ';
        if (i + 1 < src.length && src[i + 1] !== '\n') out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if ((stringDelim === '\'' || stringDelim === '"' || stringDelim === '`') && src[i] === stringDelim) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
        stringDelim = null;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (_supportsSlashComments(lang) && src.startsWith('/*', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      i += 2;
      blockComment = true;
      continue;
    }
    if (_supportsSlashComments(lang) && src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (_supportsHashComments(lang) && src[i] === '#') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (_supportsTripleQuoteStrings(lang) && src.startsWith("'''", i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stringDelim = "'''";
      continue;
    }
    if (_supportsTripleQuoteStrings(lang) && src.startsWith('"""', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stringDelim = '"""';
      continue;
    }
    if (src[i] === '"' || (_supportsSingleQuoteStrings(lang) && src[i] === '\'') || (_supportsBacktickStrings(lang) && src[i] === '`')) {
      if (src[i] !== '\n') out[i] = ' ';
      stringDelim = src[i];
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

function _symbolMatchIndices(text, symbol, lang) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return [];
  const masked = _maskNonCodeText(text, lang);
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const indices = [];
  let match = null;
  while ((match = re.exec(masked))) {
    indices.push(match.index);
  }
  return indices;
}

function _cheapReferenceSearch(graph, symbol, cwd, { language = null } = {}) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '(no references)';
  const re = new RegExp(`\\b${escaped}\\b`);
  const lines = [];
  for (const node of graph.nodes.values()) {
    if (language && node.lang !== language) continue;
    let text = '';
    try { text = readFileSync(node.abs, 'utf8'); } catch { continue; }
    const fileLines = text.split(/\r?\n/);
    for (let i = 0; i < fileLines.length; i++) {
      const line = fileLines[i];
      if (_isCommentOnlyLine(line)) continue;
      const m = line.match(re);
      if (!m) continue;
      lines.push(`${node.rel}:${i + 1}:${m.index + 1}`);
    }
  }
  return lines.length ? lines.join('\n') : '(no references)';
}

function _collapseReferenceLinesToCallers(referenceText) {
  if (typeof referenceText !== 'string' || !referenceText.trim() || referenceText === '(no references)') {
    return '(no callers)';
  }
  const files = new Set();
  for (const line of referenceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.*?):\d+:\d+$/.exec(trimmed);
    if (m) files.add(m[1]);
  }
  if (files.size === 0) return '(no callers)';
  return [...files].sort().join('\n');
}

function _referenceFiles(referenceText) {
  if (typeof referenceText !== 'string' || !referenceText.trim() || referenceText === '(no references)') {
    return [];
  }
  const files = new Set();
  for (const line of referenceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.*?):\d+:\d+$/.exec(trimmed);
    if (m) files.add(m[1]);
  }
  return [...files].sort();
}

function _parseReferenceEntries(referenceText) {
  if (typeof referenceText !== 'string' || !referenceText.trim() || referenceText === '(no references)') {
    return [];
  }
  const out = [];
  for (const line of referenceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.*?):(\d+):(\d+)$/.exec(trimmed);
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
    });
  }
  return out;
}

function _formatSymbolImpactLine(item) {
  const callerSuffix = item.callers.length ? ` -> ${item.callers.join(', ')}` : '';
  return `${item.symbol}\trefs=${item.references}\tcallers=${item.callers.length}${callerSuffix}`;
}

function _collectImpactSymbols(node) {
  const names = new Set();
  for (const typeName of Array.isArray(node?.topLevelTypes) ? node.topLevelTypes : []) names.add(typeName);
  try {
    const text = readFileSync(node.abs, 'utf8');
    for (const item of _collectCheapSymbols(text, node.lang)) names.add(item.name);
  } catch {
    // Best-effort.
  }
  return [...names];
}

function _buildImpactSummary(node, graph, cwd, targetSymbol = '') {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const related = [...new Set([...imports, ...dependents])].sort();
  const symbols = targetSymbol ? [targetSymbol] : _collectImpactSymbols(node).slice(0, 8);
  const symbolImpact = [];
  const externalCallers = new Set();
  let externalReferences = 0;
  for (const symbol of symbols) {
    const refs = _parseReferenceEntries(_cheapReferenceSearch(graph, symbol, cwd, { language: node.lang }))
      .filter((entry) => entry.file !== node.rel);
    if (refs.length === 0) continue;
    const callers = [...new Set(refs.map((entry) => entry.file))].sort();
    for (const caller of callers) externalCallers.add(caller);
    externalReferences += refs.length;
    symbolImpact.push({
      symbol,
      references: refs.length,
      callers,
    });
  }
  symbolImpact.sort((a, b) => (b.references - a.references) || a.symbol.localeCompare(b.symbol));
  return {
    imports,
    dependents,
    related,
    symbolImpact,
    externalCallers: [...externalCallers].sort(),
    externalReferences,
    scannedSymbols: symbols.length,
  };
}

function _formatRelated(node, graph, cwd) {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const parts = [];
  parts.push(`# imports\n${imports.length ? imports.join('\n') : '(none)'}`);
  parts.push(`# dependents\n${dependents.length ? dependents.join('\n') : '(none)'}`);
  return parts.join('\n\n');
}

function _formatImpact(node, graph, cwd, targetSymbol = '') {
  const summary = _buildImpactSummary(node, graph, cwd, targetSymbol);
  const lines = [
    `file\t${node.rel}`,
    `language\t${node.lang}`,
    `imports\t${summary.imports.length}`,
    `dependents\t${summary.dependents.length}`,
    `related\t${summary.related.length}`,
    `scanned_symbols\t${summary.scannedSymbols}`,
    `external_references\t${summary.externalReferences}`,
    `external_callers\t${summary.externalCallers.length}`,
  ];
  if (targetSymbol) lines.push(`symbol\t${targetSymbol}`);
  if (summary.related.length) {
    lines.push('');
    lines.push('# structural');
    lines.push(...summary.related);
  }
  if (summary.symbolImpact.length) {
    lines.push('');
    lines.push(targetSymbol ? '# symbol impact' : '# top symbol impact');
    lines.push(...summary.symbolImpact.slice(0, 5).map(_formatSymbolImpactLine));
  }
  if (summary.externalCallers.length) {
    lines.push('');
    lines.push('# external callers');
    lines.push(...summary.externalCallers);
  }
  return lines.join('\n');
}

function _buildCodeGraph(cwd) {
  const now = Date.now();
  const absRoot = pathResolve(cwd);
  const files = [];
  _walkGraphFiles(absRoot, files);
  const fileMetas = [];
  for (const abs of files) {
    const lang = _graphLanguage(abs);
    if (!lang) continue;
    let stat = null;
    try { stat = statSync(abs); } catch { continue; }
    const rel = _graphRel(abs, cwd);
    fileMetas.push({ abs, rel, lang, stat, fp: _fileFingerprint(rel, stat) });
  }
  fileMetas.sort((a, b) => a.rel.localeCompare(b.rel));
  const signature = _computeGraphSignature(fileMetas);
  const cached = _codeGraphCache.get(cwd);
  if (cached && cached.signature === signature && now - cached.ts < CODE_GRAPH_TTL_MS) {
    _codeGraphCacheStats.memoryHits++;
    return cached.graph;
  }
  _codeGraphCacheStats.memoryMisses++;
  _loadDiskCodeGraphCache(now);
  const diskEntry = _diskCodeGraphCache.get(cwd);
  let previousGraph = cached?.graph || null;
  if (diskEntry?.signature === signature) {
    const graph = _deserializeGraph(cwd, diskEntry);
    if (graph) {
      _codeGraphCacheStats.diskHits++;
      _codeGraphCache.set(cwd, { ts: now, signature, graph });
      return graph;
    }
  }
  _codeGraphCacheStats.diskMisses++;
  if (!previousGraph && diskEntry) previousGraph = _deserializeGraph(cwd, diskEntry);
  const goModuleCache = new Map();
  const fileInfos = [];
  for (const meta of fileMetas) {
    const goModule = meta.lang === 'go' ? _findNearestGoModule(meta.abs, absRoot, goModuleCache) : null;
    const goImportPath = goModule
      ? [goModule.modulePath, normalizeInputPath(pathRelative(goModule.moduleRoot, dirname(meta.abs))).replace(/\\/g, '/')].filter(Boolean).join('/').replace(/\/$/, '')
      : '';
    const previousNode = previousGraph?.nodes?.get(meta.rel) || null;
    if (previousNode
      && previousNode.fingerprint === meta.fp
      && (meta.lang !== 'go' || previousNode.goImportPath === goImportPath)) {
      fileInfos.push({
        abs: meta.abs,
        rel: meta.rel,
        lang: meta.lang,
        fingerprint: meta.fp,
        rawImports: Array.isArray(previousNode.rawImports) ? previousNode.rawImports : [],
        packageName: previousNode.packageName || '',
        namespaceName: previousNode.namespaceName || '',
        goPackageName: previousNode.goPackageName || '',
        goImportPath: previousNode.goImportPath || goImportPath,
        topLevelTypes: Array.isArray(previousNode.topLevelTypes) ? previousNode.topLevelTypes : [],
      });
      _codeGraphCacheStats.reusedNodes++;
      continue;
    }
    let text = '';
    try { text = readFileSync(meta.abs, 'utf8'); } catch { continue; }
    fileInfos.push({
      abs: meta.abs,
      rel: meta.rel,
      lang: meta.lang,
      fingerprint: meta.fp,
      rawImports: _extractRawImports(text, meta.lang),
      packageName: _extractPackageName(text, meta.lang),
      namespaceName: _extractNamespaceName(text, meta.lang),
      goPackageName: meta.lang === 'go' ? _extractGoPackageName(text) : '',
      goImportPath,
      topLevelTypes: _extractTopLevelTypeNames(text, meta.lang),
    });
    _codeGraphCacheStats.rebuiltNodes++;
  }
  const index = _buildGraphIndex(fileInfos);
  const nodes = new Map();
  const reverse = new Map();
  for (const info of fileInfos) {
    const resolvedImports = Array.from(new Set(
      info.rawImports
        .flatMap((spec) => _resolveIndexedGraphImport(info, spec, absRoot, index))
        .filter(Boolean),
    ));
    const node = {
      abs: info.abs,
      rel: info.rel,
      lang: info.lang,
      fingerprint: info.fingerprint,
      rawImports: info.rawImports,
      resolvedImportsRel: resolvedImports.map((depAbs) => _graphRel(depAbs, cwd)),
      resolvedImports,
      packageName: info.packageName,
      namespaceName: info.namespaceName,
      goPackageName: info.goPackageName,
      goImportPath: info.goImportPath,
      topLevelTypes: info.topLevelTypes,
    };
    nodes.set(info.rel, node);
    for (const depAbs of resolvedImports) {
      const depRel = _graphRel(depAbs, cwd);
      if (!reverse.has(depRel)) reverse.set(depRel, new Set());
      reverse.get(depRel).add(info.rel);
    }
  }
  const graph = { cwd, nodes, reverse, builtAt: now, signature };
  _codeGraphCache.set(cwd, { ts: now, signature, graph });
  _setDiskCodeGraphEntry(cwd, graph);
  return graph;
}

async function codeGraph(args, cwd) {
  const mode = String(args?.mode || '').trim();
  if (!mode) throw new Error('code_graph: "mode" is required');
  const graph = _buildCodeGraph(cwd);
  if (mode === 'overview') {
    const byLang = new Map();
    for (const node of graph.nodes.values()) {
      byLang.set(node.lang, (byLang.get(node.lang) || 0) + 1);
    }
    const lines = [
      `files\t${graph.nodes.size}`,
      `edges\t${Array.from(graph.nodes.values()).reduce((sum, n) => sum + n.resolvedImports.length, 0)}`,
    ];
    for (const [lang, count] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`${lang}\t${count}`);
    }
    return lines.join('\n');
  }

  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile)) : null;
  const rel = abs ? _graphRel(abs, cwd) : null;
  const node = rel ? graph.nodes.get(rel) : null;

  if (mode === 'imports') {
    if (!node) return `code_graph imports: file not found in graph: ${normFile || '(missing file)'}`;
    const resolved = node.resolvedImports.map((p) => _graphRel(p, cwd));
    const parts = [];
    if (resolved.length) parts.push(resolved.join('\n'));
    if (node.rawImports.length) parts.push(`# raw\n${node.rawImports.join('\n')}`);
    return parts.join('\n\n') || '(no imports)';
  }

  if (mode === 'dependents') {
    if (!rel) throw new Error('code_graph dependents: "file" is required');
    const deps = [...(graph.reverse.get(rel) || [])].sort();
    return deps.length ? deps.join('\n') : '(no dependents)';
  }

  if (mode === 'related') {
    if (!node) return `code_graph related: file not found in graph: ${normFile || '(missing file)'}`;
    return _formatRelated(node, graph, cwd);
  }

  if (mode === 'impact') {
    if (!node) return `code_graph impact: file not found in graph: ${normFile || '(missing file)'}`;
    const targetSymbol = String(args?.symbol || '').trim();
    return _formatImpact(node, graph, cwd, targetSymbol);
  }

  if (mode === 'symbols') {
    if (!node) return `code_graph symbols: file not found in graph: ${normFile || '(missing file)'}`;
    let text = '';
    try { text = readFileSync(node.abs, 'utf8'); } catch { return '(no symbols)'; }
    return _extractSymbolsCheap(text, node.lang);
  }

  if (mode === 'references') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph references: "symbol" is required');
    if (!node) return `code_graph references: file not found in graph: ${normFile || '(missing file)'}`;
    return _cheapReferenceSearch(graph, symbol, cwd, { language: node.lang });
  }

  if (mode === 'callers') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph callers: "symbol" is required');
    if (!node) return `code_graph callers: file not found in graph: ${normFile || '(missing file)'}`;
    const refs = _cheapReferenceSearch(graph, symbol, cwd, { language: node.lang });
    return _collapseReferenceLinesToCallers(refs);
  }

  throw new Error(`code_graph: unknown mode "${mode}"`);
}

async function renameFileRefs(args, cwd) {
  const normFile = normalizeInputPath(args?.file);
  const normNewPath = normalizeInputPath(args?.new_path);
  const apply = args?.apply === true;
  if (!normFile) throw new Error('rename_file_refs: "file" is required');
  if (!normNewPath) throw new Error('rename_file_refs: "new_path" is required');
  const oldAbs = isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile);
  const newAbs = isAbsolute(normNewPath) ? pathResolve(normNewPath) : pathResolve(cwd, normNewPath);
  const lang = _graphLanguage(oldAbs);
  if (!lang) return `rename_file_refs: unsupported file type for ${normFile}`;
  if (!isSafePath(normFile, cwd) || !isSafePath(normNewPath, cwd)) {
    return `Error: path outside allowed scope — ${normalizeOutputPath(normFile)} -> ${normalizeOutputPath(normNewPath)}`;
  }
  let oldText = '';
  try { oldText = readFileSync(oldAbs, 'utf8'); }
  catch (err) { return `Error: failed to read source file: ${err?.message || String(err)}`; }
  if (existsSync(newAbs)) {
    return `Error: target already exists: ${normalizeOutputPath(normNewPath)}`;
  }

  const graph = _buildCodeGraph(cwd);
  const oldRel = _graphRel(oldAbs, cwd);
  const dependents = [...(graph.reverse.get(oldRel) || [])].sort();
  const patches = [];
  const planLines = [`move ${oldRel} -> ${_graphRel(newAbs, cwd)}`];

  const movedText = _rewriteModuleText(oldText, oldAbs, pathResolve(cwd), lang, (spec, resolved) => {
    if (!resolved || resolved === oldAbs) return spec;
    if (lang === 'python') return _makeRelativePyModuleSpec(newAbs, resolved, spec, pathResolve(cwd));
    if (lang === 'c' || lang === 'cpp') return _makeRelativeIncludeSpec(newAbs, resolved);
    if (lang === 'ruby') return _makeRelativeRubySpec(newAbs, resolved);
    return _makeRelativeImportSpec(newAbs, resolved, spec);
  });
  patches.push(_makeDeletePatch(oldRel, oldText));
  patches.push(_makeCreatePatch(_graphRel(newAbs, cwd), movedText));

  for (const depRel of dependents) {
    const depAbs = isAbsolute(depRel) ? pathResolve(depRel) : pathResolve(cwd, depRel);
    let depText = '';
    try { depText = readFileSync(depAbs, 'utf8'); } catch { continue; }
    const depLang = _graphLanguage(depAbs);
    const updated = _rewriteModuleText(depText, depAbs, pathResolve(cwd), depLang, (spec, resolved) => {
      if (resolved !== oldAbs) return spec;
      if (depLang === 'python') return _makeRelativePyModuleSpec(depAbs, newAbs, spec, pathResolve(cwd));
      if (depLang === 'c' || depLang === 'cpp') return _makeRelativeIncludeSpec(depAbs, newAbs);
      if (depLang === 'ruby') return _makeRelativeRubySpec(depAbs, newAbs);
      return _makeRelativeImportSpec(depAbs, newAbs, spec);
    });
    if (updated === depText) continue;
    patches.push(_makeModifyPatch(depRel, depText, updated));
    planLines.push(`update importer ${depRel}`);
  }

  const patch = patches.filter(Boolean).join('\n');
  if (!patch.trim()) return '(no file rename changes)';
  if (!apply) {
    const preview = await executePatchTool('apply_patch', { patch, base_path: cwd, dry_run: true }, cwd);
    return `rename_file_refs preview\n${planLines.join('\n')}\n\n${preview}`;
  }
  const applied = await executePatchTool('apply_patch', { patch, base_path: cwd, reject_partial: true }, cwd);
  return `rename_file_refs applied\n${planLines.join('\n')}\n\n${applied}`;
}

function _renameTextOccurrences(text, symbol, next, lang) {
  const src = String(text || '');
  const indices = _symbolMatchIndices(src, symbol, lang);
  if (indices.length === 0) return src;
  let out = src;
  const symbolLen = String(symbol).length;
  for (let i = indices.length - 1; i >= 0; i--) {
    const idx = indices[i];
    out = `${out.slice(0, idx)}${next}${out.slice(idx + symbolLen)}`;
  }
  return out;
}

function _countSymbolOccurrences(text, symbol, lang) {
  return _symbolMatchIndices(text, symbol, lang).length;
}

function _hasDeclarationLikeOccurrence(text, symbol, lang) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  const lines = _maskNonCodeText(text, lang).split(/\r?\n/);
  for (const line of lines) {
    if (_isCommentOnlyLine(line)) continue;
    if (lang === 'python') {
      if (new RegExp(`^\\s*(?:class|def)\\s+${escaped}\\b`).test(line)) return true;
    } else if (lang === 'go') {
      if (new RegExp(`^\\s*(?:type\\s+${escaped}\\b|func(?:\\s*\\([^)]*\\))?\\s+${escaped}\\s*\\()`).test(line)) return true;
    } else if (lang === 'rust') {
      if (new RegExp(`^\\s*(?:pub\\s+)?(?:struct|fn)\\s+${escaped}\\b`).test(line)) return true;
    } else if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
      if (new RegExp(`\\b(?:class|interface|enum)\\s+${escaped}\\b`).test(line)) return true;
      if (new RegExp(`\\b${escaped}\\s*\\(`).test(line)) return true;
    } else if (lang === 'c' || lang === 'cpp') {
      if (new RegExp(`\\b(?:class|struct|enum)\\s+${escaped}\\b`).test(line)) return true;
      if (new RegExp(`\\b${escaped}\\s*\\(`).test(line)) return true;
    } else if (lang === 'ruby' || lang === 'php') {
      if (new RegExp(`^\\s*(?:class|def)\\s+${escaped}\\b`).test(line)) return true;
    } else if (lang === 'typescript' || lang === 'javascript') {
      if (new RegExp(`\\b(?:class|function|const|let|var)\\s+${escaped}\\b`).test(line)) return true;
      if (new RegExp(`\\b${escaped}\\s*\\(`).test(line)) return true;
    }
  }
  return false;
}

function _isLikelyGeneratedPath(rel) {
  const s = String(rel || '').toLowerCase();
  return s.includes('/generated/')
    || s.includes('.generated.')
    || s.endsWith('.gen.ts')
    || s.endsWith('.g.ts')
    || s.endsWith('.designer.cs');
}

function _renameConfidence({ totalOccurrences, fileCount, declarationHits, targetHasDeclaration }) {
  if (!targetHasDeclaration) return 'low';
  if (declarationHits > 1) return 'low';
  if (totalOccurrences <= 10 && fileCount <= 3) return 'high';
  if (totalOccurrences <= 30 && fileCount <= 8) return 'medium';
  return 'low';
}

async function renameSymbolRefs(args, cwd) {
  const symbol = String(args?.symbol || '').trim();
  const next = String(args?.new_name || '').trim();
  const normFile = normalizeInputPath(args?.file);
  const apply = args?.apply === true;
  if (!symbol) throw new Error('rename_symbol_refs: "symbol" is required');
  if (!next) throw new Error('rename_symbol_refs: "new_name" is required');
  if (!normFile) throw new Error('rename_symbol_refs: "file" is required');
  const abs = isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile);
  const lang = _graphLanguage(abs);
  if (!lang) return `rename_symbol_refs: unsupported file type for ${normFile}`;
  const graph = _buildCodeGraph(cwd);
  const refs = _cheapReferenceSearch(graph, symbol, cwd, { language: lang });
  const candidateFiles = new Set(_referenceFiles(refs));
  candidateFiles.add(_graphRel(abs, cwd));
  const plan = [];
  const lines = [];
  let totalOccurrences = 0;
  let declarationHits = 0;
  let targetHasDeclaration = false;
  for (const rel of candidateFiles) {
    const node = graph.nodes.get(rel);
    if (!node || node.lang !== lang) continue;
    if (_isLikelyGeneratedPath(node.rel)) continue;
    let text = '';
    try { text = readFileSync(node.abs, 'utf8'); } catch { continue; }
    const occurrences = _countSymbolOccurrences(text, symbol, lang);
    if (occurrences === 0) continue;
    const hasDeclaration = _hasDeclarationLikeOccurrence(text, symbol, lang);
    if (hasDeclaration) {
      declarationHits++;
      if (node.abs === abs) targetHasDeclaration = true;
    }
    const updated = _renameTextOccurrences(text, symbol, next, lang);
    if (updated === text) continue;
    totalOccurrences += occurrences;
    plan.push({ rel: node.rel, before: text, after: updated, occurrences, hasDeclaration });
    lines.push(`OK   ${node.rel} (${occurrences} matches${hasDeclaration ? ', declaration-like' : ''})`);
  }
  if (plan.length === 0) return '(no rename changes)';
  const confidence = _renameConfidence({
    totalOccurrences,
    fileCount: plan.length,
    declarationHits,
    targetHasDeclaration,
  });
  const patch = plan.map((item) => _makeModifyPatch(item.rel, item.before, item.after)).join('\n');
  if (!apply) {
    const preview = await executePatchTool('apply_patch', { patch, base_path: cwd, dry_run: true }, cwd);
    return `rename_symbol_refs preview: ${plan.length} file(s), ${totalOccurrences} matches, declarations=${declarationHits}, confidence=${confidence}\n${lines.join('\n')}\n\n${preview}`;
  }
  if (confidence === 'low') {
    return `Error: rename_symbol_refs apply refused — confidence=low (${totalOccurrences} matches across ${plan.length} files, declarations=${declarationHits}). Re-run in preview mode and narrow the target file or symbol name.`;
  }
  const applied = await executePatchTool('apply_patch', { patch, base_path: cwd, reject_partial: true }, cwd);
  return `rename_symbol_refs applied: ${plan.length} file(s), ${totalOccurrences} matches, declarations=${declarationHits}, confidence=${confidence}\n${lines.join('\n')}\n\n${applied}`;
}

export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Repository graph / symbol navigation tool. Multi-language common graph for overview/imports/dependents/related/impact/symbols/references/callers using the same graph-oriented workflow across languages.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'references', 'callers'], description: 'Graph query mode.' },
        file: { type: 'string', description: 'Path to the target file. Required for non-overview modes.' },
        symbol: { type: 'string', description: 'Symbol name. Required for references/callers.' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'rename_file_refs',
    title: 'Rename File Refs',
    annotations: { title: 'Rename File Refs', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Rename or move a file and rewrite resolvable file references in the moved file and its local importers using the common code graph. Preview by default; set `apply:true` to write through apply_patch atomically.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Existing file to rename or move.' },
        new_path: { type: 'string', description: 'New path for the file.' },
        apply: { type: 'boolean', description: 'Apply the generated patch to disk. Default false = preview only.' },
      },
      required: ['file', 'new_path'],
    },
  },
  {
    name: 'rename_symbol_refs',
    title: 'Rename Symbol Refs',
    annotations: { title: 'Rename Symbol Refs', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Rename a symbol reference across same-language files using the common code graph and exact token-boundary rewrites. Preview by default; set `apply:true` to write through apply_patch.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Current symbol name to rename.' },
        file: { type: 'string', description: 'File containing or importing the symbol.' },
        new_name: { type: 'string', description: 'New symbol name.' },
        apply: { type: 'boolean', description: 'Apply the rename to disk. Default false = preview only.' },
      },
      required: ['symbol', 'file', 'new_name'],
    },
  },
];

export async function executeCodeGraphTool(name, args, cwd) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'code_graph': return codeGraph(args, effectiveCwd);
    case 'rename_file_refs': return renameFileRefs(args, effectiveCwd);
    case 'rename_symbol_refs': return renameSymbolRefs(args, effectiveCwd);
    default: throw new Error(`Unknown code-graph tool: ${name}`);
  }
}

export function isCodeGraphTool(name) {
  return CODE_GRAPH_TOOL_DEFS.some((t) => t.name === name);
}

export const _internals = {
  resetCodeGraphCachesForTesting,
  persistCodeGraphDiskCacheNow: _persistDiskCodeGraphCacheNow,
  getCodeGraphCacheStatsForTesting: () => ({ ..._codeGraphCacheStats }),
};
