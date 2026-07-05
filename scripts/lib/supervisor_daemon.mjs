import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';

// Opt-in single-producer supervisor event loop (contract D032). An MCP server is
// spawned per client session, so multiple instances may run at once; a single
// producer lock guarantees at most ONE instance drives the loop. Every knob is
// injectable so the whole lifecycle is deterministically testable without timers,
// real processes, or a real filesystem.

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_LOCK_MAX_AGE_MS = 15 * 60 * 1000; // heartbeat stale threshold

/** The loop is inert unless QE_MCP_SUPERVISOR_DAEMON=on (default off). */
export function isDaemonEnabled(env = process.env) {
  return String(env.QE_MCP_SUPERVISOR_DAEMON || '').toLowerCase() === 'on';
}

/** Loop interval in ms from QE_MCP_SUPERVISOR_INTERVAL_MS; invalid → default. */
export function getIntervalMs(env = process.env) {
  const n = Number.parseInt(env.QE_MCP_SUPERVISOR_INTERVAL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

/** Heartbeat stale threshold from QE_MCP_SUPERVISOR_LOCK_MAX_AGE_MS; invalid → default. */
export function getLockMaxAgeMs(env = process.env) {
  const n = Number.parseInt(env.QE_MCP_SUPERVISOR_LOCK_MAX_AGE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_MAX_AGE_MS;
}

/**
 * The stale threshold MUST exceed the heartbeat cadence (one refresh per interval
 * tick) or a live producer ages out between ticks and gets wrongly reaped. Clamp
 * to at least 3× the interval so several missed ticks are tolerated before a lock
 * is judged dead — even when the configured max-age is (mis)set below the interval.
 */
export function effectiveLockMaxAgeMs(intervalMs, maxAgeMs) {
  return Math.max(maxAgeMs, intervalMs * 3);
}

/** Absolute path of the single-producer lock under a supervisor root. */
export function producerLockPath(supervisorRoot) {
  return join(supervisorRoot, 'locks', 'producer.lock');
}

const realFs = { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync };

/** Liveness probe: signal 0 tells whether a pid exists (EPERM still means alive). */
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Read and JSON-parse the lock; returns null when absent, {malformed:true} on garbage. */
export function readProducerLock(lockPath, { fs = realFs } = {}) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return { malformed: true };
  }
}

/**
 * A lock is stale when malformed, its owner pid is dead, or its heartbeat is
 * older than maxAgeMs. A stale lock may be reaped so another instance takes over.
 */
export function isProducerLockStale(lock, { now = Date.now(), maxAgeMs = DEFAULT_LOCK_MAX_AGE_MS, isAlive = defaultIsAlive } = {}) {
  if (!lock || lock.malformed) return true;
  if (!isAlive(Number(lock.pid))) return true;
  const beat = Date.parse(lock.heartbeatAt || lock.createdAt || '');
  if (!Number.isFinite(beat)) return true;
  return now - beat > maxAgeMs;
}

/**
 * Try to become the single producer. Atomic `wx` create wins; on contention the
 * existing lock is reaped only if stale, otherwise this instance stays passive.
 * @returns {{acquired: boolean, reason: string}}
 */
export function acquireProducerLock(lockPath, { pid = process.pid, now = Date.now(), fs = realFs, isAlive = defaultIsAlive, maxAgeMs = DEFAULT_LOCK_MAX_AGE_MS } = {}) {
  const record = { pid, createdAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() };
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      return { acquired: true, reason: 'created' };
    } catch (err) {
      if (err?.code !== 'EEXIST') return { acquired: false, reason: 'write-failed' };
      const existing = readProducerLock(lockPath, { fs });
      if (!isProducerLockStale(existing, { now, maxAgeMs, isAlive })) {
        return { acquired: false, reason: 'held' };
      }
      // Atomic steal: rename is single-winner, so two racers can never both reap
      // and recreate. The loser's rename fails (ENOENT) and it re-evaluates; the
      // winner drops the stolen file and retries the wx create. Blind unlink here
      // would let racer B delete racer A's freshly created lock.
      const steal = `${lockPath}.reap.${pid}.${now}.${attempt}`;
      try {
        fs.renameSync(lockPath, steal);
        try { fs.unlinkSync(steal); } catch { /* stolen file cleanup is best-effort */ }
      } catch {
        /* another instance already stole/replaced it — loop and re-read */
      }
    }
  }
  return { acquired: false, reason: 'lost-race' };
}

/** Refresh heartbeat so peers keep seeing this producer as live. Owner-only. */
export function refreshHeartbeat(lockPath, { pid = process.pid, now = Date.now(), fs = realFs } = {}) {
  const existing = readProducerLock(lockPath, { fs });
  if (!existing || existing.malformed || Number(existing.pid) !== Number(pid)) return false;
  existing.heartbeatAt = new Date(now).toISOString();
  const tmp = `${lockPath}.${pid}.tmp`;
  try {
    // Atomic replace so the lock is never momentarily absent (no acquire window).
    fs.writeFileSync(tmp, JSON.stringify(existing));
    fs.renameSync(tmp, lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Release the lock only if this pid owns it. */
export function releaseProducerLock(lockPath, { pid = process.pid, fs = realFs } = {}) {
  const existing = readProducerLock(lockPath, { fs });
  if (!existing || existing.malformed) return false;
  if (Number(existing.pid) !== Number(pid)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return !fs.existsSync(lockPath);
  }
}

/**
 * Build a controllable supervisor daemon. `start()` acquires the producer lock;
 * only the winner arms the interval that refreshes the heartbeat and runs the
 * monitors. `stop()` disarms and releases. All timer/clock/fs/probe seams are
 * injectable for tests.
 */
export function createSupervisorDaemon({
  supervisorRoot,
  env = process.env,
  intervalMs = getIntervalMs(env),
  maxAgeMs = getLockMaxAgeMs(env),
  pid = process.pid,
  now = () => Date.now(),
  fs = realFs,
  isAlive = defaultIsAlive,
  runMonitors = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const lockPath = producerLockPath(supervisorRoot);
  const clampedMaxAge = effectiveLockMaxAgeMs(intervalMs, maxAgeMs);
  let timer = null;
  let producer = false;

  function tick() {
    refreshHeartbeat(lockPath, { pid, now: now(), fs });
    try {
      runMonitors();
    } catch {
      /* a monitor failure must not tear down the loop */
    }
  }

  function start() {
    if (!isDaemonEnabled(env)) return { started: false, reason: 'disabled' };
    if (producer) return { started: true, reason: 'already-producer' };
    const got = acquireProducerLock(lockPath, { pid, now: now(), fs, isAlive, maxAgeMs: clampedMaxAge });
    if (!got.acquired) return { started: false, reason: got.reason };
    producer = true;
    timer = setIntervalImpl(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { started: true, reason: 'producer' };
  }

  function stop() {
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    let released = false;
    if (producer) {
      released = releaseProducerLock(lockPath, { pid, fs });
      producer = false;
    }
    return { stopped: true, released };
  }

  return {
    start,
    stop,
    isProducer: () => producer,
    tickOnce: tick,
    lockPath,
  };
}
