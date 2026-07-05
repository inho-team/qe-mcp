import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { pruneRunDir } from './state_reaper.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_LOG_BYTES = 200000;
const RECOVERABLE_WRITE_JOBS = new Set(['qrefresh', 'qarchive', 'qsweep']);

export const PERMISSION_CLASSES = Object.freeze([
  'read-only',
  'report-only',
  'recoverable-write',
  'source-write',
  'config-write',
  'secret/env access',
  'runner delegation',
]);

const FORBIDDEN_BY_DEFAULT = Object.freeze([
  'source-write',
  'config-write',
  'secret/env access',
  'runner delegation',
]);

const JOBS = Object.freeze([
  {
    job_id: 'qprofile',
    title: 'Qprofile telemetry collection boundary',
    candidate: 'Qprofile',
    class: 'report-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['telemetry/report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework',
    recommended_destination: 'framework-local',
    summary: 'Profile telemetry stays outside QA/source verification evidence.',
  },
  {
    job_id: 'qrefresh',
    title: 'Qrefresh analysis refresh candidate',
    candidate: 'Qrefresh',
    class: 'recoverable-write',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['dry-run/report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'secret/env access', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework',
    recommended_destination: 'qe-mcp catalog/status',
    summary: 'Recoverable write candidate; implementation must remain framework-owned.',
  },
  {
    job_id: 'qarchive',
    title: 'Qarchive completed task archive candidate',
    candidate: 'Qarchive',
    class: 'recoverable-write',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['dry-run/report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'secret/env access', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework',
    recommended_destination: 'qe-mcp catalog/status',
    summary: 'Recoverable archive candidate; automatic write execution is not enabled in this MCP surface.',
  },
  {
    job_id: 'qsweep',
    title: 'Qsweep .qe cleanup candidate',
    candidate: 'Qsweep',
    class: 'recoverable-write',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['dry-run/report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'secret/env access', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework',
    recommended_destination: 'qe-mcp catalog/status',
    summary: 'Recoverable cleanup candidate; source/config writes remain forbidden.',
  },
  {
    job_id: 'qdoctor',
    title: 'Qdoctor health diagnostic',
    candidate: 'Qdoctor',
    class: 'read-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['read-only', 'report-only'],
    forbidden_permissions: ['config-write', 'source-write', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework',
    recommended_destination: 'qe-mcp catalog/status',
    summary: 'Diagnostic status only; safe repairs require explicit framework-owned approval.',
  },
  {
    job_id: 'qmcp-sync',
    title: 'Qmcp-sync dry-run boundary',
    candidate: 'Qmcp-sync',
    class: 'report-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['diff/report-only'],
    forbidden_permissions: ['config-write', 'source-write', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework/qe-mcp',
    recommended_destination: 'qe-mcp catalog/status',
    summary: 'Config apply is forbidden for scheduled maintenance; report-only sync checks are allowed.',
  },
  {
    job_id: 'qverify-contract',
    title: 'Qverify-contract source verification gate',
    candidate: 'Qverify-contract',
    class: 'read-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['read-only', 'report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework',
    recommended_destination: 'QA gate',
    summary: 'Contract verification evidence must not mix with profile telemetry.',
  },
  {
    job_id: 'qwiki-lint',
    title: 'Qwiki-lint source/wiki verification gate',
    candidate: 'Qwiki-lint',
    class: 'read-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['read-only', 'report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'runner delegation'],
    requires_runner: false,
    runnable: false,
    framework_owner: 'qe-framework',
    recommended_destination: 'QA gate',
    summary: 'Wiki lint may report drift; automatic source rewrites are outside this MCP surface.',
  },
  {
    job_id: 'qe-framework-validate',
    title: 'qe-framework npm run qe:validate',
    candidate: 'npm run qe:validate',
    class: 'read-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['read-only', 'report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'runner delegation'],
    requires_runner: false,
    runnable: true,
    repo_hint: 'qe-framework',
    command: process.execPath,
    args: ['scripts/validate_svs_config.mjs'],
    cwd_strategy: 'workspace-repo',
    framework_owner: 'qe-framework',
    recommended_destination: 'QA gate',
    summary: 'Validates framework SIVS config without mutating source/config.',
  },
  {
    job_id: 'qe-framework-check-all',
    title: 'qe-framework node scripts/check-all.mjs',
    candidate: 'node scripts/check-all.mjs',
    class: 'read-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['read-only', 'report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'runner delegation'],
    requires_runner: false,
    runnable: true,
    repo_hint: 'qe-framework',
    command: process.execPath,
    args: ['scripts/check-all.mjs'],
    cwd_strategy: 'workspace-repo',
    framework_owner: 'qe-framework',
    recommended_destination: 'QA gate',
    summary: 'Runs framework guard suite as QA evidence, not telemetry.',
  },
  {
    job_id: 'qe-mcp-check',
    title: 'qe-mcp npm run check',
    candidate: 'npm run check',
    class: 'read-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['read-only', 'report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'runner delegation'],
    requires_runner: false,
    runnable: true,
    repo_hint: 'qe-mcp',
    command: 'npm',
    args: ['run', 'check'],
    cwd_strategy: 'mcp-root',
    framework_owner: 'qe-mcp',
    recommended_destination: 'QA gate',
    summary: 'Runs qe-mcp syntax checks.',
  },
  {
    job_id: 'qe-mcp-selftest',
    title: 'qe-mcp npm run selftest',
    candidate: 'npm run selftest',
    class: 'read-only',
    default_mode: 'dry-run',
    scheduler_owner: 'external',
    allowed_effects: ['read-only', 'report-only'],
    forbidden_permissions: ['source-write', 'config-write', 'runner delegation'],
    requires_runner: false,
    runnable: true,
    repo_hint: 'qe-mcp',
    command: 'npm',
    args: ['run', 'selftest'],
    cwd_strategy: 'mcp-root',
    framework_owner: 'qe-mcp',
    recommended_destination: 'QA gate',
    summary: 'Runs qe-mcp MCP server selftest.',
  },
]);

const JOBS_BY_ID = new Map(JOBS.map((job) => [job.job_id, job]));

function maintenanceError(category, message, retryable = false) {
  return {
    status: 'error',
    error: { category, message, retryable },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function getWorkspaceRoot(args = {}) {
  return resolve(args.workspace_root || args.cwd || process.cwd());
}

function getMaintenanceRoot(args = {}) {
  return resolve(getWorkspaceRoot(args), '.qe', 'state', 'mcp-maintenance');
}

function getLogRoot(args = {}) {
  return resolve(getWorkspaceRoot(args), '.qe', 'logs', 'mcp-maintenance');
}

function getRecoveryRoot(args = {}) {
  return resolve(getMaintenanceRoot(args), 'recovery');
}

function recoverableStatePath(args, jobId) {
  return resolve(getMaintenanceRoot(args), 'recoverable', `${jobId}.json`);
}

function recoveryManifestPath(args, runId) {
  return resolve(getRecoveryRoot(args), `${runId}.json`);
}

function statePathForRun(args, runId) {
  return resolve(getMaintenanceRoot(args), 'runs', `${runId}.json`);
}

function statePathForJob(args, jobId) {
  return resolve(getMaintenanceRoot(args), 'jobs', `${jobId}.json`);
}

function logPathForRun(args, jobId, runId) {
  return resolve(getLogRoot(args), jobId, `${runId}.log`);
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function safeJsonRead(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  ensureParent(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serializeJob(job, args = {}) {
  return {
    job_id: job.job_id,
    title: job.title,
    candidate: job.candidate,
    class: job.class,
    default_mode: job.default_mode,
    scheduler_owner: job.scheduler_owner,
    allowed_effects: [...job.allowed_effects],
    forbidden_permissions: [...job.forbidden_permissions],
    requires_runner: job.requires_runner,
    runnable: job.runnable,
    repo_hint: job.repo_hint || null,
    default_cwd: resolveJobCwd(job, args, { strict: false }),
    state_path: statePathForJob(args, job.job_id),
    log_path_template: resolve(getLogRoot(args), job.job_id, '<run_id>.log'),
    framework_owner: job.framework_owner,
    recommended_destination: job.recommended_destination,
    summary: job.summary,
  };
}

function normalizeJobIds(args = {}) {
  if (Array.isArray(args.job_ids)) return args.job_ids;
  if (typeof args.job_id === 'string' && args.job_id.trim()) return [args.job_id.trim()];
  return [];
}

function filterJobs(args = {}) {
  const ids = normalizeJobIds(args);
  const classes = Array.isArray(args.classes) ? new Set(args.classes) : null;
  return JOBS.filter((job) => {
    if (ids.length && !ids.includes(job.job_id)) return false;
    if (classes && !classes.has(job.class)) return false;
    return true;
  });
}

export function listMaintenanceJobs(args = {}) {
  return {
    status: 'ok',
    scheduler_owner: 'external',
    hidden_scheduler: false,
    permission_classes: [...PERMISSION_CLASSES],
    jobs: filterJobs(args).map((job) => serializeJob(job, args)),
  };
}

function getJob(jobId) {
  const job = JOBS_BY_ID.get(jobId);
  if (!job) {
    return null;
  }
  return job;
}

function normalizeMode(mode) {
  return mode || 'dry-run';
}

function normalizePermissionProfile(args, job) {
  if (typeof args.permission_profile === 'string' && args.permission_profile.trim()) {
    return args.permission_profile.trim();
  }
  return job.class;
}

function isRecoverableWriteJob(job) {
  return job.class === 'recoverable-write' && RECOVERABLE_WRITE_JOBS.has(job.job_id);
}

function buildChangedPathsPreview(job, args = {}) {
  if (!isRecoverableWriteJob(job)) return [];
  return [recoverableStatePath(args, job.job_id)];
}

function buildRecoveryStrategy(job, args = {}) {
  if (!isRecoverableWriteJob(job)) return null;
  const changedPaths = buildChangedPathsPreview(job, args);
  return {
    type: 'restore-or-remove',
    manifest_path_template: resolve(getRecoveryRoot(args), '<run_id>.json'),
    changed_paths: changedPaths,
    steps: [
      'Read the recovery manifest for the run.',
      'For each entry with existed_before=true, restore previous_content.',
      'For each entry with existed_before=false, remove the created file.',
    ],
  };
}

function buildApprovalPayload(job, args = {}) {
  const changedPaths = buildChangedPathsPreview(job, args);
  return {
    job_id: job.job_id,
    mode: 'run-once',
    workspace_root: getWorkspaceRoot(args),
    changed_paths_preview: changedPaths,
    permission_profile: normalizePermissionProfile(args, job),
  };
}

function buildApprovalFingerprint(job, args = {}) {
  return sha256(canonicalJson(buildApprovalPayload(job, args)));
}

function buildRecoverableDryRun(job, args, envelope) {
  const changedPaths = buildChangedPathsPreview(job, args);
  return {
    ...envelope,
    changed_paths_preview: changedPaths,
    recovery_strategy: buildRecoveryStrategy(job, args),
    approval_required: true,
    approval_fingerprint: buildApprovalFingerprint(job, args),
    approval_payload: buildApprovalPayload(job, args),
  };
}

function validateRecoverablePaths(paths, args = {}) {
  const workspaceRoot = getWorkspaceRoot(args);
  const allowedRoot = resolve(workspaceRoot, '.qe', 'state', 'mcp-maintenance');
  for (const path of paths) {
    const resolved = resolve(path);
    const rel = relative(allowedRoot, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return maintenanceError('policy_denied', `recoverable-write path outside allowed state root: ${path}`);
    }
  }
  return null;
}

function validateRecoverableApproval(job, args = {}) {
  if (normalizePermissionProfile(args, job) !== 'recoverable-write') {
    return maintenanceError('policy_denied', 'recoverable-write run-once requires permission_profile=recoverable-write');
  }
  if (args.confirm_recoverable_write !== true) {
    return maintenanceError('policy_denied', 'recoverable-write requires confirm_recoverable_write=true');
  }
  const expected = buildApprovalFingerprint(job, args);
  const provided = args.approval_fingerprint || args.approval_token || args.approval_id || '';
  if (provided !== expected) {
    return maintenanceError('policy_denied', 'recoverable-write approval fingerprint mismatch');
  }
  return null;
}

function denyIfForbidden(args, job, mode) {
  if (args.allow_source_write === true || args.source_write === true) {
    return maintenanceError('policy_denied', 'source-write is forbidden for maintenance jobs');
  }
  if (args.allow_config_write === true || args.config_write === true) {
    return maintenanceError('policy_denied', 'config-write is forbidden for scheduled maintenance jobs');
  }
  if (args.allow_secret_env_access === true || args.secret_env_access === true) {
    return maintenanceError('policy_denied', 'secret/env access is forbidden for maintenance jobs');
  }
  if (args.allow_runner_delegation === true || args.runner_delegation === true) {
    return maintenanceError('policy_denied', 'runner delegation is forbidden for maintenance jobs');
  }
  if (args.allow_recursive_delegation === true || Number(args.call_depth || 0) > 0) {
    return maintenanceError('recursion_blocked', 'recursive maintenance execution is forbidden');
  }
  const requestedPermission = normalizePermissionProfile(args, job);
  if (FORBIDDEN_BY_DEFAULT.includes(requestedPermission) || job.forbidden_permissions.includes(requestedPermission)) {
    return maintenanceError('policy_denied', `permission_profile denied for ${job.job_id}: ${requestedPermission}`);
  }
  return null;
}

function resolveJobCwd(job, args = {}, { strict = true } = {}) {
  if (job.cwd_strategy === 'mcp-root') return REPO_ROOT;
  if (job.cwd_strategy === 'workspace-repo') {
    const workspaceRoot = getWorkspaceRoot(args);
    const candidate = resolve(workspaceRoot, job.repo_hint);
    if (existsSync(candidate)) return candidate;
    if (strict) throw Object.assign(new Error(`required repo not found for ${job.job_id}: ${candidate}`), { category: 'not_installed' });
    return candidate;
  }
  return getWorkspaceRoot(args);
}

function buildRunEnvelope({ job, args, mode, runId, status, summary, error = null, startedAt = null, finishedAt = null, exitCode = null }) {
  const requestedPermission = normalizePermissionProfile(args, job);
  return {
    tool: 'qe_run_maintenance_job',
    status,
    summary,
    job: {
      ...serializeJob(job, args),
      requested_permission: requestedPermission,
      effective_permission: mode === 'dry-run' ? 'report-only' : job.class,
    },
    run: {
      run_id: runId,
      trigger: args.trigger || 'manual',
      mode,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: exitCode,
      stale: false,
      stale_reason: null,
    },
    paths: {
      state_file: statePathForRun(args, runId),
      job_state_file: statePathForJob(args, job.job_id),
      log_file: logPathForRun(args, job.job_id, runId),
      recovery_manifest_file: recoveryManifestPath(args, runId),
    },
    ...(error ? { error } : {}),
  };
}

function runProcess(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxLogBytes = options.maxLogBytes || DEFAULT_MAX_LOG_BYTES;
  const executable = process.platform === 'win32' && command === 'npm' && process.env.npm_execpath
    ? process.execPath
    : command;
  const args = process.platform === 'win32' && command === 'npm' && process.env.npm_execpath
    ? [process.env.npm_execpath, ...commandArgs]
    : commandArgs;
  const env = {};
  const copyEnv = (key) => {
    if (typeof process.env[key] === 'string') {
      env[key] = process.env[key];
    }
  };
  for (const key of ['PATH', 'Path', 'HOME', 'LANG', 'LC_ALL']) {
    copyEnv(key);
  }
  if (process.platform === 'win32') {
    for (const key of ['APPDATA', 'ComSpec', 'LOCALAPPDATA', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'windir']) {
      copyEnv(key);
    }
  }
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') <= maxLogBytes) return next;
      return next.slice(-maxLogBytes);
    };

    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, signal: null, stdout, stderr: stderr || error.message, timedOut, error });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut, error: null });
    });
  });
}

