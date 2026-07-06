#!/usr/bin/env node
// Build per-pack expert indexes and manifests from the actual on-disk pack layout.
//
// Scans expert-library/packs/<pack>/skills/Q*/ for authoritative file locations,
// merges rich metadata (domain/summary/triggers/review/...) carried over from the
// previous single index, and emits:
//   - expert-library/indexes/core-index.json   (pack=core-experts)
//   - expert-library/indexes/extra-index.json  (pack=extra-experts)
//   - expert-library/packs/<pack>/manifest.json
//
// The legacy single expert-library/indexes/expert-index.json is replaced by
// core-index.json and removed. Re-running is idempotent: when the structural
// content is unchanged, the previous `generatedAt`/`createdAt` timestamps are
// preserved so output stays byte-stable.

import { createHash } from 'crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..');
const EXPERT_ROOT = join(REPO_ROOT, 'expert-library');
const PACKS_ROOT = join(EXPERT_ROOT, 'packs');
const INDEXES_DIR = join(EXPERT_ROOT, 'indexes');
const LEGACY_INDEX = join(INDEXES_DIR, 'expert-index.json');
const SCHEMA_VERSION = 1;

const PACK_TO_INDEX = {
  'core-experts': join(INDEXES_DIR, 'core-index.json'),
  'extra-experts': join(INDEXES_DIR, 'extra-index.json'),
};

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function repoRel(absPath) {
  return relative(REPO_ROOT, absPath).split('\\').join('/');
}

function sha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function listSkillDirs(packDir) {
  const skillsDir = join(packDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => {
      const p = join(skillsDir, name);
      return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'));
    })
    .sort();
}

