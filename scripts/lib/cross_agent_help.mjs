import { runProcess, DEFAULTS, truncateUtf8 } from './agent_runner_common.mjs';

// Collects local CLI availability without launching an agent run.
async function inspectCommand(command, spawnImpl) {
  const capturedAt = new Date().toISOString();
  const locationResult = await runProcess('which', [command], {
    timeoutMs: DEFAULTS.help_timeout_ms,
    maxOutputBytes: 2000,
    spawnImpl,
  });
  const versionResult = await runProcess(command, ['--version'], {
    timeoutMs: DEFAULTS.help_timeout_ms,
    maxOutputBytes: DEFAULTS.help_max_bytes,
    spawnImpl,
  });
  const available = versionResult.code === 0;
  let helpStatus = available ? 'not_checked' : 'unavailable';
  let source = available ? 'local-version' : 'static-default';

  if (available) {
    const helpResult = await runProcess(command, ['--help'], {
      timeoutMs: DEFAULTS.help_timeout_ms,
      maxOutputBytes: DEFAULTS.help_max_bytes,
      spawnImpl,
    });
    if (helpResult.code === 0 && helpResult.stdout) {
      source = 'local-help';
      helpStatus = 'available';
    } else {
      helpStatus = helpResult.timedOut ? 'timeout' : 'unavailable';
    }
  }

  return {
    available,
    version: truncateUtf8(versionResult.stdout || versionResult.stderr || '', 2000).text.trim() || null,
    source,
    captured_at: capturedAt,
    command_path: truncateUtf8(locationResult.stdout || '', 2000).text.trim() || null,
    cli_version: truncateUtf8(versionResult.stdout || '', 2000).text.trim() || null,
    stale: false,
    unknown: !available,
    help_status: helpStatus,
    raw_help_text: 'not-returned',
  };
}

// Builds passive help for Codex/Claude runner capabilities and defaults.
export async function getCrossAgentHelp(args = {}, options = {}) {
  const spawnImpl = options.spawnImpl;
  const [codex, claude] = await Promise.all([
    inspectCommand(args.codexCommand || 'codex', spawnImpl),
    inspectCommand(args.claudeCommand || 'claude', spawnImpl),
  ]);

  return {
    tools: [
      {
        name: 'qe_run_codex_agent',
        side_effects: 'May launch local Codex and perform workspace reads; writes require allow_writes=true.',
        auth: 'Uses the existing local Codex CLI/session auth only.',
        timeout: `Default ${DEFAULTS.timeout_ms} ms, caller bounded by timeout_ms/timeoutMs.`,
        output_cap: `Default ${DEFAULTS.max_output_bytes} bytes, caller bounded by max_output_bytes/outputCap.`,
        recursion: 'Nested cross-agent delegation is denied by default.',
      },
      {
        name: 'qe_run_claude_agent',
        side_effects: 'May launch local Claude and perform workspace reads; writes require allow_writes=true.',
        auth: 'Uses the existing local Claude CLI/session auth only.',
        timeout: `Default ${DEFAULTS.timeout_ms} ms, caller bounded by timeout_ms/timeoutMs.`,
        output_cap: `Default ${DEFAULTS.max_output_bytes} bytes, caller bounded by max_output_bytes/outputCap.`,
        recursion: 'Nested cross-agent delegation is denied by default.',
      },
      {
        name: 'qe_cross_agent_help',
        side_effects: 'Passive help only; never launches agent runners.',
        auth: 'No provider auth is required beyond checking local CLI availability.',
        timeout: `CLI inspection probes are capped at ${DEFAULTS.help_timeout_ms} ms.`,
        output_cap: `Help summaries are capped at ${DEFAULTS.help_max_bytes} bytes.`,
        recursion: 'Safe in planning flows because it does not invoke agents.',
      },
    ],
    defaults: {
      allow_writes: false,
      codex_sandbox_mode: 'read-only',
      claude_permission_mode: 'plan',
      max_output_bytes: DEFAULTS.max_output_bytes,
      timeout_ms: DEFAULTS.timeout_ms,
      help_timeout_ms: DEFAULTS.help_timeout_ms,
      help_max_bytes: DEFAULTS.help_max_bytes,
      freshness_window: `${DEFAULTS.help_freshness_hours}h`,
    },
    engines: { codex, claude },
    safety: {
      inherited_mcp_config: false,
      self_recursive_runner_tools: 'denied-by-default',
      raw_help_text: 'not-returned',
    },
  };
}

// Compatibility alias for callers that use build-style helper naming.
export async function buildCrossAgentHelp(args = {}, options = {}) {
  return getCrossAgentHelp(args, options);
}
