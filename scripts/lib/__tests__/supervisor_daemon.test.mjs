import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import {
  createSupervisorDaemon,
  acquireProducerLock,
  releaseProducerLock,
  refreshHeartbeat,
  isProducerLockStale,
  producerLockPath,
  effectiveLockMaxAgeMs,
} from '../supervisor_daemon.mjs';
import { emitEvent, enforceEventRetention, runMonitorsOnce, ackSupervisorEvent, listSupervisorEvents } from '../supervisor_tools.mjs';

const ON = { QE_MCP_SUPERVISOR_DAEMON: 'on' };

// In-memory fs honoring the `wx` flag so lock contention is deterministic.
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    _files: files,
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFileSync: (p, data, opts) => {
      if (opts && opts.flag === 'wx' && files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      files.set(p, String(data));
    },
    unlinkSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.delete(p);
    },
    renameSync: (from, to) => {
      if (!files.has(from)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

const ROOT = '/ws/.qe/state/supervisor';
const LOCK = producerLockPath(ROOT);

test('only one of two instances becomes the producer', () => {
  const fs = memFs();
  const alive = () => true;
  const noopTimer = () => ({ unref() {} });
  const a = createSupervisorDaemon({ supervisorRoot: ROOT, env: ON, pid: 100, fs, isAlive: alive, setIntervalImpl: noopTimer, clearIntervalImpl: () => {}, now: () => 1000 });
  const b = createSupervisorDaemon({ supervisorRoot: ROOT, env: ON, pid: 200, fs, isAlive: alive, setIntervalImpl: noopTimer, clearIntervalImpl: () => {}, now: () => 1000 });
  assert.equal(a.start().reason, 'producer');
  assert.equal(a.isProducer(), true);
  const bStart = b.start();
  assert.equal(bStart.started, false);
  assert.equal(bStart.reason, 'held');
  assert.equal(b.isProducer(), false);
});

test('a dead producer lock is stale-reaped so a peer takes over', () => {
  const deadLock = JSON.stringify({ pid: 999, createdAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() });
  const fs = memFs({ [LOCK]: deadLock });
  const alive = (pid) => pid !== 999;
  const got = acquireProducerLock(LOCK, { pid: 100, now: 10_000, fs, isAlive: alive, maxAgeMs: 60_000 });
  assert.equal(got.acquired, true);
  assert.equal(JSON.parse(fs._files.get(LOCK)).pid, 100);
});

test('stale-reap yields exactly one owner (no double-acquire)', () => {
  const deadLock = JSON.stringify({ pid: 999, createdAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() });
  const fs = memFs({ [LOCK]: deadLock });
  const alive = (pid) => pid !== 999; // 999 dead, others live
  const a = acquireProducerLock(LOCK, { pid: 100, now: 10_000, fs, isAlive: alive, maxAgeMs: 60_000 });
  const b = acquireProducerLock(LOCK, { pid: 200, now: 10_000, fs, isAlive: alive, maxAgeMs: 60_000 });
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, false); // second sees the first live owner
  assert.equal(b.reason, 'held');
  assert.equal(JSON.parse(fs._files.get(LOCK)).pid, 100); // exactly one owner
  // no stray steal files left behind
  const strays = [...fs._files.keys()].filter((k) => k.includes('.reap.'));
  assert.deepEqual(strays, []);
});

test('effectiveLockMaxAgeMs clamps stale threshold to >= 3x interval', () => {
  assert.equal(effectiveLockMaxAgeMs(20 * 60_000, 15 * 60_000), 60 * 60_000); // interval*3 wins
  assert.equal(effectiveLockMaxAgeMs(1 * 60_000, 15 * 60_000), 15 * 60_000); // configured max wins
});

test('a live, fresh lock is not stale', () => {
  const lock = { pid: 100, createdAt: new Date(5000).toISOString(), heartbeatAt: new Date(5000).toISOString() };
  assert.equal(isProducerLockStale(lock, { now: 6000, maxAgeMs: 60_000, isAlive: () => true }), false);
  assert.equal(isProducerLockStale(lock, { now: 5000 + 120_000, maxAgeMs: 60_000, isAlive: () => true }), true); // heartbeat aged out
});

test('disabled env never acquires a lock or arms a timer', () => {
  const fs = memFs();
  let armed = 0;
  const d = createSupervisorDaemon({ supervisorRoot: ROOT, env: {}, pid: 1, fs, setIntervalImpl: () => { armed += 1; return {}; } });
  assert.equal(d.start().reason, 'disabled');
  assert.equal(armed, 0);
  assert.equal(fs.existsSync(LOCK), false);
});

test('graceful stop clears the interval and releases the lock', () => {
  const fs = memFs();
  let cleared = 0;
  const d = createSupervisorDaemon({ supervisorRoot: ROOT, env: ON, pid: 100, fs, isAlive: () => true, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => { cleared += 1; }, now: () => 1000 });
  d.start();
  assert.equal(fs.existsSync(LOCK), true);
  const r = d.stop();
  assert.equal(cleared, 1);
  assert.equal(r.released, true);
  assert.equal(fs.existsSync(LOCK), false);
});

test('heartbeat refresh is owner-only', () => {
  const fs = memFs();
  acquireProducerLock(LOCK, { pid: 100, now: 1000, fs, isAlive: () => true });
  assert.equal(refreshHeartbeat(LOCK, { pid: 200, now: 2000, fs }), false); // not owner
  assert.equal(refreshHeartbeat(LOCK, { pid: 100, now: 2000, fs }), true);
  assert.equal(JSON.parse(fs._files.get(LOCK)).heartbeatAt, new Date(2000).toISOString());
  assert.equal(releaseProducerLock(LOCK, { pid: 200, fs }), false); // not owner
  assert.equal(releaseProducerLock(LOCK, { pid: 100, fs }), true);
});

// --- event tools over a real temp workspace ---

function tempWs(t) {
  const dir = mkdtempSync(join(os.tmpdir(), 'qe-sup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('emitEvent appends and collapses an unchanged duplicate', (t) => {
  const dir = tempWs(t);
  const ev = { severity: 'WARN', monitor_id: 'm1', dedupe_key: 'k', summary: 's', evidence_fingerprint: 'fp1' };
  assert.equal(emitEvent(ev, { workspace_root: dir }).status, 'emitted');
  assert.equal(emitEvent(ev, { workspace_root: dir }).status, 'collapsed'); // same identity+severity+fp, unacked
  const events = listSupervisorEvents({ workspace_root: dir }).events;
  assert.equal(events.length, 1);
});

test('enforceEventRetention keeps exactly the latest 1000, drops the oldest', (t) => {
  const dir = tempWs(t);
  for (let i = 0; i < 1005; i++) {
    emitEvent({ severity: 'WARN', monitor_id: `m${i}`, dedupe_key: String(i), summary: 's', evidence_fingerprint: `fp${i}` }, { workspace_root: dir });
  }
  // Read the raw log (listSupervisorEvents tail-caps by bytes; count lines directly).
  const eventsPath = join(dir, '.qe', 'state', 'supervisor', 'events.jsonl');
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 1000);
  const ids = lines.map((l) => JSON.parse(l).monitor_id);
  assert.equal(ids.includes('m0'), false); // oldest 5 dropped
  assert.equal(ids.includes('m4'), false);
  assert.equal(ids.includes('m5'), true); // first kept
  assert.equal(ids.includes('m1004'), true); // newest kept
});

test('runMonitorsOnce emits for a failing monitor and stays silent for a healthy one', (t) => {
  const dir = tempWs(t);
  const spawnStub = (cmd) => {
    if (cmd === 'npm') return { status: 0, stdout: 'ok', stderr: '' }; // qe:validate healthy
    return { status: 1, stdout: '', stderr: 'boom' }; // qe-mcp doctor/sync fail
  };
  const r = runMonitorsOnce({ workspace_root: dir }, { spawnSync: spawnStub });
  const warned = r.results.filter((x) => x.severity === 'WARN');
  const healthy = r.results.filter((x) => x.emit === 'skipped-healthy');
  assert.ok(warned.length >= 1);
  assert.ok(healthy.length >= 1);
  const events = listSupervisorEvents({ workspace_root: dir }).events;
  assert.equal(events.length, warned.length); // only non-healthy produced events
});

test('ack prune drops expired and orphaned acks', (t) => {
  const dir = tempWs(t);
  emitEvent({ severity: 'FAIL', monitor_id: 'live', dedupe_key: 'k', summary: 's', evidence_fingerprint: 'fp' }, { workspace_root: dir });
  const evId = listSupervisorEvents({ workspace_root: dir }).events[0].event_id;
  // Seed acks.json with an orphaned + expired entry, then ack the live event.
  const acksPath = join(dir, '.qe', 'state', 'supervisor', 'acks.json');
  mkdirSync(join(dir, '.qe', 'state', 'supervisor'), { recursive: true });
  writeFileSync(acksPath, JSON.stringify({
    'orphan-key': { state: 'acked', acked_at: '2020-01-01T00:00:00.000Z' },
    'expired-key': { state: 'acked', acked_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-02T00:00:00.000Z' },
  }));
  const r = ackSupervisorEvent({ workspace_root: dir, event_id: evId, actor: 'test' });
  assert.equal(r.status, 'acked');
  const saved = JSON.parse(readFileSync(acksPath, 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'orphan-key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'expired-key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, evId), true);
});
