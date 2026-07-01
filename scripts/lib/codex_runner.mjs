import { normalizeRequest, runAgentCommand } from './agent_runner_common.mjs';

// Runs Codex CLI through the bounded QE runner contract.
export async function runCodexAgent(args = {}, options = {}) {
  try {
    const request = normalizeRequest(args, 'codex');
    const commandArgs = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-C', request.cwd];
    commandArgs.push('--sandbox', request.allow_writes ? request.sandbox_mode : 'read-only');
    if (request.output_mode === 'jsonl' || request.output_mode === 'stream-json') commandArgs.push('--json');
    if (request.model) commandArgs.push('--model', request.model);
    commandArgs.push(request.prompt);
    return await runAgentCommand({
      engine: 'codex',
      request,
      command: options.command || 'codex',
      args: commandArgs,
      outputMode: request.output_mode === 'text' ? 'text' : 'jsonl',
      spawnImpl: options.spawnImpl,
    });
  } catch (error) {
    const request = { cwd: args.cwd, call_depth: args.call_depth || 0, call_chain_id: args.call_chain_id || '', origin_engine: args.origin_engine || 'unknown', max_output_bytes: args.max_output_bytes };
    const { makeAgentRunResult } = await import('./agent_runner_common.mjs');
    return makeAgentRunResult({
      engine: 'codex',
      request,
      status: 'error',
      summary: error.message,
      error,
    });
  }
}
