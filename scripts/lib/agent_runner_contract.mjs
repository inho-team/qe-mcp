import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import { resolve } from 'path';

export const ERROR_CATEGORIES = [
  'not_installed',
  'auth_missing',
  'permission_denied',
  'mcp_config_rejected',
  'timeout',
  'prompt_stalled',
  'nonzero_exit',
  'malformed_output',
  'policy_denied',
  'recursion_blocked',
  'budget_exceeded',
];

export const DEFAULT_RUNNER_POLICY = Object.freeze({
  timeout_ms: 60000,
  max_output_bytes: 24000,
  allow_writes: false,
  sandbox_mode: 'read-only',
  permission_mode: 'plan',
  max_turns: 1,
  max_budget_usd: 0.05,
  max_concurrent_runs: 1,
  max_call_depth: 1,
  mcp_policy: 'none',
  output_mode: 'json',
});

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write']);
const CLAUDE_PERMISSION_MODES = new Set(['plan', 'default', 'dontAsk', 'auto', 'acceptEdits']);
const MCP_POLICIES = new Set(['none', 'strict-generated', 'allowlist']);
const OUTPUT_MODES = new Set(['text', 'json', 'stream-json', 'jsonl']);

// Builds a taxonomy-safe runner error object.
export function makeRunnerError(category, message, retryable = false) {
  return {
    category: ERROR_CATEGORIES.includes(category) ? category : 'nonzero_exit',
    message,
    retryable: Boolean(retryable),
  };
}

// Throws policy-denied failures through a consistent Error shape.
export function policyDenied(message) {
  const error = new Error(message);
  error.category = 'policy_denied';
  error.retryable = false;
  return error;
}

// Resolves cwd and rejects paths outside explicit allowed roots.
export function resolveAllowedCwd(cwd, allowedRoots = [process.cwd()]) {
  const requested = realpathSync(resolve(cwd || process.cwd()));
  const roots = allowedRoots.map((root) => realpathSync(resolve(root)));
  const allowed = roots.some((root) => requested === root || requested.startsWith(`${root}/`));
  if (!allowed) throw policyDenied(`cwd outside allowed roots: ${requested}`);
  return requested;
}

// Coerces integer policy fields while enforcing local bounds.
function asInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw policyDenied(`invalid integer policy value: ${value}`);
  }
  return number;
}

// Coerces numeric policy fields while enforcing local bounds.
function asNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw policyDenied(`invalid numeric policy value: ${value}`);
  }
  return number;
}

// Normalizes MCP runner request arguments into the contract shape.
export function normalizeAgentRunRequest(args = {}, options = {}) {
  const engine = args.engine || options.engine;
  if (!['claude', 'codex'].includes(engine)) throw policyDenied('engine must be claude or codex');

  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : typeof args.task === 'string' ? args.task.trim() : '';
  if (!prompt) throw policyDenied('prompt is required');
  if (Buffer.byteLength(prompt, 'utf8') > 24000) throw policyDenied('prompt too large');

  const cwd = resolveAllowedCwd(args.cwd || process.cwd(), options.allowedRoots || [process.cwd()]);
  const callDepth = asInteger(args.call_depth, 0, { min: 0, max: DEFAULT_RUNNER_POLICY.max_call_depth });
  if (callDepth > 0 && args.allow_recursive_delegation !== true) {
    const error = new Error('recursive runner call blocked');
    error.category = 'recursion_blocked';
    throw error;
  }

  const allowWrites = Boolean(args.allow_writes);
  const sandboxMode = args.sandbox_mode || DEFAULT_RUNNER_POLICY.sandbox_mode;
  const permissionMode = args.permission_mode || DEFAULT_RUNNER_POLICY.permission_mode;
  const mcpPolicy = args.mcp_policy || DEFAULT_RUNNER_POLICY.mcp_policy;
  const outputMode = args.output_mode || (engine === 'codex' ? 'jsonl' : 'json');

  if (!CODEX_SANDBOX_MODES.has(sandboxMode)) {
    throw policyDenied('sandbox_mode denied; danger-full-access is not allowed');
  }
  if (sandboxMode === 'workspace-write' && !allowWrites) {
    throw policyDenied('workspace-write requires allow_writes=true');
  }
  if (!CLAUDE_PERMISSION_MODES.has(permissionMode)) throw policyDenied('permission_mode denied');
  if (permissionMode === 'bypassPermissions') throw policyDenied('bypassPermissions is not allowed');
  if (!MCP_POLICIES.has(mcpPolicy)) throw policyDenied('mcp_policy denied');
  if (mcpPolicy !== 'none' && !Array.isArray(args.allowed_mcp_servers)) {
    const error = new Error('MCP config requires explicit allowed_mcp_servers');
    error.category = 'mcp_config_rejected';
    throw error;
  }
  if (!OUTPUT_MODES.has(outputMode)) throw policyDenied('output_mode denied');

  return {
    prompt,
    cwd,
    engine,
    model: args.model || null,
    timeout_ms: asInteger(args.timeout_ms ?? args.timeoutMs, DEFAULT_RUNNER_POLICY.timeout_ms, { min: 1000, max: 600000 }),
    max_output_bytes: asInteger(args.max_output_bytes ?? args.outputCap, DEFAULT_RUNNER_POLICY.max_output_bytes, {
      min: 200,
      max: 1000000,
    }),
    allow_writes: allowWrites,
    sandbox_mode: sandboxMode,
    permission_mode: permissionMode,
    max_turns: asInteger(args.max_turns, DEFAULT_RUNNER_POLICY.max_turns, { min: 1, max: 5 }),
    max_budget_usd: asNumber(args.max_budget_usd, DEFAULT_RUNNER_POLICY.max_budget_usd, { min: 0, max: 10 }),
    max_concurrent_runs: asInteger(args.max_concurrent_runs, DEFAULT_RUNNER_POLICY.max_concurrent_runs, { min: 1, max: 3 }),
    mcp_policy: mcpPolicy,
    output_mode: outputMode,
    call_depth: callDepth,
    call_chain_id: args.call_chain_id || randomUUID(),
    origin_engine: args.origin_engine || 'unknown',
    allowed_mcp_servers: args.allowed_mcp_servers || [],
  };
}

