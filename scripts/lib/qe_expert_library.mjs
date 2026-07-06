import { existsSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const EXPERT_ROOT = join(REPO_ROOT, 'expert-library');
const CORE_INDEX_PATH = join(EXPERT_ROOT, 'indexes', 'core-index.json');
const MAX_READ_BYTES = 24000;
const DEFAULT_READ_BYTES = 12000;
// Pack index schemaVersion this loader understands. A non-core pack whose index
// declares a different version is refused at merge time (version-skew guard).
const EXPECTED_SCHEMA_VERSION = 1;
// Standard install location the `packs install extra-experts` CLI deploys to and
// the loader auto-detects without any environment variable.
const STANDARD_EXTRA_ROOT = join(homedir(), '.qe', 'mcp', 'packs', 'extra-experts');

// The core pack always ships in-tree. The extra pack is optional: it is loaded
// only when its root is discoverable via QE_EXTRA_EXPERTS_ROOT, the standard
// install path, or an installed @inho-team/qe-experts-extra package. Each root
// carries its own repoRoot (the base sourcePaths are relative to) and expertRoot
// (the allowlist boundary).
const CORE_ROOT = {
  pack: 'core-experts',
  repoRoot: REPO_ROOT,
  expertRoot: EXPERT_ROOT,
  indexPath: CORE_INDEX_PATH,
};

// Locate an installed extra pack. Supports both the flat package layout
// (<base>/extra-index.json + <base>/experts/) and an in-tree expert-library
// layout, returning the first candidate that resolves an index.
function resolveExtraRoot() {
  if (process.env.QE_DISABLE_EXTRA_PACK === '1') return null;
  const candidates = [];
  if (process.env.QE_EXTRA_EXPERTS_ROOT) candidates.push(process.env.QE_EXTRA_EXPERTS_ROOT);
  candidates.push(STANDARD_EXTRA_ROOT);
  candidates.push(join(REPO_ROOT, 'node_modules', '@inho-team', 'qe-experts-extra'));
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const base = resolve(candidate);
    const expertRoot = existsSync(join(base, 'expert-library'))
      ? join(base, 'expert-library')
      : base;
    const indexPath = [
      join(base, 'extra-index.json'),
      join(expertRoot, 'indexes', 'extra-index.json'),
      join(base, 'indexes', 'extra-index.json'),
    ].find((p) => existsSync(p));
    if (indexPath) return { pack: 'extra-experts', repoRoot: base, expertRoot, indexPath };
  }
  return null;
}

function getExpertRoots() {
  const roots = [CORE_ROOT];
  const extra = resolveExtraRoot();
  if (extra) roots.push(extra);
  return roots;
}

// The standard install path the extra pack is deployed to and auto-detected from.
export function getStandardExtraRoot() {
  return STANDARD_EXTRA_ROOT;
}

