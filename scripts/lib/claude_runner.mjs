import { normalizeRequest, runAgentCommand } from './agent_runner_common.mjs';

// Runs Claude CLI through the bounded QE runner contract.
export async function runClaudeAgent(args = {}, options = {}) {
  try {
    const request = normalizeRequest(args, 'claude');
    const outputFormat = request.output_mode === 'stream-json' ? 'stream-json' : 'json';
    const commandArgs = [
      '-p',
      request.prompt,
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
    return await runAgentCommand({
      engine: 'claude',
      request,
      command: options.command || 'claude',
      args: commandArgs,
      outputMode: outputFormat,
      spawnImpl: options.spawnImpl,
    });
  } catch (error) {
    const request = { cwd: args.cwd, call_depth: args.call_depth || 0, call_chain_id: args.call_chain_id || '', origin_engine: args.origin_engine || 'unknown', max_output_bytes: args.max_output_bytes };
    const { makeAgentRunResult } = await import('./agent_runner_common.mjs');
    return makeAgentRunResult({
      engine: 'claude',
      request,
      status: 'error',
      summary: error.message,
      error,
    });
  }
}