export async function runMaintenanceJob(args = {}) {
  const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
  const job = getJob(jobId);
  if (!job) {
    return {
      tool: 'qe_run_maintenance_job',
      ...maintenanceError('job_not_found', `unknown maintenance job: ${jobId || '(empty)'}`),
    };
  }

  const mode = normalizeMode(args.mode);
  if (!['dry-run', 'run-once'].includes(mode)) {
    return {
      tool: 'qe_run_maintenance_job',
      job: serializeJob(job, args),
      ...maintenanceError('unsupported_mode', `unsupported maintenance mode: ${mode}`),
    };
  }

  const denied = denyIfForbidden(args, job, mode);
  if (denied) {
    return {
      tool: 'qe_run_maintenance_job',
      job: serializeJob(job, args),
      ...denied,
    };
  }

  const runId = args.run_id || `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${job.job_id}`;
  if (mode === 'dry-run') {
    const envelope = buildRunEnvelope({
      job,
      args,
      mode,
      runId,
      status: 'dry_run',
      summary: `Dry-run only: ${job.title}`,
    });
    envelope.planned_command = job.runnable
      ? { command: job.command, args: job.args, cwd: resolveJobCwd(job, args, { strict: false }) }
      : null;
    envelope.policy = {
      hidden_scheduler: false,
      source_write_allowed: false,
      config_write_allowed: false,
      secret_env_access_allowed: false,
      runner_delegation_allowed: false,
      recoverable_write_allowed: isRecoverableWriteJob(job),
    };
    return isRecoverableWriteJob(job) ? buildRecoverableDryRun(job, args, envelope) : envelope;
  }

  if (isRecoverableWriteJob(job)) {
    return runRecoverableWriteJob({ job, args, runId, mode });
  }

  if (!job.runnable) {
    return {
      tool: 'qe_run_maintenance_job',
      job: serializeJob(job, args),
      ...maintenanceError('scheduler_required', `${job.job_id} is catalog/status only; use dry-run or framework-owned execution`),
    };
  }

  const startedAt = nowIso();
  const stateFile = statePathForRun(args, runId);
  const logFile = logPathForRun(args, job.job_id, runId);
  let cwd;
  try {
    cwd = resolveJobCwd(job, args, { strict: true });
  } catch (error) {
    const envelope = buildRunEnvelope({
      job,
      args,
      mode,
      runId,
      status: 'error',
      summary: error.message,
      startedAt,
      finishedAt: nowIso(),
      error: { category: error.category || 'not_installed', message: error.message, retryable: false },
    });
    writeJson(stateFile, envelope);
    writeJson(statePathForJob(args, job.job_id), envelope);
    return envelope;
  }

  const pending = buildRunEnvelope({
    job,
    args,
    mode,
    runId,
    status: 'running',
    summary: `Running ${job.title}`,
    startedAt,
  });
  writeJson(stateFile, pending);
  writeJson(statePathForJob(args, job.job_id), pending);

  const capture = await runProcess(job.command, job.args, {
    cwd,
    timeoutMs: Number(args.timeout_ms || DEFAULT_TIMEOUT_MS),
    maxLogBytes: Number(args.max_log_bytes || DEFAULT_MAX_LOG_BYTES),
  });
  const finishedAt = nowIso();
  const logText = [
    `# ${job.job_id} ${runId}`,
    `cwd: ${cwd}`,
    `command: ${[job.command, ...job.args].join(' ')}`,
    `started_at: ${startedAt}`,
    `finished_at: ${finishedAt}`,
    `exit_code: ${capture.code}`,
    `signal: ${capture.signal || ''}`,
    '',
    '## stdout',
    capture.stdout,
    '',
    '## stderr',
    capture.stderr,
    '',
  ].join('\n');
  ensureParent(logFile);
  writeFileSync(logFile, logText, 'utf8');

  const ok = capture.code === 0 && !capture.timedOut && !capture.error;
  const envelope = buildRunEnvelope({
    job,
    args,
    mode,
    runId,
    status: ok ? 'completed' : capture.timedOut ? 'timeout' : 'error',
    summary: ok ? `${job.title} completed` : `${job.title} failed`,
    startedAt,
    finishedAt,
    exitCode: capture.code,
    error: ok
      ? null
      : {
          category: capture.timedOut ? 'timeout' : capture.error?.code === 'ENOENT' ? 'not_installed' : 'nonzero_exit',
          message: capture.error?.message || capture.stderr || `exit ${capture.code}`,
          retryable: Boolean(capture.timedOut),
        },
  });
  envelope.stdout_bytes = Buffer.byteLength(capture.stdout || '', 'utf8');
  envelope.stderr_bytes = Buffer.byteLength(capture.stderr || '', 'utf8');
  writeJson(stateFile, envelope);
  writeJson(statePathForJob(args, job.job_id), envelope);
  // Opportunistic reap of old maintenance run records; best-effort, never fatal.
  try {
    pruneRunDir(resolve(getMaintenanceRoot(args), 'runs'));
  } catch {
    /* reaper is best-effort */
  }
  return envelope;
}

