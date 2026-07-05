import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pruneRunDir,
  getRetentionMs,
  getMaxCount,
  DEFAULT_RETENTION_MS,
  DEFAULT_MAX_COUNT,
} from '../state_reaper.mjs';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

// Build an injectable fs over a { name: mtimeMs } map. `unlinkThrows` names raise EPERM.
function mockFs(files, { unlinkThrows = new Set(), readdirThrows = false } = {}) {
  const removed = [];
  const fs = {
    readdirSync: () => {
      if (readdirThrows) {
        const e = new Error('ENOENT: no such directory');
        e.code = 'ENOENT';
        throw e;
      }
      return Object.keys(files);
    },
    statSync: (full) => {
      const name = full.split('/').pop();
      if (!(name in files)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return { mtimeMs: files[name] };
    },
    unlinkSync: (full) => {
      const name = full.split('/').pop();
      if (unlinkThrows.has(name)) {
        const e = new Error('EPERM');
        e.code = 'EPERM';
        throw e;
      }
      delete files[name];
      removed.push(name);
    },
  };
  return { fs, removed, files };
}

test('removes files older than maxAge, keeps younger ones', () => {
  const { fs, removed, files } = mockFs({
    'old.json': NOW - 8 * DAY,
    'fresh.json': NOW - 1 * DAY,
  });
  const r = pruneRunDir('/runs', { fs, now: NOW, maxAgeMs: 7 * DAY, graceMs: 10 * MIN, maxCount: 1000, env: {} });
  assert.equal(r.removed, 1);
  assert.deepEqual(removed, ['old.json']);
  assert.ok('fresh.json' in files);
});

test('grace window protects a young file even when over the count cap', () => {
  const { fs, removed } = mockFs({ 'young.json': NOW - 5 * MIN });
  // maxCount 0 → every file is "over cap", but young.json is within grace.
  const r = pruneRunDir('/runs', { fs, now: NOW, maxAgeMs: 7 * DAY, graceMs: 10 * MIN, maxCount: 0, env: {} });
  assert.equal(r.removed, 0);
  assert.equal(r.kept, 1);
  assert.deepEqual(removed, []);
});

test('over-count removal deletes the oldest first', () => {
  const { fs, removed } = mockFs({
    'a.json': NOW - 3 * DAY,
    'b.json': NOW - 2 * DAY,
    'c.json': NOW - 1 * DAY,
  });
  // None past maxAge (7d); cap of 2 → exactly the single oldest (a) is removed.
  const r = pruneRunDir('/runs', { fs, now: NOW, maxAgeMs: 7 * DAY, graceMs: 10 * MIN, maxCount: 2, env: {} });
  assert.equal(r.removed, 1);
  assert.deepEqual(removed, ['a.json']);
});

test('a file exactly at maxAge is kept (strict greater-than boundary)', () => {
  const { fs, removed } = mockFs({ 'edge.json': NOW - 7 * DAY }); // ageMs === maxAgeMs
  const r = pruneRunDir('/runs', { fs, now: NOW, maxAgeMs: 7 * DAY, graceMs: 10 * MIN, maxCount: 1000, env: {} });
  assert.equal(r.removed, 0);
  assert.equal(r.kept, 1);
  assert.deepEqual(removed, []);
});

test('an existing but empty directory is a no-op', () => {
  const { fs } = mockFs({});
  const r = pruneRunDir('/runs', { fs, now: NOW, env: {} });
  assert.deepEqual(r, { scanned: 0, removed: 0, kept: 0, errors: [] });
});

test('multiple young files over the cap are all protected by grace', () => {
  const { fs, removed } = mockFs({
    'y1.json': NOW - 1 * MIN,
    'y2.json': NOW - 2 * MIN,
    'y3.json': NOW - 3 * MIN,
  });
  const r = pruneRunDir('/runs', { fs, now: NOW, maxAgeMs: 7 * DAY, graceMs: 10 * MIN, maxCount: 0, env: {} });
  assert.equal(r.removed, 0);
  assert.equal(r.kept, 3);
  assert.deepEqual(removed, []);
});

test('QE_MCP_RUN_RETENTION=off disables all pruning', () => {
  const { fs, removed } = mockFs({ 'ancient.json': NOW - 400 * DAY });
  const r = pruneRunDir('/runs', { fs, now: NOW, env: { QE_MCP_RUN_RETENTION: 'off' } });
  assert.equal(r.removed, 0);
  assert.deepEqual(removed, []);
});

test('missing directory fails open with no throw', () => {
  const { fs } = mockFs({}, { readdirThrows: true });
  const r = pruneRunDir('/nope', { fs, now: NOW, env: {} });
  assert.deepEqual(r, { scanned: 0, removed: 0, kept: 0, errors: [] });
});

test('a single unlink failure is isolated and does not stop the rest', () => {
  const { fs, removed } = mockFs(
    { 'a.json': NOW - 8 * DAY, 'b.json': NOW - 9 * DAY },
    { unlinkThrows: new Set(['a.json']) },
  );
  const r = pruneRunDir('/runs', { fs, now: NOW, maxAgeMs: 7 * DAY, graceMs: 10 * MIN, maxCount: 1000, env: {} });
  assert.equal(r.removed, 1);
  assert.deepEqual(removed, ['b.json']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].file, /a\.json$/);
});

test('env parsing falls back to defaults on invalid/absent values', () => {
  assert.equal(getRetentionMs({}), DEFAULT_RETENTION_MS);
  assert.equal(getRetentionMs({ QE_MCP_RUN_RETENTION_DAYS: 'nope' }), DEFAULT_RETENTION_MS);
  assert.equal(getRetentionMs({ QE_MCP_RUN_RETENTION_DAYS: '-3' }), DEFAULT_RETENTION_MS);
  assert.equal(getRetentionMs({ QE_MCP_RUN_RETENTION_DAYS: '3' }), 3 * DAY);
  assert.equal(getMaxCount({}), DEFAULT_MAX_COUNT);
  assert.equal(getMaxCount({ QE_MCP_RUN_RETENTION_MAX: '0' }), DEFAULT_MAX_COUNT);
  assert.equal(getMaxCount({ QE_MCP_RUN_RETENTION_MAX: '50' }), 50);
});
