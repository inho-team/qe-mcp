import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';

const EVENT_SCHEMA = 'qe.supervisor.event.v1';
const STATUS_SCHEMA = 'qe.supervisor.status.v1';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
// Contract retention (SUPERVISOR_EVENT_CONTRACT.md): latest 1,000 events or 30 days.
const RETENTION_MAX_EVENTS = 1000;
const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_LOG_PREVIEW_BYTES = 64 * 1024;
const SEVERITIES = Object.freeze(['INFO', 'WARN', 'FAIL', 'CRITICAL']);
const SEVERITY_RANK = Object.freeze({ INFO: 0, WARN: 1, FAIL: 2, CRITICAL: 3 });

const MONITOR_SPECS = Object.freeze([
  {
    monitor_id: 'qe-mcp-doctor',
    title: 'QE MCP doctor',
    run_mode: 'read-only',
    safe_command: 'qe-mcp doctor --json',
    argv: ['qe-mcp', 'doctor', '--json'],
    timeout_ms: 30000,
    output_cap_bytes: 24000,
    scheduler_owner: 'external',
    permission_class: 'read-only',
    source: 'qe-mcp',
  },
  {
    monitor_id: 'qe-mcp-sync-dry-run',
    title: 'QE MCP sync dry-run',
    run_mode: 'report-only',
    safe_command: 'qe-mcp sync --dry-run --json',
    argv: ['qe-mcp', 'sync', '--dry-run', '--json'],
    timeout_ms: 30000,
    output_cap_bytes: 24000,
    scheduler_owner: 'external',
    permission_class: 'report-only',
    source: 'qe-mcp',
  },
  {
    monitor_id: 'qe-framework-install-state',
    title: 'Stale QE framework install state',
    run_mode: 'read-only',
    safe_command: 'npm run qe:validate',
    argv: ['npm', 'run', 'qe:validate'],
    timeout_ms: 120000,
    output_cap_bytes: 24000,
    scheduler_owner: 'external',
    permission_class: 'read-only',
    source: 'qe-framework',
  },
  {
    monitor_id: 'qe-background-jobs',
    title: 'Failed QE background jobs',
    run_mode: 'read-only',
    safe_command: 'read .qe/state supervisor/job projections',
    timeout_ms: 10000,
    output_cap_bytes: 16000,
    scheduler_owner: 'external',
    permission_class: 'read-only',
    source: 'qe-framework',
  },
]);

// Returns MCP input schemas for the bounded supervisor control surface.
export function buildSupervisorToolSchemas() {
  const scopeProps = {
    workspace_root: { type: 'string' },
    scope: { type: 'string', enum: ['workspace', 'global'] },
  };
  return {
    qe_supervisor_status: {
      type: 'object',
      properties: {
        ...scopeProps,
        max_events: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
    },
    qe_supervisor_events: {
      type: 'object',
      properties: {
        ...scopeProps,
        severity: { type: 'string', enum: SEVERITIES },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        include_acked: { type: 'boolean' },
      },
    },
    qe_supervisor_ack: {
      type: 'object',
      required: ['event_id'],
      properties: {
        ...scopeProps,
        event_id: { type: 'string' },
        actor: { type: 'string' },
        expires_at: { type: 'string' },
      },
    },
    qe_supervisor_specs: {
      type: 'object',
      properties: {
        monitor_id: { type: 'string' },
      },
    },
  };
}

function boundedInt(value, fallback, max = MAX_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function supervisorRoot({ workspace_root, scope } = {}) {
  if (scope === 'global') {
    return join(process.env.HOME || process.cwd(), '.qe', 'daemon');
  }
  return join(resolve(workspace_root || process.cwd()), '.qe', 'state', 'supervisor');
}

function paths(args = {}) {
  const root = supervisorRoot(args);
  return {
    root,
    events: join(root, 'events.jsonl'),
    acks: join(root, 'acks.json'),
    status: join(root, 'status.json'),
    locks: join(root, 'locks'),
    logs: join(root, 'logs'),
  };
}

function degraded(code, message, extra = {}) {
  return { code, message, ...extra };
}

function readBoundedFile(path, maxBytes = MAX_READ_BYTES) {
  if (!existsSync(path)) return { status: 'degraded', text: '', errors: [degraded('missing_file', path)] };
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return { status: 'degraded', text: '', errors: [degraded('unreadable', `${path} is a directory`)] };
    }
    const raw = readFileSync(path);
    const truncated = raw.length > maxBytes;
    const slice = truncated ? raw.subarray(raw.length - maxBytes) : raw;
    return {
      status: truncated ? 'degraded' : 'ok',
      text: slice.toString('utf8'),
      errors: truncated ? [degraded('truncated', `${path} exceeded ${maxBytes} bytes`)] : [],
    };
  } catch (error) {
    return { status: 'degraded', text: '', errors: [degraded('unreadable', error.message)] };
  }
}