function runRecoverableWriteJob({ job, args, runId, mode }) {
  const approvalDenied = validateRecoverableApproval(job, args);
  if (approvalDenied) {
    return {
      tool: 'qe_run_maintenance_job',
      job: serializeJob(job, args),
      ...approvalDenied,
    };
  }

  const changedPaths = buildChangedPathsPreview(job, args);
  const pathDenied = validateRecoverablePaths(changedPaths, args);
  if (pathDenied) {
    return {
      tool: 'qe_run_maintenance_job',
      job: serializeJob(job, args),
      ...pathDenied,
    };
  }

  const startedAt = nowIso();
  const stateFile = statePathForRun(args, runId);
  const logFile = logPathForRun(args, job.job_id, runId);
  const recoveryFile = recoveryManifestPath(args, runId);
  const approvalId = buildApprovalFingerprint(job, args);
  const manifestEntries = changedPaths.map((path) => ({
    path,
    existed_before: existsSync(path),
    previous_content: existsSync(path) ? readFileSync(path, 'utf8') : null,
    restore_action: existsSync(path) ? 'restore-previous-content' : 'remove-created-file',
  }));
  const recoveryManifest = {
    run_id: runId,
    job_id: job.job_id,
    approval_id: approvalId,
    created_at: startedAt,
    changed_paths: changedPaths,
    entries: manifestEntries,
  };
  writeJson(recoveryFile, recoveryManifest);

  const recoverableState = {
    job_id: job.job_id,
    run_id: runId,
    approval_id: approvalId,
    executed_at: startedAt,
    workspace_root: getWorkspaceRoot(args),
    changed_paths: changedPaths,
    recovery_manifest: recoveryFile,
    note: 'Recoverable-write marker only; framework-owned skill execution is not delegated through MCP.',
  };
  for (const path of changedPaths) {
    writeJson(path, recoverableState);
  }

  const finishedAt = nowIso();
  const logText = [
    `# ${job.job_id} ${runId}`,
    `mode: ${mode}`,
    `approval_id: ${approvalId}`,
    `started_at: ${startedAt}`,
    `finished_at: ${finishedAt}`,
    '',
    '## changed_paths',
    ...changedPaths,
    '',
    `recovery_manifest: ${recoveryFile}`,
    '',
  ].join('\n');
  ensureParent(logFile);
  writeFileSync(logFile, logText, 'utf8');

  const envelope = buildRunEnvelope({
    job,
    args,
    mode,
    runId,
    status: 'completed',
    summary: `${job.title} recoverable-write marker completed`,
    startedAt,
    finishedAt,
    exitCode: 0,
  });
  envelope.changed_paths = changedPaths;
  envelope.recovery_manifest = recoveryManifest;
  envelope.approval_id = approvalId;
  writeJson(stateFile, envelope);
  writeJson(statePathForJob(args, job.job_id), envelope);
  return envelope;
}

