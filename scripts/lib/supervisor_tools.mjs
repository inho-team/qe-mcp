import { createHash } from 'crypto';
import {
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
  const next = { ...existing, [args.event_id]: ack };
  if (target) next[eventIdentity(target)] = ack;
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