function validateEvent(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'not_object' };
  }
  for (const field of [
    'schema',
    'event_id',
    'severity',
    'source',
    'workspace',
    'monitor_id',
    'dedupe_key',
    'first_seen_at',
    'last_seen_at',
    'ack',
    'summary',
    'evidence_fingerprint',
    'remediation_hint',
  ]) {
    if (!(field in candidate)) return { ok: false, reason: `missing_${field}` };
  }
  if (candidate.schema !== EVENT_SCHEMA) return { ok: false, reason: 'bad_schema' };
  if (!SEVERITIES.includes(candidate.severity)) return { ok: false, reason: 'bad_severity' };
  if (!candidate.ack || !['acked', 'unacked'].includes(candidate.ack.state)) {
    return { ok: false, reason: 'bad_ack' };
  }
  return { ok: true };
}

function eventIdentity(event) {
  return `${event.workspace}\u0000${event.source}\u0000${event.monitor_id}\u0000${event.dedupe_key}`;
}

function eventFingerprint(event) {
  return createHash('sha256').update(eventIdentity(event)).digest('hex').slice(0, 16);
}

function readAcks(args = {}) {
  const p = paths(args).acks;
  if (!existsSync(p)) return { status: 'ok', acks: {}, errors: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return { status: 'ok', acks: parsed && typeof parsed === 'object' ? parsed : {}, errors: [] };
  } catch (error) {
    return { status: 'degraded', acks: {}, errors: [degraded('malformed_ack_file', error.message)] };
  }
}

/**
 * Drop expired acks (past expires_at) and orphaned acks (no current event uses
 * the key) so acks.json cannot accumulate indefinitely. `keep` force-retains the
 * key(s) just written this call.
 */
function pruneAcks(acks, events, nowIso, keep = {}) {
  const now = Date.parse(nowIso);
  const valid = new Set(Object.keys(keep).filter(Boolean));
  for (const e of events) {
    if (e.event_id) valid.add(e.event_id);
    valid.add(eventIdentity(e));
  }
  const out = {};
  for (const [key, ack] of Object.entries(acks || {})) {
    if (!valid.has(key)) continue;
    if (ack?.expires_at) {
      const exp = Date.parse(ack.expires_at);
      if (Number.isFinite(exp) && Number.isFinite(now) && exp < now) continue;
    }
    out[key] = ack;
  }
  return out;
}

function applyAckProjection(event, acks) {
  const key = event.event_id || eventFingerprint(event);
  const identityKey = eventIdentity(event);
  const ack = acks[key] || acks[identityKey];
  if (!ack) return event;
  if (ack.expires_at && ack.expires_at <= new Date().toISOString()) return event;
  if (ack.severity && SEVERITY_RANK[event.severity] > SEVERITY_RANK[ack.severity]) return event;
  if (ack.evidence_fingerprint && event.evidence_fingerprint !== ack.evidence_fingerprint) return event;
  return {
    ...event,
    ack: {
      state: 'acked',
      acked_at: ack.acked_at,
      acked_by: ack.acked_by,
      expires_at: ack.expires_at || null,
    },
  };
}

function parseEvents(args = {}) {
  const p = paths(args).events;
  const read = readBoundedFile(p);
  const events = [];
  const errors = [...read.errors];
  const lockErrors = readLockErrors(args);
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
      errors.push(degraded('oversized_event', `event exceeded ${MAX_EVENT_BYTES} bytes`));
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const valid = validateEvent(parsed);
      if (valid.ok) events.push(parsed);
      else errors.push(degraded(valid.reason, parsed.event_id || 'unknown event'));
    } catch (error) {
      errors.push(degraded('malformed_or_truncated', error.message));
    }
  }
  const acks = readAcks(args);
  const projected = events.map((event) => applyAckProjection(event, acks.acks));
  return {
    status: errors.length || lockErrors.length || acks.errors.length ? 'degraded' : 'ok',
    events: projected,
    errors: [...errors, ...lockErrors, ...acks.errors],
  };
}