export function getMaintenanceJobStatus(args = {}) {
  const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
  if (runId) {
    const state = safeJsonRead(statePathForRun(args, runId));
    if (!state) return { tool: 'qe_get_maintenance_job_status', ...maintenanceError('state_not_found', `run state not found: ${runId}`) };
    return { tool: 'qe_get_maintenance_job_status', status: 'ok', state };
  }

  const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
  if (jobId) {
    const job = getJob(jobId);
    if (!job) return { tool: 'qe_get_maintenance_job_status', ...maintenanceError('job_not_found', `unknown maintenance job: ${jobId}`) };
    const state = safeJsonRead(statePathForJob(args, jobId));
    return {
      tool: 'qe_get_maintenance_job_status',
      status: 'ok',
      job: serializeJob(job, args),
      state,
      stale: state ? state.run?.stale || false : true,
      stale_reason: state ? null : 'no recorded run',
    };
  }

  const jobsDir = resolve(getMaintenanceRoot(args), 'jobs');
  const states = existsSync(jobsDir)
    ? readdirSync(jobsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => safeJsonRead(resolve(jobsDir, name)))
        .filter(Boolean)
    : [];
  return { tool: 'qe_get_maintenance_job_status', status: 'ok', states };
}

export function getMaintenanceJobLog(args = {}) {
  const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
  if (!runId) return { tool: 'qe_get_maintenance_job_log', ...maintenanceError('policy_denied', 'run_id is required') };
  const state = safeJsonRead(statePathForRun(args, runId));
  if (!state) return { tool: 'qe_get_maintenance_job_log', ...maintenanceError('state_not_found', `run state not found: ${runId}`) };
  const logFile = state.paths?.log_file;
  if (!logFile || !existsSync(logFile)) return { tool: 'qe_get_maintenance_job_log', ...maintenanceError('log_not_found', `run log not found: ${runId}`) };
  const maxBytes = Math.min(Number(args.max_bytes || 24000), 1000000);
  const offset = Math.max(Number(args.offset_bytes || 0), 0);
  const stat = statSync(logFile);
  const text = readFileSync(logFile, 'utf8');
  const slice = text.slice(offset, offset + maxBytes);
  return {
    tool: 'qe_get_maintenance_job_log',
    status: 'ok',
    run_id: runId,
    log_file: logFile,
    text: slice,
    truncated: offset + Buffer.byteLength(slice, 'utf8') < stat.size,
    next_offset: offset + Buffer.byteLength(slice, 'utf8'),
    eof: offset + Buffer.byteLength(slice, 'utf8') >= stat.size,
  };
}

