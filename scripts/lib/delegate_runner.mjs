import { makeAgentRunResult } from './agent_runner_common.mjs';
import { runClaudeAgent } from './claude_runner.mjs';
import { runCodexAgent } from './codex_runner.mjs';

const ALLOWED_POLICY_FIELDS = new Set([
  'allow_writes',
  'sandbox_mode',
  'permission_mode',
  'mcp_policy',
  'max_concurrent_runs',
]);
const ALLOWED_OUTPUT_CONTRACT_FIELDS = new Set(['output_mode', 'max_output_bytes']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickKnownFields(source, allowedFields) {
  const picked = {};
  const unknown = [];
  for (const [key, value] of Object.entries(source || {})) {
    if (!allowedFields.has(key)) {
      unknown.push(key);
      continue;
    }
    picked[key] = value;
  }
  return { picked, unknown };
}

function denyDelegateRequest(engine, message) {
  return makeAgentRunResult({
    engine: engine || 'unknown',
    request: {
      cwd: null,
      model: null,
      call_depth: 0,
      call_chain_id: '',
      origin_engine: 'mcp',
      max_output_bytes: 0,
    },
    status: 'error',
    summary: message,
    error: {
      category: 'policy_denied',
      message,
      retryable: false,
    },
  });
}

function normalizeDelegateArgs(args = {}) {
  const targetEngine = args.target_engine || args.engine;
  const policy = isPlainObject(args.policy) ? args.policy : {};
  const outputContract = isPlainObject(args.output_contract) ? args.output_contract : {};
  const policySelection = pickKnownFields(policy, ALLOWED_POLICY_FIELDS);
  const outputSelection = pickKnownFields(outputContract, ALLOWED_OUTPUT_CONTRACT_FIELDS);

  if (policySelection.unknown.length > 0) {
    return {
      targetEngine,
      args: null,
      error: {
        category: 'policy_denied',
        message: `unsupported policy field(s): ${policySelection.unknown.join(', ')}`,
        retryable: false,
      },
    };
  }
  if (outputSelection.unknown.length > 0) {
    return {
      targetEngine,
      args: null,
      error: {
        category: 'policy_denied',
        message: `unsupported output_contract field(s): ${outputSelection.unknown.join(', ')}`,
        retryable: false,
      },
    };
  }

  return {
    targetEngine,
    args: {
      ...args,
      ...policySelection.picked,
      ...outputSelection.picked,
      engine: targetEngine,
      origin_engine: args.origin_engine || 'mcp',
      intent: args.intent || 'generic-delegation',
    },
  };
}

// Public generic delegation wrapper over the existing bounded runner helpers.
export async function runDelegateAgent(args = {}, options = {}) {
  const normalized = normalizeDelegateArgs(args);
  if (normalized.targetEngine !== 'codex' && normalized.targetEngine !== 'claude') {
    return denyDelegateRequest(normalized.targetEngine, 'target_engine must be codex or claude');
  }
  if (normalized.error) return denyDelegateRequest(normalized.targetEngine, normalized.error.message);
  if (normalized.targetEngine === 'codex') {
    return runCodexAgent(normalized.args, options);
  }
  return runClaudeAgent(normalized.args, options);
}