/** Best-effort timestamp of an event for retention (last_seen preferred). */
function eventTimeMs(event) {
  const t = Date.parse(event?.last_seen_at || event?.first_seen_at || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Enforce the contract retention window on events.jsonl: keep the latest
 * RETENTION_MAX_EVENTS and drop anything older than RETENTION_MAX_AGE_MS. Rewrite
 * is atomic (tmp + rename); a no-op when nothing exceeds the bounds.
 *
 * Correctness assumes a single writer — guaranteed by the producer lock (D032),
 * so no concurrent append can be lost between this read and the rename. A crash
 * mid-rewrite leaves the prior events.jsonl intact (rename is atomic).
 */
export function enforceEventRetention(args = {}) {
  const p = paths(args);
  const now = args.now ? Date.parse(args.now) : Date.now();
  let lines;
  try {
    if (!existsSync(p.events)) return { status: 'ok', removed: 0 };
    lines = readFileSync(p.events, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return { status: 'degraded', removed: 0 };
  }
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push({ line, event: JSON.parse(line) });
    } catch {
      /* drop malformed/truncated lines during rewrite */
    }
  }
  let kept = parsed.filter((p2) => now - eventTimeMs(p2.event) <= RETENTION_MAX_AGE_MS);
  if (kept.length > RETENTION_MAX_EVENTS) kept = kept.slice(kept.length - RETENTION_MAX_EVENTS);
  const removed = parsed.length - kept.length;
  if (removed <= 0 && parsed.length === lines.length) return { status: 'ok', removed: 0 };
  try {
    const tmp = `${p.events}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.map((k) => k.line).join('\n') + (kept.length ? '\n' : ''), 'utf8');
    renameSync(tmp, p.events);
  } catch {
    return { status: 'degraded', removed: 0 };
  }
  return { status: 'ok', removed };
}

/**
 * Append a supervisor event to events.jsonl, then enforce retention. Collapses a
 * duplicate of the latest same-identity event (same severity + evidence
 * fingerprint) into a no-op per the dedupe contract, so repeated monitor ticks
 * for an unchanged condition do not grow the log.
 */
export function emitEvent(event = {}, args = {}) {
  const p = paths(args);
  const nowIso = args.now || new Date().toISOString();
  const record = {
    schema: EVENT_SCHEMA,
    severity: SEVERITIES.includes(event.severity) ? event.severity : 'INFO',
    source: event.source || 'qe-mcp',
    workspace: event.workspace || resolve(args.workspace_root || process.cwd()),
    monitor_id: event.monitor_id || 'unknown',
    dedupe_key: event.dedupe_key || '',
    first_seen_at: event.first_seen_at || nowIso,
    last_seen_at: nowIso,
    ack: event.ack && ['acked', 'unacked'].includes(event.ack.state) ? event.ack : { state: 'unacked' },
    summary: String(event.summary || ''),
    details: String(event.details || ''),
    evidence_path: event.evidence_path || null,
    evidence_fingerprint: event.evidence_fingerprint || null,
    remediation_hint: event.remediation_hint || null,
  };
  record.event_id = event.event_id
    || createHash('sha256').update(`${eventIdentity(record)}|${record.first_seen_at}`).digest('hex').slice(0, 16);

  // Dedupe collapse: if the newest same-identity event is unchanged and still
  // open, skip the append (a repeated unchanged tick is a no-op).
  const existing = parseEvents(args).events.filter((e) => eventIdentity(e) === eventIdentity(record));
  const latest = existing[existing.length - 1];
  if (latest && latest.severity === record.severity && latest.evidence_fingerprint === record.evidence_fingerprint && latest.ack?.state !== 'acked') {
    return { status: 'collapsed', event_id: latest.event_id };
  }

  let line = JSON.stringify(record);
  if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
    record.details = `${record.details.slice(0, 2000)}\n[truncated]`;
    record.details_truncated = true;
    line = JSON.stringify(record);
  }
  try {
    mkdirSync(dirname(p.events), { recursive: true });
    appendFileSync(p.events, `${line}\n`, 'utf8');
  } catch {
    return { status: 'degraded', event_id: record.event_id };
  }
  enforceEventRetention(args);
  return { status: 'emitted', event_id: record.event_id };
}

/**
 * Run each executable MONITOR_SPEC once (bounded, no shell) and emit an event for
 * any non-healthy result. Healthy (exit 0) monitors emit nothing, so the log only
 * ever carries conditions that need attention. Descriptive specs (non-command
 * safe_command) are skipped. `spawnImpl` is injectable for tests.
 */
export function runMonitorsOnce(args = {}, options = {}) {
  const spawnImpl = options.spawnSync || spawnSync;
  const results = [];
  for (const spec of MONITOR_SPECS) {
    // Only specs with an explicit argv array are executable; descriptive specs
    // (no argv) are skipped. Using argv avoids any whitespace/quoting parse of a
    // command string and there is never a shell in the loop.
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) continue;
    const [cmd, ...cmdArgs] = spec.argv;
    let severity = 'INFO';
    let details = '';
    try {
      const r = spawnImpl(cmd, cmdArgs, {
        cwd: args.workspace_root || process.cwd(),
        timeout: spec.timeout_ms,
        encoding: 'utf8',
        maxBuffer: spec.output_cap_bytes,
        shell: false,
      });
      details = `${String(r.stdout || '')}${String(r.stderr || '')}`.slice(0, spec.output_cap_bytes);
      if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM')) severity = 'FAIL';
      else if (r.error && r.error.code === 'ENOENT') severity = 'WARN';
      else if (typeof r.status === 'number' && r.status !== 0) severity = 'WARN';
      else severity = 'INFO';
    } catch (err) {
      severity = 'WARN';
      details = err?.message || String(err);
    }
    if (severity === 'INFO') {
      results.push({ monitor_id: spec.monitor_id, severity, emit: 'skipped-healthy' });
      continue;
    }
    const fingerprint = createHash('sha256').update(details).digest('hex').slice(0, 16);
    const emit = emitEvent({
      severity,
      source: spec.source,
      monitor_id: spec.monitor_id,
      dedupe_key: `${spec.monitor_id}:${severity}`,
      summary: `${spec.title}: ${severity}`,
      details,
      evidence_fingerprint: fingerprint,
    }, args);
    results.push({ monitor_id: spec.monitor_id, severity, emit: emit.status });
  }
  return { status: 'ok', results };
}

function readLockErrors(args = {}) {
  const lockDir = paths(args).locks;
  if (!existsSync(lockDir)) return [];
  try {
    return readdirSync(lockDir)
      .filter((name) => name.endsWith('.lock'))
      .map((name) => degraded('locked', join(lockDir, name)));
  } catch (error) {
    return [degraded('locked', error.message)];
  }
}

function currentStatusFromEvents(events) {
  let status = 'PASS';
  for (const event of events) {
    if (event.ack?.state === 'acked') continue;
    if (event.severity === 'CRITICAL' || event.severity === 'FAIL') return 'FAIL';
    if (event.severity === 'WARN') status = 'WARN';
  }
  return status;
}

function capDetails(event) {
  const details = String(event.details || '');
  if (Buffer.byteLength(details, 'utf8') <= MAX_LOG_PREVIEW_BYTES) return event;
  return {
    ...event,
    details: `${details.slice(0, MAX_LOG_PREVIEW_BYTES)}\n[truncated]`,
    details_truncated: true,
    raw_capture_policy: 'preview-only',
  };
}

// Reads supervisor events with fail-open parsing and bounded preview output.
export function listSupervisorEvents(args = {}) {
  const limit = boundedInt(args.limit, DEFAULT_LIMIT);
  const parsed = parseEvents(args);
  if (args.severity && !Object.hasOwn(SEVERITY_RANK, args.severity)) {
    return {
      schema: EVENT_SCHEMA,
      status: 'error',
      count: 0,
      limit,
      events: [],
      errors: [degraded('bad_severity', args.severity)],
      side_effects: 'none',
    };
  }
  const minRank = args.severity ? SEVERITY_RANK[args.severity] : null;
  const filtered = parsed.events
    .filter((event) => args.include_acked || event.ack?.state !== 'acked')
    .filter((event) => minRank === null || SEVERITY_RANK[event.severity] >= minRank)
    .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))
    .slice(0, limit)
    .map(capDetails);
  return {
    schema: EVENT_SCHEMA,
    status: parsed.status,
    count: filtered.length,
    limit,
    events: filtered,
    errors: parsed.errors,
    raw_capture_policy: 'preview-only',
    max_event_bytes: MAX_EVENT_BYTES,
    max_log_preview_bytes: MAX_LOG_PREVIEW_BYTES,
  };
}

// Builds a compact current status projection from event and ack state.
export function getSupervisorStatus(args = {}) {
  const limit = boundedInt(args.max_events, DEFAULT_LIMIT);
  const parsed = parseEvents(args);
  const recent = parsed.events
    .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))
    .slice(0, limit)
    .map(capDetails);
  return {
    schema: STATUS_SCHEMA,
    status: currentStatusFromEvents(parsed.events),
    storage: {
      scope: args.scope === 'global' ? 'global' : 'workspace',
      root: paths(args).root,
      events_path: paths(args).events,
      acks_path: paths(args).acks,
    },
    summary: {
      total_events: parsed.events.length,
      unacked: parsed.events.filter((event) => event.ack?.state !== 'acked').length,
      warn_or_higher: parsed.events.filter((event) => SEVERITY_RANK[event.severity] >= SEVERITY_RANK.WARN).length,
    },
    recent_events: recent,
    errors: parsed.errors,
    side_effects: 'none',
    raw_capture_policy: 'preview-only',
  };
}

// Acknowledges an existing event and writes only supervisor ack state.
export function ackSupervisorEvent(args = {}) {
  if (!args.event_id || typeof args.event_id !== 'string') {
    return {
      status: 'error',
      error: { category: 'invalid_request', message: 'event_id is required' },
      side_effects: 'none',
    };
  }
  const p = paths(args);
  const parsed = parseEvents(args);
  const target = parsed.events.find((event) => event.event_id === args.event_id);
  if (!target) {
    return {
      status: 'error',
      error: { category: 'not_found', message: `No supervisor event found for event_id: ${args.event_id}` },
      event_id: args.event_id,
      side_effects: 'none',
    };
  }
  const existing = readAcks(args).acks;
  const now = new Date().toISOString();
  const current = existing[args.event_id];
  if (current?.state === 'acked') {
    return {
      status: 'noop',
      event_id: args.event_id,
      ack: current,
      side_effects: 'none',
    };
  }
  const ack = {
    state: 'acked',
    acked_at: now,
    acked_by: args.actor || 'qe-mcp',
    expires_at: args.expires_at || null,
    severity: target?.severity || null,
    evidence_fingerprint: target?.evidence_fingerprint || null,
  };
  const merged = { ...existing, [args.event_id]: ack };
  if (target) merged[eventIdentity(target)] = ack;
  // Prune expired and orphaned acks so acks.json cannot grow unbounded.
  const next = pruneAcks(merged, parsed.events, now, { [args.event_id]: true, [eventIdentity(target)]: true });
  mkdirSync(dirname(p.acks), { recursive: true });
  const tmp = `${p.acks}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, p.acks);
  return {
    status: 'acked',
    event_id: args.event_id,
    ack,
    side_effects: 'writes ack state only',
    path: p.acks,
  };
}

// Lists predefined monitor specs without running monitor commands.
export function listSupervisorSpecs(args = {}) {
  const specs = args.monitor_id
    ? MONITOR_SPECS.filter((spec) => spec.monitor_id === args.monitor_id)
    : [...MONITOR_SPECS];
  return {
    schema: 'qe.supervisor.specs.v1',
    status: specs.length ? 'ok' : 'degraded',
    specs,
    errors: specs.length ? [] : [degraded('missing_monitor_spec', args.monitor_id)],
    side_effects: 'none',
  };
}

// Produces a no-side-effect scheduler install plan for supported platforms.
export function planSupervisorInstall(args = {}) {
  const platform = args.platform || process.platform;
  const supported = ['darwin'];
  if (!supported.includes(platform)) {
    return {
      status: 'degraded',
      error_code: 'UNSUPPORTED_PLATFORM',
      platform,
      supported_platforms: supported,
      next_step: 'Use dry-run/status only or wait for a platform adapter',
      side_effects: 'none',
    };
  }
  return {
    schema: 'qe.supervisor.install-plan.v1',
    status: 'dry_run',
    platform,
    supported_platforms: supported,
    scheduler_owner: 'launchd',
    planned_files: [
      {
        path: '~/Library/LaunchAgents/com.inho-team.qe-supervisor.plist',
        action: 'would_write',
      },
    ],
    planned_commands: ['launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.inho-team.qe-supervisor.plist'],
    monitor_specs: MONITOR_SPECS.map((spec) => spec.monitor_id),
    side_effects: 'none',
  };
}

// Returns the Phase 2 fail-closed response for non-dry-run install attempts.
export function failInstallWithoutDryRun() {
  return {
    status: 'error',
    error: {
      category: 'dry_run_required',
      message: 'Phase 2 supports supervisor install planning only. Re-run with --dry-run.',
    },
    side_effects: 'none',
  };
}
