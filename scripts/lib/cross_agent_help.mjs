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
  const codex = await inspectCommand(args.codexCommand || 'codex', spawnImpl);
  const claude = await inspectCommand(args.claudeCommand || 'claude', spawnImpl);

  return {
    tools: [
      {
        name: 'qe_run_codex_agent',
        side_effects: 'May launch local Codex and perform workspace reads; writes require allow_writes=true.',
        auth: 'Uses the existing local Codex CLI/session auth only.',
        timeout: `Default ${DEFAULTS.timeout_ms} ms, caller bounded by timeout_ms/timeoutMs.`,
        output_cap: `Default ${DEFAULTS.max_output_bytes} bytes, caller bounded by max_output_bytes/outputCap.`,
        config_mode: 'Default codex_config_mode=isolated ignores user config/rules; opt-in native loads the target Codex user configuration.',
        recursion: 'Nested cross-agent delegation is denied by default.',
      },
      {
        name: 'qe_run_claude_agent',
        side_effects: 'May launch local Claude in fixed plan mode and perform workspace reads.',
        auth: 'Uses the existing local Claude CLI/session auth only.',
        timeout: `Default ${DEFAULTS.timeout_ms} ms, caller bounded by timeout_ms/timeoutMs.`,
        output_cap: `Default ${DEFAULTS.max_output_bytes} bytes, caller bounded by max_output_bytes/outputCap.`,
        recursion: 'Nested cross-agent delegation is denied by default.',
      },
      {
        name: 'qe_delegate_agent',
        side_effects: 'May launch one bounded local target engine selected by target_engine=codex|claude.',
        auth: 'Uses the existing local target CLI/session auth only.',
        timeout: `Default ${DEFAULTS.timeout_ms} ms, caller bounded by timeout_ms/timeoutMs.`,
        output_cap: `Default ${DEFAULTS.max_output_bytes} bytes, caller bounded by max_output_bytes/outputCap.`,
        recursion: 'Nested cross-agent delegation is denied by default.',
      },
      {
        name: 'qe_agent_run_status',
        side_effects: 'Read-only lifecycle status projection by run_id; never launches an agent.',
        auth: 'No provider auth is required.',
        timeout: 'Immediate local state read.',
        output_cap: 'Compact status metadata only.',
        recursion: 'Safe in planning flows because it does not invoke agents.',
      },
      {
        name: 'qe_agent_run_read',
        side_effects: 'Read-only bounded lifecycle/result projection by run_id; never reads arbitrary paths.',
        auth: 'No provider auth is required.',
        timeout: 'Immediate local state read.',
        output_cap: 'Bounded redacted lifecycle metadata only.',
        recursion: 'Safe in planning flows because it does not invoke agents.',
      },
      {
        name: 'qe_cross_agent_help',
        side_effects: 'Passive help only; never launches agent runners.',
        auth: 'No provider auth is required beyond checking local CLI availability.',
        timeout: `CLI inspection probes are capped at ${DEFAULTS.help_timeout_ms} ms.`,
        output_cap: `Help summaries are capped at ${DEFAULTS.help_max_bytes} bytes.`,
        recursion: 'Safe in planning flows because it does not invoke agents.',
      },
      {
        name: 'qe_run_openai_compat_agent',
        side_effects: 'Experiment-only, env-gated standalone network runner. Makes a single chat completion call to the configured OpenAI-compatible endpoint. Returns not_installed when QE_OPENAI_COMPAT_BASE_URL is unset. NOT a delegate target.',
        auth: 'Auth via env-only QE_OPENAI_COMPAT_API_KEY; key is never logged or returned. Passing a key in args is refused (policy_denied).',
        timeout: `Bounded by timeout_ms; default 60000 ms, max 120000 ms.`,
        output_cap: `Bounded by max_output_bytes; default 24000 bytes, max 24000 bytes.`,
        recursion: 'Standalone runner only. Not routable via qe_delegate_agent. Do not invoke from nested agent tasks.',
      },
    ],
    defaults: {
      allow_writes: false,
      codex_sandbox_mode: 'read-only',
      codex_config_mode: 'isolated',
      claude_permission_mode: 'plan',
      max_output_bytes: DEFAULTS.max_output_bytes,
      timeout_ms: DEFAULTS.timeout_ms,
      help_timeout_ms: DEFAULTS.help_timeout_ms,
      help_max_bytes: DEFAULTS.help_max_bytes,
      freshness_window: `${DEFAULTS.help_freshness_hours}h`,
    },
    engines: { codex, claude },
    safety: {
      inherited_mcp_config: 'isolated codex mode: false; codex native mode: target Codex user configuration may load configured MCP servers',
      self_recursive_runner_tools: 'denied-by-default',
      current_surface: 'phase-3-public-engine-surface',
      generic_public_surface: 'qe_delegate_agent targets codex or claude through the bounded engine contract.',
      lifecycle_read_surface: 'qe_agent_run_status and qe_agent_run_read return redacted run_id-based projections.',
      raw_help_text: 'not-returned',
    },
    delegation_engine: {
      public_tools: ['qe_delegate_agent', 'qe_run_codex_agent', 'qe_run_claude_agent', 'qe_run_openai_compat_agent'],
      compatibility_wrappers: ['qe_run_codex_agent', 'qe_run_claude_agent', 'qe_run_openai_compat_agent'],
      lifecycle_tools: ['qe_agent_run_status', 'qe_agent_run_read'],
      internal_route: true,
      public_route: true,
      generic_public_tool: 'qe_delegate_agent',
      generic_public_tool_status: 'phase-3-public',
      semantics: {
        direction: 'Every route has an explicit origin and target engine.',
        capability: 'Target capability is checked before subprocess launch.',
        lifecycle: 'Runs move through accepted/denied/started/completed/timeout/failed states.',
        prompt_envelope: 'Delegated prompts are wrapped in a standard engine envelope before CLI execution.',
      },
      lifecycle_projection: {
        read_key: 'run_id',
        allowed_namespace: '.qe/state/agent-runs/',
        returns: ['direction', 'decision', 'status', 'timestamps', 'transitions', 'compact_output_metadata'],
        redacts: ['raw_prompt', 'raw_stdout', 'raw_stderr', 'secret_like_environment_values'],
      },
      trust_boundary: {
        local_cli_auth_only: true,
        inherited_mcp_config: 'false by default; codex_config_mode=native is explicit opt-in to target Codex user configuration',
        writes_default: false,
        concurrent_fanout: false,
        multi_turn_continuation: false,
      },
    },
  };
}

// Compatibility alias for callers that use build-style helper naming.
export async function buildCrossAgentHelp(args = {}, options = {}) {
  return getCrossAgentHelp(args, options);
}