// Report installed packs, their roots, expert counts, and schemaVersion — the
// data surface behind the `qe-mcp packs list|status` CLI.
export function describePacks() {
  const roots = getExpertRoots();
  const extra = roots.find((r) => r.pack === 'extra-experts');
  const readIndex = (root) => {
    try { return readJson(root.indexPath); } catch { return null; }
  };
  const coreData = readIndex(CORE_ROOT);
  const describe = (root, data) => ({
    installed: true,
    root: root.repoRoot,
    indexPath: root.indexPath,
    count: data && Array.isArray(data.experts) ? data.experts.length : 0,
    schemaVersion: data ? data.schemaVersion : null,
    schemaOk: !data || data.schemaVersion === EXPECTED_SCHEMA_VERSION,
  });
  return {
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    standardExtraRoot: STANDARD_EXTRA_ROOT,
    packs: {
      'core-experts': describe(CORE_ROOT, coreData),
      'extra-experts': extra
        ? describe(extra, readIndex(extra))
        : { installed: false, root: STANDARD_EXTRA_ROOT, indexPath: null, count: 0, schemaVersion: null, schemaOk: true },
    },
  };
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pathUnder(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}

// Resolve an expert-relative path against a specific registered root and refuse
// anything that escapes that root's expert boundary. The allowlist is the set of
// registered roots (core + optional extra) — an arbitrary path under neither is
// still hard-refused, preserving the original security guarantee across roots.
function resolveExpertPath(repoPath, { repoRoot = REPO_ROOT, expertRoot = EXPERT_ROOT } = {}) {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('Invalid expert path');
  }
  if (repoPath.includes('..')) {
    throw new Error('Refusing expert path traversal');
  }
  const absolute = resolve(repoRoot, repoPath);
  if (!pathUnder(expertRoot, absolute)) {
    throw new Error('Refusing out-of-tree expert path');
  }
  // Symlink guard: resolve() is lexical and readFileSync follows symlinks, so a
  // pack could ship experts/leak -> /etc/passwd and pass the lexical check. Re-check
  // the real (symlink-resolved) path against the real boundary at point of use.
  // Normalizing both sides also avoids false positives on platforms where the
  // root itself contains a symlink (e.g. macOS /var -> /private/var).
  if (existsSync(absolute)) {
    const realBoundary = existsSync(expertRoot) ? realpathSync(expertRoot) : resolve(expertRoot);
    if (!pathUnder(realBoundary, realpathSync(absolute))) {
      throw new Error('Refusing symlinked expert path');
    }
  }
  return absolute;
}

// Root descriptor an expert entry was loaded from, used to resolve its files.
function rootForExpert(expert) {
  return {
    repoRoot: expert && expert._repoRoot ? expert._repoRoot : REPO_ROOT,
    expertRoot: expert && expert._expertRoot ? expert._expertRoot : EXPERT_ROOT,
  };
}

function readTextBounded(path, maxBytes = DEFAULT_READ_BYTES) {
  const limit = clampInt(maxBytes, DEFAULT_READ_BYTES, 200, MAX_READ_BYTES);
  const data = readFileSync(path);
  const slice = data.subarray(0, limit);
  return {
    text: slice.toString('utf8'),
    truncated: data.length > limit,
    bytes: Math.min(data.length, limit),
    totalBytes: data.length,
  };
}

// Load and merge every registered pack index into one expert list. Core is loaded
// first, so on a name collision the core entry wins and the duplicate is dropped
// with a recorded warning. Each returned expert is tagged with its root descriptor
// (_repoRoot/_expertRoot) so its files resolve against the pack it came from.
// A single explicit `indexPath` (tests / legacy callers) bypasses multi-root merge.
export function loadExpertIndex({ indexPath = null } = {}) {
  const roots = indexPath
    ? [{ pack: 'explicit', repoRoot: REPO_ROOT, expertRoot: EXPERT_ROOT, indexPath }]
    : getExpertRoots();
  const experts = [];
  const byName = new Map();
  const warnings = [];
  let error = null;
  for (const root of roots) {
    if (!existsSync(root.indexPath)) continue;
    try {
      const data = readJson(root.indexPath);
      // Version-skew guard: refuse to merge a non-core pack whose index declares
      // a schemaVersion this loader does not understand.
      if (root.pack !== 'core-experts' && data.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
        warnings.push(
          `Extra pack "${root.pack}" schemaVersion ${data.schemaVersion} != expected `
          + `${EXPECTED_SCHEMA_VERSION}; merge refused. Update the pack or qe-mcp.`,
        );
        continue;
      }
      const entries = Array.isArray(data.experts) ? data.experts : [];
      for (const entry of entries) {
        const key = normalizeName(entry.name);
        if (byName.has(key)) {
          warnings.push(`Duplicate expert "${entry.name}" in ${root.pack} ignored (core wins).`);
          continue;
        }
        const tagged = { ...entry, _repoRoot: root.repoRoot, _expertRoot: root.expertRoot };
        byName.set(key, tagged);
        experts.push(tagged);
      }
    } catch (err) {
      error = error ? `${error}; ${err.message}` : err.message;
    }
  }
  return { experts, error, warnings, roots };
}

