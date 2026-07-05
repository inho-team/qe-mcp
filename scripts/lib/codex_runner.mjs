import { normalizeRequest, runAgentCommand } from './agent_runner_common.mjs';
import {
  createDelegationRun,
  decorateDelegationResult,
  makeDelegationDeniedError,
  transitionDelegationRun,
} from './agent_engine_delegation.mjs';

async function transitionSafely(run, status, details = {}) {
  try {
    return await transitionDelegationRun(run, status, details);
  } catch (error) {
    return {
      lifecycle_warning: {
        category: error.category || 'lifecycle_transition_failed',
        message: error.message,
      },
    };
  }
}

function withLifecycleWarning(result, transition) {
  if (!transition?.lifecycle_warning) return result;
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      lifecycle_warning: transition.lifecycle_warning,
    },
  };
}

// Runs Codex CLI through the bounded QE runner contract.
export async function runCodexAgent(args = {}, options = {}) {
  let run = null;
  try {
    const request = normalizeRequest(args, 'codex');
    run = await createDelegationRun({
      request,
      targetEngine: 'codex',
      command: options.command || 'codex',
      options,
    });
    if (!run.decision.accepted) {
      throw makeDelegationDeniedError(run.decision);
    }
    const startedTransition = await transitionSafely(run, 'started', { reason: 'launching codex bounded runner' });
    const delegatedRequest = { ...request, prompt: run.envelope.prompt };
    const commandArgs = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-C', request.cwd];
    commandArgs.push('--sandbox', request.allow_writes ? request.sandbox_mode : 'read-only');
    if (request.output_mode === 'jsonl' || request.output_mode === 'stream-json') commandArgs.push('--json');
    if (request.model) commandArgs.push('--model', request.model);
    commandArgs.push(delegatedRequest.prompt);
    const result = await runAgentCommand({
      engine: 'codex',
      request: delegatedRequest,
      command: options.command || 'codex',
      args: commandArgs,
      outputMode: request.output_mode === 'text' ? 'text' : 'jsonl',
      spawnImpl: options.spawnImpl,
    });
    const decorated = withLifecycleWarning(decorateDelegationResult(result, run), startedTransition);
    const completedTransition = await transitionSafely(run, decorated.status === 'ok' ? 'completed' : decorated.status === 'timeout' ? 'timeout' : 'failed', {
      result: decorated,
    });
    return withLifecycleWarning(decorated, completedTransition);
  } catch (error) {
    const request = { cwd: args.cwd, call_depth: args.call_depth || 0, call_chain_id: args.call_chain_id || '', origin_engine: args.origin_engine || 'unknown', max_output_bytes: args.max_output_bytes };
    const { makeAgentRunResult } = await import('./agent_runner_common.mjs');
    const result = makeAgentRunResult({
      engine: 'codex',
      request,
      status: 'error',
      summary: error.message,
      error,
    });
    if (run?.decision?.accepted) {
      const failedTransition = await transitionSafely(run, 'failed', { reason: error.message, result });
      return withLifecycleWarning(decorateDelegationResult(result, run), failedTransition);
    }
    return run ? decorateDelegationResult(result, run) : result;
  }
}
