import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const EXPERT_ROOT = join(REPO_ROOT, 'expert-library');
const INDEX_PATH = join(EXPERT_ROOT, 'indexes', 'expert-index.json');
const MAX_READ_BYTES = 24000;
const DEFAULT_READ_BYTES = 12000;

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

function resolveExpertPath(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('Invalid expert path');
  }
  if (repoPath.includes('..')) {
    throw new Error('Refusing expert path traversal');
  }
  const absolute = resolve(REPO_ROOT, repoPath);
  if (!pathUnder(EXPERT_ROOT, absolute)) {
    throw new Error('Refusing out-of-tree expert path');
  }
  return absolute;
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

export function loadExpertIndex({ indexPath = INDEX_PATH } = {}) {
  if (!existsSync(indexPath)) {
    return { experts: [], error: null, indexPath };
  }
  try {
    const data = readJson(indexPath);
    const experts = Array.isArray(data.experts) ? data.experts : [];
    return { experts, error: null, indexPath };
  } catch (error) {
    return { experts: [], error: error.message, indexPath };
  }
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

export function readExpert({ name, includeReferences = false, maxBytes = DEFAULT_READ_BYTES } = {}) {
  const expert = findExpert(name);
  const sourcePath = resolveExpertPath(expert.sourcePath);
  const content = readTextBounded(sourcePath, maxBytes);
  const references = includeReferences
    ? (expert.references || []).slice(0, 10).map((ref) => {
        const refPath = resolveExpertPath(ref.path);
        return { alias: ref.alias || basename(ref.path), path: ref.path, ...readTextBounded(refPath, 4000) };
      })
    : (expert.references || []).map((ref) => ({ alias: ref.alias || basename(ref.path), path: ref.path }));
  return {
    name: expert.name,
    domain: expert.domain,
    summary: expert.summary,
    reviewStatus: expert.review?.status || 'unreviewed',
    sourcePath: relative(REPO_ROOT, sourcePath).replace(/\\/g, '/'),
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
  const refPath = resolveExpertPath(selected.path);
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
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ experts, error }, null, 2),
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