// Creates the base AgentRunResult envelope used by contract helpers.
export function createBaseResult(request, overrides = {}) {
  return {
    engine: request.engine,
    status: overrides.status || 'error',
    summary: overrides.summary || '',
    output: overrides.output || '',
    events: overrides.events || [],
    metadata: {
      cwd: request.cwd,
      model: request.model || null,
      duration_ms: overrides.duration_ms || 0,
      exit_code: overrides.exit_code ?? null,
      signal: overrides.signal ?? null,
      call_depth: request.call_depth || 0,
      call_chain_id: request.call_chain_id || '',
      origin_engine: request.origin_engine || 'unknown',
      ...(overrides.metadata || {}),
    },
    normalization: {
      output_format: 'unknown',
      normalization_status: 'empty',
      truncated: false,
      stdout_bytes: 0,
      stderr_bytes: 0,
      parse_error: null,
      raw_capture_policy: 'metadata_only',
      ...(overrides.normalization || {}),
    },
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

// Converts thrown exceptions into structured runner result failures.
export function errorResultFromException(request, error) {
  const category = error.category || (error.code === 'ENOENT' ? 'not_installed' : 'nonzero_exit');
  return createBaseResult(request, {
    status: category === 'timeout' ? 'timeout' : 'error',
    summary: error.message || String(error),
    error: makeRunnerError(category, error.message || String(error), Boolean(error.retryable)),
  });
}

const commonProperties = {
  task: { type: 'string' },
  prompt: { type: 'string' },
  cwd: { type: 'string' },
  model: { type: 'string' },
  timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
  max_output_bytes: { type: 'integer', minimum: 200, maximum: 1000000 },
  allow_writes: { type: 'boolean' },
  call_depth: { type: 'integer', minimum: 0, maximum: 1 },
  call_chain_id: { type: 'string' },
  origin_engine: { type: 'string' },
  max_turns: { type: 'integer', minimum: 1, maximum: 5 },
  max_budget_usd: { type: 'number', minimum: 0, maximum: 10 },
  max_concurrent_runs: { type: 'integer', minimum: 1, maximum: 3 },
  mcp_policy: { type: 'string', enum: ['none', 'strict-generated', 'allowlist'] },
  output_mode: { type: 'string', enum: ['text', 'json', 'stream-json', 'jsonl'] },
};

// Provides MCP input schemas for active runner and passive help tools.
export function buildToolSchemas() {
  const codexSchema = {
    type: 'object',
    required: ['prompt'],
    additionalProperties: false,
    properties: {
      ...commonProperties,
      sandbox_mode: { type: 'string', enum: ['read-only', 'workspace-write'] },
    },
  };
  const claudeSchema = {
    type: 'object',
    required: ['prompt'],
    additionalProperties: false,
    properties: {
      ...commonProperties,
      permission_mode: { type: 'string', enum: ['plan', 'default', 'dontAsk', 'auto', 'acceptEdits'] },
    },
  };
  const helpSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      freshness_ms: { type: 'integer', minimum: 0 },
    },
  };

  return {
    codex: codexSchema,
    claude: claudeSchema,
    help: helpSchema,
    qe_run_codex_agent: codexSchema,
    qe_run_claude_agent: claudeSchema,
    qe_cross_agent_help: helpSchema,
  };
}
