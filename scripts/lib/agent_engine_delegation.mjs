import { createHash, randomUUID } from 'crypto';
import { accessSync, constants, existsSync, realpathSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { delimiter, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { pruneRunDir } from './state_reaper.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = realpathSync(resolve(MODULE_DIR, '..', '..'));

export const DELEGATION_STATES = Object.freeze(['accepted', 'denied', 'started', 'completed', 'timeout', 'failed']);
export const ENGINE_IDS = Object.freeze(['codex', 'claude']);

const ENGINE_CAPABILITIES = Object.freeze({
  codex: {
    output_modes: ['text', 'jsonl', 'stream-json'],
    permission_posture: 'sandboxed-read-only-by-default',
    write_modes: ['workspace-write'],
    mcp_policy: 'none',
  },
  claude: {
    output_modes: ['json', 'stream-json'],
    permission_posture: 'plan-only',
    write_modes: [],
    mcp_policy: 'none',
  },
});
const lifecycleTransitionQueues = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function lifecycleDir(stateRoot = REPO_ROOT) {
  return join(stateRoot, '.qe', 'state', 'agent-runs');
}

function lifecyclePath(runId, stateRoot = REPO_ROOT) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(runId || ''))) {
    throw new Error('invalid lifecycle run id');
  }
  return join(lifecycleDir(stateRoot), `${runId}.json`);
}

function findExecutable(command, env = process.env) {
  const commandText = String(command || '').trim();
  if (!commandText) return null;
  if (commandText.includes('/')) {
    try {
      accessSync(commandText, constants.X_OK);
      return commandText;
    } catch {
      return null;
    }
  }
  for (const entry of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(entry, commandText);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep probing PATH.
    }
  }
  return null;
}

export function buildDelegationDirection(request = {}, targetEngine = request.engine) {
  const originEngine = request.origin_engine || 'unknown';
  return {
    origin_engine: originEngine,
    target_engine: targetEngine,
    delegation_direction: `${originEngine}->${targetEngine}`,
    call_depth: request.call_depth || 0,
    call_chain_id: request.call_chain_id || '',
    intent: request.intent || 'bounded-local-runner',
  };
}

export function buildPromptEnvelope(request = {}, direction = buildDelegationDirection(request)) {
  const boundary = [
    'QE Delegation Envelope',
    `origin_engine: ${direction.origin_engine}`,
    `target_engine: ${direction.target_engine}`,
    `delegation_direction: ${direction.delegation_direction}`,
    `call_depth: ${direction.call_depth}`,
    `cwd: ${request.cwd || ''}`,
    `write_posture: ${request.allow_writes ? 'explicit-writes-enabled' : 'read-only-default'}`,
    `mcp_policy: ${request.mcp_policy || 'none'}`,
    `output_mode: ${request.output_mode || 'json'}`,
    'trust_boundary: child agents do not inherit parent MCP config, secrets, or unbounded permissions.',
    'project_instructions: follow repository instruction files visible from the delegated cwd.',
  ];

  return {
    version: 1,
    direction,
    prompt_bytes: byteLength(request.prompt),
    prompt_sha256: sha256(request.prompt),
    boundary,
    prompt: `${boundary.map((line) => `[${line}]`).join('\n')}\n\n${request.prompt}`,
  };
}

export function resolveEngineCapability({ targetEngine, command, request = {}, options = {} } = {}) {
  const base = ENGINE_CAPABILITIES[targetEngine] || {};
  const override = options.capability || options.capabilityOverride || null;
  const executable = options.spawnImpl ? command || targetEngine : findExecutable(command || targetEngine, options.env || process.env);
  const ready = override?.ready ?? override?.cli_ready ?? Boolean(executable);
  const outputModes = override?.output_modes || override?.supported_output_modes || base.output_modes || [];
  const capability = {
    engine: targetEngine,
    cli_ready: Boolean(ready),
    command: command || targetEngine,
    executable: executable || null,
    output_modes: outputModes,
    permission_posture: override?.permission_posture || base.permission_posture || 'unknown',
    write_modes: override?.write_modes || base.write_modes || [],
    mcp_policy: override?.mcp_policy || base.mcp_policy || 'none',
    model_support: override?.model_support || (request.model ? 'caller-selected' : 'default'),
  };
  return capability;
}