export function buildMaintenanceToolSchemas() {
  return {
    qe_list_maintenance_jobs: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_ids: { type: 'array', items: { type: 'string' } },
        classes: { type: 'array', items: { type: 'string', enum: PERMISSION_CLASSES } },
        workspace_root: { type: 'string' },
        cwd: { type: 'string' },
      },
    },
    qe_run_maintenance_job: {
      type: 'object',
      required: ['job_id'],
      additionalProperties: false,
      properties: {
        job_id: { type: 'string' },
        mode: { type: 'string', enum: ['dry-run', 'run-once'] },
        workspace_root: { type: 'string' },
        cwd: { type: 'string' },
        trigger: { type: 'string', enum: ['manual', 'scheduler'] },
        permission_profile: { type: 'string', enum: PERMISSION_CLASSES },
        run_id: { type: 'string' },
        approval_token: { type: 'string' },
        approval_id: { type: 'string' },
        approval_fingerprint: { type: 'string' },
        confirm_recoverable_write: { type: 'boolean' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
        max_log_bytes: { type: 'integer', minimum: 200, maximum: 1000000 },
        call_depth: { type: 'integer', minimum: 0, maximum: 0 },
        allow_source_write: { type: 'boolean' },
        allow_config_write: { type: 'boolean' },
        allow_secret_env_access: { type: 'boolean' },
        allow_runner_delegation: { type: 'boolean' },
        allow_recursive_delegation: { type: 'boolean' },
      },
    },
    qe_get_maintenance_job_status: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: { type: 'string' },
        run_id: { type: 'string' },
        workspace_root: { type: 'string' },
        cwd: { type: 'string' },
      },
    },
    qe_get_maintenance_job_log: {
      type: 'object',
      required: ['run_id'],
      additionalProperties: false,
      properties: {
        run_id: { type: 'string' },
        workspace_root: { type: 'string' },
        cwd: { type: 'string' },
        offset_bytes: { type: 'integer', minimum: 0 },
        max_bytes: { type: 'integer', minimum: 200, maximum: 1000000 },
      },
    },
  };
}
