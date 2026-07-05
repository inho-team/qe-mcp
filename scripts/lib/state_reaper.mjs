import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

// qe-mcp writes one `<run_id>.json` per runner/maintenance execution and never
// deleted them, so the state dirs grew without bound. This module opportunistically
// prunes a run-state directory (called by the runner right after it writes a new
// record) — bounded by age and count, and always fail-open so a reaper problem can
// never break the runner. Only qe-mcp-owned dirs (agent-runs, mcp-maintenance/runs)
// are pruned here; supervisor events.jsonl / locks are daemon-owned and out of scope.

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_MAX_COUNT = 200;
export const DEFAULT_GRACE_MS = 10 * 60 * 1000; // 10 minutes — protects in-flight runs

/** True when QE_MCP_RUN_RETENTION=off disables pruning entirely. */
export function isReaperDisabled(env = process.env) {
  return String(env.QE_MCP_RUN_RETENTION || '').toLowerCase() === 'off';
}

/** Retention age in ms from QE_MCP_RUN_RETENTION_DAYS; invalid/absent → default (7d). */
export function getRetentionMs(env = process.env) {
  const raw = env.QE_MCP_RUN_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_MS;
  const days = Number.parseInt(raw, 10);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_RETENTION_MS;
}

/** Max retained files from QE_MCP_RUN_RETENTION_MAX; invalid/absent → default (200). */
export function getMaxCount(env = process.env) {
  const raw = env.QE_MCP_RUN_RETENTION_MAX;
  if (raw === undefined || raw === '') return DEFAULT_MAX_COUNT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COUNT;
}

/**
 * Prune a run-state directory of stale `*.json` records.
 *
 * A file is removed when it is older than `maxAgeMs`, OR when the directory holds
 * more than `maxCount` files and this is one of the oldest over the cap — BUT never
 * if it is younger than `graceMs` (that guard protects a run that is still in flight).
 * Every filesystem step is isolated so a single failure (missing dir, permission,
 * a concurrent session already unlinking) can neither throw nor stop the rest.
 *
 * @param {string} dir - Directory holding `<run_id>.json` records.
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] - Age threshold; defaults to env/DEFAULT_RETENTION_MS.
 * @param {number} [options.maxCount] - Count cap; defaults to env/DEFAULT_MAX_COUNT.
 * @param {number} [options.graceMs] - Minimum age before a file may be removed.
 * @param {number} [options.now] - Injected clock (ms) for tests.
 * @param {object} [options.env] - Injected env for tests.
 * @param {object} [options.fs] - Injected `{readdirSync, statSync, unlinkSync}` for tests.
 * @returns {{scanned: number, removed: number, kept: number, errors: Array<{file: string, error: string}>}}
 */
export function pruneRunDir(dir, options = {}) {
  const env = options.env || process.env;
  const result = { scanned: 0, removed: 0, kept: 0, errors: [] };
  if (isReaperDisabled(env)) return result;

  const maxAgeMs = options.maxAgeMs ?? getRetentionMs(env);
  const maxCount = options.maxCount ?? getMaxCount(env);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const now = options.now ?? Date.now();
  const fsImpl = options.fs || { readdirSync, statSync, unlinkSync };

  let names;
  try {
    names = fsImpl.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return result; // missing dir / permission → fail-open, nothing to prune
  }

  const files = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = fsImpl.statSync(full);
      files.push({ full, mtimeMs: st.mtimeMs, ageMs: now - st.mtimeMs });
    } catch (err) {
      result.errors.push({ file: full, error: err?.message || String(err) });
    }
  }
  result.scanned = files.length;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const overCount = Math.max(0, files.length - maxCount);

  // Why mtime alone is safe for active runs: each lifecycle transition rewrites
  // the record (writeLifecycleRecord → write+rename), refreshing its mtime — so a
  // running job stays young and sorts to the newest end, out of the over-cap set.
  // A file stale past maxAgeMs therefore has had no transition for that long, which
  // (given minute-scale agent timeouts) means it is finished/orphaned, not active.
  // And if a prune ever races a between-transition window, the next transition just
  // recreates the record — deletion here is self-healing, never a permanent loss of
  // an in-flight run.
  files.forEach((f, idx) => {
    const tooOld = f.ageMs > maxAgeMs;
    const overCap = idx < overCount;
    // Grace guard is absolute: a young file is never removed, even over the cap.
    const shouldRemove = (tooOld || overCap) && f.ageMs >= graceMs;
    if (!shouldRemove) {
      result.kept += 1;
      return;
    }
    try {
      fsImpl.unlinkSync(f.full);
      result.removed += 1;
    } catch (err) {
      result.kept += 1;
      result.errors.push({ file: f.full, error: err?.message || String(err) });
    }
  });

  return result;
}
