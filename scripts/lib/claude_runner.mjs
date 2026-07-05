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

// Runs Claude CLI through the bounded QE runner contract.
export async function runClaudeAgent(args = {}, options = {}) {
  let run = null;
  try {
    const request = normalizeRequest(args, 'claude');
    run = await createDelegationRun({
      request,
      targetEngine: 'claude',
      command: options.command || 'claude',
      options,
    });
    if (!run.decision.accepted) {
      throw makeDelegationDeniedError(run.decision);
    }
    const startedTransition = await transitionSafely(run, 'started', { reason: 'launching claude bounded runner' });
    const delegatedRequest = { ...request, prompt: run.envelope.prompt };
    const outputFormat = request.output_mode === 'stream-json' ? 'stream-json' : 'json';
    const commandArgs = [
      '-p',
      delegatedRequest.prompt,
      '--strict-mcp-config',
      '--output-format',
      outputFormat,
      '--permission-mode',
      'plan',
      '--no-session-persistence',
      '--tools',
      '',
      '--max-budget-usd',
      String(request.max_budget_usd),
    ];
    if (request.model) commandArgs.push('--model', request.model);
    const result = await runAgentCommand({
      engine: 'claude',
      request: delegatedRequest,
      command: options.command || 'claude',
      args: commandArgs,
      outputMode: outputFormat,
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
      engine: 'claude',
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