export function planDelegation({ request, targetEngine = request.engine, command, options = {} } = {}) {
  const direction = buildDelegationDirection(request, targetEngine);
  const capability = resolveEngineCapability({ targetEngine, command, request, options });
  const supportedOutput = capability.output_modes.includes(request.output_mode);

  if (!ENGINE_IDS.includes(targetEngine)) {
    return {
      accepted: false,
      status: 'denied',
      reason: `unsupported target engine: ${targetEngine}`,
      error_category: 'policy_denied',
      launch_allowed: false,
      direction,
      capability,
    };
  }
  if (!capability.cli_ready) {
    return {
      accepted: false,
      status: 'denied',
      reason: `${targetEngine} CLI is not available`,
      error_category: 'not_installed',
      launch_allowed: false,
      direction,
      capability,
    };
  }
  if (!supportedOutput) {
    return {
      accepted: false,
      status: 'denied',
      reason: `${targetEngine} does not support output_mode=${request.output_mode}`,
      error_category: 'policy_denied',
      launch_allowed: false,
      direction,
      capability,
    };
  }
  if (request.mcp_policy !== 'none') {
    return {
      accepted: false,
      status: 'denied',
      reason: 'child MCP config is not inherited by delegation engine',
      error_category: 'mcp_config_rejected',
      launch_allowed: false,
      direction,
      capability,
    };
  }

  return {
    accepted: true,
    status: 'accepted',
    reason: 'capability matched bounded local runner policy',
    error_category: null,
    launch_allowed: true,
    direction,
    capability,
  };
}

function requestMetadata(request = {}, envelope = {}) {
  return {
    cwd: request.cwd || '',
    model: request.model || null,
    timeout_ms: request.timeout_ms,
    max_output_bytes: request.max_output_bytes,
    allow_writes: Boolean(request.allow_writes),
    sandbox_mode: request.sandbox_mode || null,
    permission_mode: request.permission_mode || null,
    max_turns: request.max_turns,
    max_budget_usd: request.max_budget_usd,
    max_concurrent_runs: request.max_concurrent_runs,
    mcp_policy: request.mcp_policy || 'none',
    output_mode: request.output_mode || 'unknown',
    prompt_bytes: envelope.prompt_bytes ?? byteLength(request.prompt),
    prompt_sha256: envelope.prompt_sha256 || sha256(request.prompt),
    raw_capture_policy: 'metadata_only',
  };
}

async function writeLifecycleRecord(record, stateRoot = REPO_ROOT) {
  const dir = lifecycleDir(stateRoot);
  await mkdir(dir, { recursive: true });
  const target = lifecyclePath(record.run_id, stateRoot);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return target;
}

export function getLifecycleRecordPath(runId, stateRoot = REPO_ROOT) {
  return lifecyclePath(runId, stateRoot);
}

function assertLifecycleRecordShape(record, runId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('lifecycle record is not an object');
  }
  if (record.run_id !== runId) {
    throw new Error('lifecycle record run_id mismatch');
  }
  if (!DELEGATION_STATES.includes(record.status)) {
    throw new Error('lifecycle record has invalid status');
  }
  if (record.transitions !== undefined && !Array.isArray(record.transitions)) {
    throw new Error('lifecycle record transitions must be an array');
  }
}

export async function readLifecycleRecord(runId, stateRoot = REPO_ROOT) {
  const target = lifecyclePath(runId, stateRoot);
  if (!existsSync(target)) return null;
  try {
    const record = JSON.parse(await readFile(target, 'utf8'));
    assertLifecycleRecordShape(record, runId);
    return record;
  } catch (cause) {
    const error = new Error(`agent run state is unreadable: ${runId}`);
    error.category = 'corrupt_state';
    error.retryable = false;
    error.cause = cause;
    throw error;
  }
}

export async function getAgentRunProjection(runId, { stateRoot = REPO_ROOT, includeTransitions = true } = {}) {
  const record = await readLifecycleRecord(runId, stateRoot);
  if (!record) {
    const error = new Error(`agent run not found: ${runId}`);
    error.category = 'not_found';
    throw error;
  }
  return {
    run_id: record.run_id,
    schema_version: record.schema_version || 1,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    direction: record.direction || null,
    decision: record.decision || null,
    capability: record.capability
      ? {
          engine: record.capability.engine,
          cli_ready: record.capability.cli_ready,
          output_modes: record.capability.output_modes || [],
          permission_posture: record.capability.permission_posture || 'unknown',
          mcp_policy: record.capability.mcp_policy || 'none',
          model_support: record.capability.model_support || 'default',
        }
      : null,
    request: record.request
      ? {
          cwd_redacted: Boolean(record.request.cwd),
          model: record.request.model || null,
          timeout_ms: record.request.timeout_ms,
          max_output_bytes: record.request.max_output_bytes,
          allow_writes: Boolean(record.request.allow_writes),
          sandbox_mode: record.request.sandbox_mode || null,
          permission_mode: record.request.permission_mode || null,
          max_turns: record.request.max_turns,
          max_budget_usd: record.request.max_budget_usd,
          max_concurrent_runs: record.request.max_concurrent_runs,
          mcp_policy: record.request.mcp_policy || 'none',
          output_mode: record.request.output_mode || 'unknown',
          prompt_bytes: record.request.prompt_bytes || 0,
          prompt_sha256: record.request.prompt_sha256 || null,
          raw_capture_policy: 'metadata_only',
        }
      : null,
    result: record.result
      ? {
          status: record.result.status,
          duration_ms: record.result.duration_ms || 0,
          exit_code: record.result.exit_code ?? null,
          signal: record.result.signal ?? null,
          normalization: record.result.normalization || {},
          raw_capture_policy: 'metadata_only',
        }
      : null,
    transitions: includeTransitions
      ? (record.transitions || []).map((transition) => ({
          status: transition.status,
          at: transition.at,
          ...(transition.reason ? { reason: transition.reason } : {}),
        }))
      : undefined,
    raw_capture_policy: 'metadata_only',
  };
}