function scanReferences(skillDir) {
  const refsDir = join(skillDir, 'references');
  if (!existsSync(refsDir) || !statSync(refsDir).isDirectory()) return [];
  return readdirSync(refsDir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort()
    .map((f) => ({
      alias: basename(f).replace(/\.[^.]+$/, ''),
      path: repoRel(join(refsDir, f)),
    }));
}

// Metadata fields to carry over from the previous index entry (everything except
// physical location, which is re-derived from the scan).
const CARRY_FIELDS = [
  'kind', 'domain', 'summary', 'invocationTriggers', 'relatedCoreSkill',
  'recommendedModel', 'tokenEstimate', 'review', 'clientSupport',
];

function buildEntry(pack, name, skillDir, priorEntry) {
  const entry = { name, kind: 'skill' };
  for (const field of CARRY_FIELDS) {
    if (priorEntry && priorEntry[field] !== undefined) entry[field] = priorEntry[field];
  }
  entry.pack = pack;
  entry.sourcePath = repoRel(join(skillDir, 'SKILL.md'));
  entry.references = scanReferences(skillDir);
  if (!entry.review) entry.review = { status: 'unreviewed', lastReviewed: null };
  return entry;
}

function buildManifestAsset(entry, skillDir, priorAsset) {
  const skillAbs = join(REPO_ROOT, entry.sourcePath);
  return {
    name: entry.name,
    kind: 'skill',
    domain: entry.domain || 'unknown',
    originalPath: (priorAsset && priorAsset.originalPath)
      || `skills-optional/${entry.name}/SKILL.md`,
    expertPath: entry.sourcePath,
    relatedPaths: entry.references.map((r) => r.path),
    checksum: { algorithm: 'sha256', value: sha256(skillAbs) },
    review: (priorAsset && priorAsset.review)
      || { ...(entry.review || {}), reviewer: (entry.review && entry.review.reviewer) || null },
    routing: {
      triggers: entry.invocationTriggers || [],
      relatedCoreSkill: entry.relatedCoreSkill || 'Qrun-task',
    },
    rollback: (priorAsset && priorAsset.rollback) || {
      action: 'remove-expert-copy-only',
      note: 'Do not restore to skills/ during rollback.',
    },
  };
}

// Serialize with a stable timestamp: reuse `prior` timestamps when the non-timestamp
// content is identical, so re-runs are byte-idempotent.
function stableWrite(path, payload, timestampKeys, prior) {
  const stripTs = (obj) => {
    const clone = JSON.parse(JSON.stringify(obj));
    for (const k of timestampKeys) delete clone[k];
    return JSON.stringify(clone);
  };
  const now = new Date().toISOString();
  if (prior && stripTs(prior) === stripTs(payload)) {
    for (const k of timestampKeys) {
      if (prior[k] !== undefined) payload[k] = prior[k];
    }
  } else {
    for (const k of timestampKeys) {
      if (payload[k] === undefined) payload[k] = now;
    }
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const priorIndex = readJsonOrNull(LEGACY_INDEX)
    || readJsonOrNull(PACK_TO_INDEX['core-experts']);
  const priorByName = new Map();
  for (const e of (priorIndex && Array.isArray(priorIndex.experts) ? priorIndex.experts : [])) {
    priorByName.set(String(e.name).toLowerCase(), e);
  }
  // also fold extra-index metadata if present
  const priorExtra = readJsonOrNull(PACK_TO_INDEX['extra-experts']);
  for (const e of (priorExtra && Array.isArray(priorExtra.experts) ? priorExtra.experts : [])) {
    const k = String(e.name).toLowerCase();
    if (!priorByName.has(k)) priorByName.set(k, e);
  }

  if (!existsSync(PACKS_ROOT)) throw new Error(`No packs root at ${PACKS_ROOT}`);
  const packs = readdirSync(PACKS_ROOT)
    .filter((p) => statSync(join(PACKS_ROOT, p)).isDirectory())
    .sort();

  const summary = {};
  for (const pack of packs) {
    const packDir = join(PACKS_ROOT, pack);
    const skillNames = listSkillDirs(packDir);
    if (skillNames.length === 0 && !PACK_TO_INDEX[pack]) continue;

    const priorManifest = readJsonOrNull(join(packDir, 'manifest.json'));
    const priorAssetByName = new Map();
    for (const a of (priorManifest && Array.isArray(priorManifest.assets) ? priorManifest.assets : [])) {
      priorAssetByName.set(String(a.name).toLowerCase(), a);
    }

    const experts = [];
    const assets = [];
    for (const name of skillNames) {
      const skillDir = join(packDir, 'skills', name);
      const prior = priorByName.get(name.toLowerCase());
      const entry = buildEntry(pack, name, skillDir, prior);
      experts.push(entry);
      assets.push(buildManifestAsset(entry, skillDir, priorAssetByName.get(name.toLowerCase())));
    }

    // index
    const indexPath = PACK_TO_INDEX[pack];
    if (indexPath) {
      const priorForIndex = readJsonOrNull(indexPath)
        || (pack === 'core-experts' ? readJsonOrNull(LEGACY_INDEX) : null);
      const indexPayload = {
        schemaVersion: SCHEMA_VERSION,
        pack,
        generatedAt: undefined,
        experts,
        totalExperts: experts.length,
      };
      mkdirSync(dirname(indexPath), { recursive: true });
      stableWrite(indexPath, indexPayload, ['generatedAt'], priorForIndex);
    }

    // manifest
    const manifestPath = join(packDir, 'manifest.json');
    const manifestPayload = {
      schemaVersion: (priorManifest && priorManifest.schemaVersion) || SCHEMA_VERSION,
      pack,
      createdAt: (priorManifest && priorManifest.createdAt) || undefined,
      source: (priorManifest && priorManifest.source) || `expert-library/packs/${pack}/skills`,
      assets,
      generatedAt: undefined,
      assetCount: assets.length,
    };
    stableWrite(manifestPath, manifestPayload, ['createdAt', 'generatedAt'], priorManifest);

    summary[pack] = { experts: experts.length, assets: assets.length, index: indexPath ? repoRel(indexPath) : '(none)' };
  }

  // Retire the legacy single index once core-index exists.
  if (existsSync(PACK_TO_INDEX['core-experts']) && existsSync(LEGACY_INDEX)) {
    rmSync(LEGACY_INDEX);
    summary._legacyRemoved = repoRel(LEGACY_INDEX);
  }

  const total = Object.values(summary)
    .filter((v) => v && typeof v === 'object' && 'experts' in v)
    .reduce((n, v) => n + v.experts, 0);
  summary._total = total;
  console.log(JSON.stringify(summary, null, 2));
}

main();