export function listExpertPacks() {
  const { experts, error } = loadExpertIndex();
  const packs = new Map();
  for (const expert of experts) {
    const key = expert.pack || 'unknown';
    const current = packs.get(key) || { pack: key, count: 0, domains: new Set() };
    current.count += 1;
    if (expert.domain) current.domains.add(expert.domain);
    packs.set(key, current);
  }
  return {
    packs: [...packs.values()].map((pack) => ({
      pack: pack.pack,
      count: pack.count,
      domains: [...pack.domains].sort(),
    })),
    error,
  };
}

function textForSearch(expert) {
  return [
    expert.name,
    expert.domain,
    expert.summary,
    expert.relatedCoreSkill,
    ...(expert.invocationTriggers || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function scoreExpert(expert, queryTokens) {
  if (queryTokens.length === 0) return 1;
  const name = normalizeName(expert.name);
  const haystack = textForSearch(expert);
  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (name === token) score += 10;
    else if (name.includes(token)) score += 6;
    if (haystack.includes(token)) score += 2;
  }
  return score;
}

export function searchExperts({ query = '', domain = '', limit = 10, includeDeprecated = false } = {}) {
  const { experts, error } = loadExpertIndex();
  if (error) return { results: [], error };

  const domainFilter = normalizeName(domain);
  const queryTokens = String(query || '').toLowerCase().split(/[^a-z0-9#+.-]+/).filter(Boolean);
  const max = clampInt(limit, 10, 1, 50);

  const results = experts
    .filter((expert) => !domainFilter || normalizeName(expert.domain) === domainFilter)
    .filter((expert) => includeDeprecated || !['deprecated', 'rejected'].includes(expert.review?.status))
    .map((expert) => ({ expert, score: scoreExpert(expert, queryTokens) }))
    .filter((item) => queryTokens.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.expert.name).localeCompare(String(b.expert.name)))
    .slice(0, max)
    .map(({ expert, score }) => ({
      name: expert.name,
      domain: expert.domain,
      summary: expert.summary,
      relatedCoreSkill: expert.relatedCoreSkill,
      reviewStatus: expert.review?.status || 'unreviewed',
      readTool: 'qe_read_expert',
      score,
    }));

  return { results, error: null };
}

export function recommendExpert({ task = '', client = '', maxRecommendations = 3 } = {}) {
  const limit = clampInt(maxRecommendations, 3, 1, 10);
  const { results, error } = searchExperts({ query: task, limit });
  if (error) return { recommendations: [], error };
  return {
    recommendations: results.map((result) => ({
      ...result,
      reason: `Matched task terms against ${result.domain} expert metadata.`,
      riskCaveat: result.reviewStatus === 'reviewed'
        ? 'Reviewed expert guidance.'
        : 'Preserved optional-catalog guidance; verify current APIs before implementation.',
      nextCall: { tool: 'qe_read_expert', arguments: { name: result.name } },
      fallbackCoreSkill: result.relatedCoreSkill || 'Qrun-task',
      client: client || 'unspecified',
    })),
    error: null,
  };
}

export function findExpert(name) {
  const { experts, error } = loadExpertIndex();
  if (error) throw new Error(`Expert index unavailable: ${error}`);
  const normalized = normalizeName(name);
  const expert = experts.find((item) => normalizeName(item.name) === normalized);
  if (!expert) throw new Error(`Unknown expert: ${name}`);
  return expert;
}

// Parse markdown ATX headers that sit OUTSIDE fenced code blocks. A `#` line
// inside a ``` or ~~~ fence (e.g. a shell/python comment) is not a header.
// Returns the file lines plus the located headers with their line indices.
function parseMarkdownHeaders(text) {
  const lines = text.split('\n');
  const headers = [];
  let fenceChar = null;
  for (let i = 0; i < lines.length; i += 1) {
    const fenceMatch = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fenceChar === null) fenceChar = marker;
      else if (fenceChar === marker) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const header = lines[i].match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (header) headers.push({ level: header[1].length, title: header[2].trim(), line: i });
  }
  return { lines, headers };
}

// Extract a single markdown section by fuzzy title match. The section runs from
// its header to the next header of equal-or-higher level (nested lower headers
// are included). Returns { block, title } on a unique match, { matches } for
// disambiguation, or { available } when nothing matched.
function extractSection(text, wanted) {
  const { lines, headers } = parseMarkdownHeaders(text);
  const want = normalizeName(wanted);
  const exact = headers.filter((h) => normalizeName(h.title) === want);
  const matches = exact.length > 0 ? exact : headers.filter((h) => normalizeName(h.title).includes(want));
  if (matches.length === 0) return { available: headers.map((h) => h.title) };
  if (matches.length > 1) return { matches: matches.map((h) => h.title) };
  const selected = matches[0];
  let endLine = lines.length;
  for (const h of headers) {
    if (h.line > selected.line && h.level <= selected.level) { endLine = h.line; break; }
  }
  return { title: selected.title, block: lines.slice(selected.line, endLine).join('\n') };
}

function boundText(str, maxBytes) {
  const limit = clampInt(maxBytes, DEFAULT_READ_BYTES, 200, MAX_READ_BYTES);
  const buf = Buffer.from(str, 'utf8');
  const slice = buf.subarray(0, limit);
  return { text: slice.toString('utf8'), truncated: buf.length > limit, bytes: Math.min(buf.length, limit), totalBytes: buf.length };
}

export function readExpert({ name, includeReferences = false, maxBytes = DEFAULT_READ_BYTES, section = null } = {}) {
  const expert = findExpert(name);
  const root = rootForExpert(expert);
  const sourcePath = resolveExpertPath(expert.sourcePath, root);
  let content;
  let selectedSection = null;
  if (section) {
    // Parse the WHOLE file (the 50KB size gate keeps this bounded) before applying
    // maxBytes, so sections near the end are not lost to an early read cap.
    const full = readFileSync(sourcePath, 'utf8');
    const result = extractSection(full, section);
    if (result.matches) {
      return {
        name: expert.name,
        section: null,
        matches: result.matches,
        note: 'Multiple sections matched; retry with a more specific section title.',
      };
    }
    if (!result.block) {
      const available = (result.available || []).join(' | ') || '(no headers)';
      throw new Error(`Unknown section "${section}". Available sections: ${available}`);
    }
    selectedSection = result.title;
    content = boundText(result.block, maxBytes);
  } else {
    content = readTextBounded(sourcePath, maxBytes);
  }
  const references = includeReferences
    ? (expert.references || []).slice(0, 10).map((ref) => {
        const refPath = resolveExpertPath(ref.path, root);
        return { alias: ref.alias || basename(ref.path), path: ref.path, ...readTextBounded(refPath, 4000) };
      })
    : (expert.references || []).map((ref) => ({ alias: ref.alias || basename(ref.path), path: ref.path }));
  return {
    name: expert.name,
    domain: expert.domain,
    summary: expert.summary,
    reviewStatus: expert.review?.status || 'unreviewed',
    sourcePath: relative(root.repoRoot, sourcePath).replace(/\\/g, '/'),
    section: selectedSection,
    content: content.text,
    truncated: content.truncated,
    bytes: content.bytes,
    totalBytes: content.totalBytes,
    references,
  };
}

export function readMethodology({ expert: expertName, reference, maxBytes = DEFAULT_READ_BYTES } = {}) {
  const expert = findExpert(expertName);
  const wanted = normalizeName(reference);
  if (!wanted) throw new Error('reference is required');
  const matches = (expert.references || []).filter((ref) => {
    const alias = normalizeName(ref.alias);
    const stem = normalizeName(basename(ref.path || '').replace(/\.[^.]+$/, ''));
    return alias === wanted || stem === wanted || alias.includes(wanted) || stem.includes(wanted);
  });
  if (matches.length === 0) throw new Error(`Unknown methodology reference: ${reference}`);
  if (matches.length > 1) {
    return {
      expert: expert.name,
      matches: matches.map((ref) => ({ alias: ref.alias, path: ref.path })),
      note: 'Multiple references matched; retry with a more specific reference alias.',
    };
  }
  const selected = matches[0];
  const refPath = resolveExpertPath(selected.path, rootForExpert(expert));
  const content = readTextBounded(refPath, maxBytes);
  return {
    expert: expert.name,
    alias: selected.alias,
    path: selected.path,
    content: content.text,
    truncated: content.truncated,
    bytes: content.bytes,
    totalBytes: content.totalBytes,
  };
}

export function buildExpertPrompt({ expert: expertName, task = '', mode = 'apply', maxBytes = 16000 } = {}) {
  const expert = readExpert({ name: expertName, includeReferences: false, maxBytes });
  const selectedMode = ['apply', 'review', 'plan'].includes(mode) ? mode : 'apply';
  return {
    expert: expert.name,
    mode: selectedMode,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Use QE expert "${expert.name}" in ${selectedMode} mode.`,
            `Review status: ${expert.reviewStatus}.`,
            expert.reviewStatus === 'reviewed' ? '' : 'Treat this as preserved guidance and verify current APIs before implementation.',
            task ? `Task context: ${task}` : '',
            '',
            expert.content,
          ].filter(Boolean).join('\n'),
        },
      },
    ],
    truncated: expert.truncated,
  };
}

export function listExpertResources() {
  const { experts } = loadExpertIndex();
  const packResources = listExpertPacks().packs.map((pack) => ({
    uri: `qe://expert-packs/${encodeURIComponent(pack.pack)}`,
    name: `${pack.pack} expert pack`,
    description: `${pack.count} experts across ${pack.domains.join(', ') || 'unknown domains'}`,
    mimeType: 'application/json',
  }));
  const expertResources = experts.map((expert) => ({
    uri: `qe://experts/${encodeURIComponent(expert.name)}`,
    name: `${expert.name} expert`,
    description: expert.summary || expert.sourcePath,
    mimeType: 'text/markdown',
  }));
  return [
    {
      uri: 'qe://experts/catalog',
      name: 'QE Expert Catalog',
      description: 'Compact catalog of passive optional QE experts.',
      mimeType: 'application/json',
    },
    ...packResources,
    ...expertResources,
  ];
}

export function readExpertResource(uri) {
  if (uri === 'qe://experts/catalog') {
    const { experts, error } = loadExpertIndex();
    // Strip internal root descriptors (absolute paths) before publishing.
    const publicExperts = experts.map(({ _repoRoot, _expertRoot, ...rest }) => rest);
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ experts: publicExperts, error }, null, 2),
      }],
    };
  }

  const packMatch = uri.match(/^qe:\/\/expert-packs\/(.+)$/);
  if (packMatch) {
    const pack = decodeURIComponent(packMatch[1]);
    const packs = listExpertPacks();
    const found = packs.packs.find((item) => item.pack === pack);
    if (!found) throw new Error(`Unknown expert pack: ${pack}`);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(found, null, 2) }],
    };
  }

  const expertMatch = uri.match(/^qe:\/\/experts\/([^/]+)(?:\/references)?$/);
  if (expertMatch) {
    const expert = readExpert({ name: decodeURIComponent(expertMatch[1]), includeReferences: uri.endsWith('/references') });
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: expert.content }],
    };
  }

  throw new Error(`Unsupported expert resource URI: ${uri}`);
}