export async function createDelegationRun({ request, targetEngine = request.engine, command, options = {} } = {}) {
  const decision = planDelegation({ request, targetEngine, command, options });
  const envelope = buildPromptEnvelope(request, decision.direction);
  const runId = options.runId || randomUUID();
  const stateRoot = options.stateRoot || REPO_ROOT;
  const record = {
    schema_version: 1,
    run_id: runId,
    status: decision.accepted ? 'accepted' : 'denied',
    created_at: nowIso(),
    updated_at: nowIso(),
    direction: decision.direction,
    decision: {
      accepted: decision.accepted,
      reason: decision.reason,
      launch_allowed: decision.launch_allowed,
      error_category: decision.error_category,
    },
    capability: decision.capability,
    request: requestMetadata(request, envelope),
    transitions: [
      {
        status: decision.accepted ? 'accepted' : 'denied',
        at: nowIso(),
        reason: decision.reason,
      },
    ],
  };
  const path = await writeLifecycleRecord(record, stateRoot);
  // Opportunistic reap of old agent-run records. The just-written record is safe
  // (grace window). A reaper failure must never break delegation, so swallow it.
  try {
    pruneRunDir(lifecycleDir(stateRoot));
  } catch {
    /* reaper is best-effort */
  }
  return {
    run_id: runId,
    path,
    state_root: stateRoot,
    decision,
    envelope,
  };
}

export async function transitionDelegationRun(run, status, details = {}) {
  if (!run?.run_id) return null;
  if (!DELEGATION_STATES.includes(status)) throw new Error(`invalid lifecycle status: ${status}`);
  const queueKey = `${run.state_root || REPO_ROOT}:${run.run_id}`;
  const previous = lifecycleTransitionQueues.get(queueKey) || Promise.resolve();
  const next = previous.then(async () => {
    const stateRoot = run.state_root || REPO_ROOT;
    const existing = (await readLifecycleRecord(run.run_id, stateRoot)) || {};
    const transition = {
      status,
      at: nowIso(),
      ...(details.reason ? { reason: details.reason } : {}),
    };
    const record = {
      ...existing,
      run_id: run.run_id,
      status,
      updated_at: transition.at,
      result: details.result
        ? {
            status: details.result.status,
            duration_ms: details.result.metadata?.duration_ms || 0,
            exit_code: details.result.metadata?.exit_code ?? null,
            signal: details.result.metadata?.signal ?? null,
            normalization: details.result.normalization || {},
            raw_capture_policy: 'metadata_only',
          }
        : existing.result,
      transitions: [...(existing.transitions || []), transition],
    };
    const path = await writeLifecycleRecord(record, stateRoot);
    return { ...record, path };
  });
  const queued = next.catch(() => {});
  lifecycleTransitionQueues.set(queueKey, queued);
  try {
    return await next;
  } finally {
    if (lifecycleTransitionQueues.get(queueKey) === queued) {
      lifecycleTransitionQueues.delete(queueKey);
    }
  }
}

export function decorateDelegationResult(result, run) {
  if (!result || !run) return result;
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      origin_engine: run.decision.direction.origin_engine,
      target_engine: run.decision.direction.target_engine,
      delegation_direction: run.decision.direction.delegation_direction,
      lifecycle: {
        ...(result.metadata?.lifecycle || {}),
        run_id: run.run_id,
        status: result.status === 'ok' ? 'completed' : result.status === 'timeout' ? 'timeout' : 'failed',
      },
      decision: {
        accepted: run.decision.accepted,
        reason: run.decision.reason,
        launch_allowed: run.decision.launch_allowed,
      },
    },
  };
}

export function makeDelegationDeniedError(decision) {
  const error = new Error(decision.reason || 'delegation denied');
  error.category = decision.error_category || 'policy_denied';
  error.retryable = error.category === 'not_installed';
  return error;
}
