# qe-mcp

Standalone MCP server for QE Framework expert-library guidance.

This repository holds the large optional expert corpus outside
`@inho-team/qe-framework` so framework installs stay small. The server exposes
compact search and recommendation by default, then returns full expert content
only after an explicit MCP tool or prompt call.

## Migrating 0.3 → 0.4

0.4.0 exposes `qe_run_openai_compat_agent` as an experiment-only, env-gated
standalone runner for OpenAI-compatible endpoints. It is not a `qe_delegate_agent`
target and does not change the frozen CLI delegation contract (`claude`, `codex`).

- Configure it with `QE_OPENAI_COMPAT_BASE_URL`, `QE_OPENAI_COMPAT_API_KEY`, and
  `QE_OPENAI_COMPAT_MODEL`.
- API keys are env-only. Passing key-like fields in tool arguments is rejected.
- If `QE_OPENAI_COMPAT_BASE_URL` is unset, the tool returns structured
  `not_installed` without making a network call.

## Migrating 0.2 → 0.3 (breaking)

0.3.0 splits the expert library into a shipped **core** pack (25 experts) and an
optional **extra** pack (`@inho-team/qe-experts-extra`, 61 experts). By default
`qe-mcp` now loads only the core-25 — the install payload dropped to ~1.55 MB.

- To restore the full expert set, install the extra pack:
  `qe-mcp packs install extra-experts` (deploys to `~/.qe/mcp/packs/extra-experts/`,
  auto-detected), or point `QE_EXTRA_EXPERTS_ROOT` at a checkout.
- The MCP surface was also slimmed to 10 tools in earlier 0.2.x work; `qe_read_expert`
  now takes `format` and `section` params (the old `qe_expert_prompt` tool is gone).
- Check installed packs with `qe-mcp packs status`.

## Install

```bash
npm install -g @inho-team/qe-mcp
```

`qe-mcp` is the MCP companion for `qe-framework`. Install the framework plugin
first, then connect this MCP package to the clients you use:

```bash
# 1. Install the QE Framework Claude/Codex plugin
claude plugin marketplace add inho-team/qe-framework
claude plugin install qe-framework@inho-team-qe-framework

# 2. Install the companion MCP package
npm install -g @inho-team/qe-mcp

# 3. Register the MCP server for local AI clients
qe-mcp init-registry
qe-mcp sync --client claude
qe-mcp sync --client codex
```

Run `qe-mcp sync --dry-run --client claude` or
`qe-mcp sync --dry-run --client codex` first if you want to inspect the config
file writes before applying them.

For local development:

```bash
git clone https://github.com/inho-team/qe-mcp.git
cd qe-mcp
npm run selftest
```

## MCP Server

Direct stdio launch:

```bash
qe-mcp-server
```

Local source launch:

```bash
node scripts/qe_mcp_server.mjs
```

## Registry Sync

Initialize a local registry:

```bash
qe-mcp init-registry
```

Preview client config writes:

```bash
qe-mcp sync --dry-run --client codex
```

Apply:

```bash
qe-mcp sync --client codex
qe-mcp sync --client claude
qe-mcp sync --client gemini
```

The default registry writes a `qeExpertLibrary` MCP server entry pointing at
this package's `scripts/qe_mcp_server.mjs`.

`qe-framework` and `qe-mcp` are intended to run as twins:

- `qe-framework` installs the workflow skills, agents, hooks, and Codex assets.
- `qe-mcp` installs the external expert-library MCP server and cross-agent
  runner tools.
- Without `qe-mcp`, the core QE workflows still load, but expert-library MCP
  calls and cross-agent runner tools are unavailable.

Maintainers may also connect the separate admin MCP package,
`qe-admin-mcp`, for release, bump, skill-test, audit, and migration workflows.
That admin MCP is not required for normal framework usage.

## Local Setup Check

After installing and syncing, restart Claude Code or Codex, then verify:

```bash
qe-mcp doctor
qe-mcp-server
```

In the client, the MCP tool list should include `qeExpertLibrary` tools such as
`qe_search_experts`, `qe_read_expert`, `qe_run_codex_agent`,
`qe_run_claude_agent`, `qe_delegate_agent`, `qe_agent_run_status`,
`qe_agent_run_read`, `qe_run_openai_compat_agent`, and `qe_cross_agent_help`.

## Tools

- `qe_search_experts`: compact metadata search
- `qe_recommend_expert`: task-based expert recommendation
- `qe_read_expert`: explicit bounded expert read
- `qe_read_methodology`: explicit bounded methodology/reference read
- `qe_run_codex_agent`: bounded local Codex CLI runner with capped timeout/output and default read-only posture
- `qe_run_claude_agent`: bounded local Claude CLI runner with capped timeout/output and fixed plan-mode posture
- `qe_delegate_agent`: generic bounded local delegation tool for `target_engine: "codex"` or `"claude"`
- `qe_agent_run_status`: read a compact lifecycle status projection by `run_id`
- `qe_agent_run_read`: read a bounded, redacted lifecycle/result projection by `run_id`
- `qe_run_openai_compat_agent`: experiment-only OpenAI-compatible endpoint runner, env-gated and standalone
- `qe_cross_agent_help`: passive local runner contract and CLI capability summary

## Resources

- `qe://experts/catalog`
- `qe://experts/<name>`
- `qe://experts/<name>/references`
- `qe://expert-packs/<pack>`

## Prompts

- `qe-use-expert`
- `qe-review-with-expert`
- `qe-plan-with-expert`

## Verification

```bash
npm run check
npm run selftest
npm run runner:smoke
```

`runner:smoke` launches the local MCP server and calls `qe_cross_agent_help`,
`qe_run_codex_agent`, `qe_run_claude_agent`, and `qe_run_openai_compat_agent`
through the stdio MCP tool path. Authenticated local CLI runners should return
`status: "ok"`. The openai-compat runner returns structured `not_installed`
when no endpoint is configured. Missing local login, missing CLI installs,
provider quota limits, or bounded timeouts are reported as structured graceful
failures instead of raw crashes.

## Trust Boundary

The expert corpus is local passive data. Expert reads do not fetch remote code,
do not auto-trust third-party MCP servers, and do not accept raw filesystem
paths for expert reads. Expert content was migrated from the deleted optional QE
catalog and should be treated as guidance that may need current API
verification before implementation.

The cross-agent runner tools are active execution tools, but the public surface
is still a bounded local delegation contract rather than a full autonomous
multi-turn engine. The Phase 3 surface exposes `qe_delegate_agent` as the generic
engine entry point for `target_engine: "codex"` or `"claude"`. It records
delegation direction, checks target capability before launch, tracks lifecycle
state, and builds a standard prompt envelope for the CLI subprocess.

`qe_run_codex_agent` and `qe_run_claude_agent` remain public compatibility
wrappers for callers that already use the engine-specific tool names. They
should route through the same bounded engine contract as `qe_delegate_agent`;
they are not separate permission surfaces.

Codex runner calls default to `codex_config_mode: "isolated"`, which launches
Codex with `--ignore-user-config --ignore-rules` so child runs do not inherit
the caller's full `~/.codex/config.toml`. When a workflow explicitly needs
Codex native agents, skills, and rules, opt in with
`codex_config_mode: "native"`. Native mode still keeps the QE runner caps
around cwd, timeout, output, sandbox, and recursion, but it allows Codex to
load the user's normal Codex configuration. That can include native Codex
agents, skills, rules, hooks, and MCP servers already configured for that
Codex installation.

`qe_agent_run_status` and `qe_agent_run_read` are bounded lifecycle inspection
APIs. They accept a `run_id`, read only the QE-managed lifecycle namespace, and
return compact projections such as direction, decision, timestamps, status,
transition metadata, and output sizes. They must not return raw full prompt,
raw stdout, raw stderr, secret-like environment values, or arbitrary filesystem
paths.

Runner tools launch only local CLIs with existing local auth, sanitize inherited
environment variables, reject working directories outside this repository, cap
timeout/output, and block nested cross-agent recursion by default. Isolated
Codex mode rejects child config inheritance by passing `--ignore-user-config`
and `--ignore-rules`; native Codex mode is explicit opt-in for workflows that
need the user's configured Codex agents, skills, rules, hooks, or MCP servers.
`qe_cross_agent_help` is passive and does not launch either runner or read
lifecycle records.

Use passive expert tools for guidance-only workflows and routine expert-library
lookups. Use `qe_run_codex_agent` or `qe_run_claude_agent` when an existing
integration needs the legacy engine-specific wrapper. Use `qe_delegate_agent`
when a caller wants the engine-level contract and explicit target selection.
Use `qe_agent_run_status` or `qe_agent_run_read` after delegation when a caller
needs bounded lifecycle inspection without raw capture exposure.

`qe_run_openai_compat_agent` is separate from delegation. It makes one bounded
network call to the configured OpenAI-compatible endpoint and is disabled by
default. It never accepts API keys through tool arguments.

Do not use the active runner tools for untrusted prompts, broad autonomous
edits, or tasks that require inheriting a user's full MCP configuration.

The QE maintenance tools are explicit orchestration/status surfaces, not a
scheduler. They never install timers, background daemons, or hidden recurring
jobs inside the stdio MCP server. Time-based execution belongs to an external
scheduler such as Qcron, launchd, cron, or CI. Maintenance `run-once` is limited
to predefined read-only/report-only jobs and narrowly approved recoverable-write
jobs.

Recoverable-write candidates (`qrefresh`, `qarchive`, `qsweep`) require an
explicit preview-bound approval flow:

1. Call `qe_run_maintenance_job` with `mode: "dry-run"`.
2. Inspect `changed_paths_preview`, `recovery_strategy`, and
   `approval_fingerprint`.
3. Call `qe_run_maintenance_job` with `mode: "run-once"`,
   `confirm_recoverable_write: true`, and the matching
   `approval_fingerprint`.
4. Inspect `changed_paths`, `recovery_manifest`, status, and logs.

The approval fingerprint is bound to `job_id`, `mode`, `workspace_root`,
`changed_paths_preview`, and `permission_profile`; mismatches fail closed with
`policy_denied`. Recoverable-write execution is restricted to `.qe/state`
maintenance paths and still denies source writes, config writes, secrets/env
access, runner delegation, recursion, and internal scheduling.

The QE supervisor tools are also status/control surfaces, not a resident
scheduler. They read `.qe/state/supervisor` or optional `~/.qe/daemon` state,
return bounded event/status/spec projections, and allow only explicit ack state
writes. CLI install is dry-run only in this phase:

```bash
qe-mcp supervisor status --json
qe-mcp supervisor events --json
qe-mcp supervisor specs --json
qe-mcp supervisor install --dry-run --json
```

`qe-mcp supervisor install` without `--dry-run` fails closed and does not write
service files, launch agents, cron entries, or start daemons.

## Active Runner Examples

Use `qe_cross_agent_help` first when deciding whether local Codex or Claude is
available. It is passive and does not launch either runner.

Minimal Codex runner call:

```json
{
  "name": "qe_run_codex_agent",
  "arguments": {
    "prompt": "Summarize the current repository constraints.",
    "timeout_ms": 60000,
    "max_output_bytes": 24000,
    "allow_writes": false
  }
}
```

Codex native-config runner call:

```json
{
  "name": "qe_run_codex_agent",
  "arguments": {
    "prompt": "Use the registered Ecode-reviewer agent to review the current diff.",
    "codex_config_mode": "native",
    "timeout_ms": 60000,
    "max_output_bytes": 24000,
    "allow_writes": false
  }
}
```

Minimal Claude runner call:

```json
{
  "name": "qe_run_claude_agent",
  "arguments": {
    "prompt": "Review the runner policy boundary.",
    "permission_mode": "plan",
    "timeout_ms": 60000,
    "max_output_bytes": 24000,
    "allow_writes": false
  }
}
```

Minimal generic delegation call:

```json
{
  "name": "qe_delegate_agent",
  "arguments": {
    "target_engine": "codex",
    "intent": "inspect-repository-constraints",
    "prompt": "Summarize the current repository constraints.",
    "timeout_ms": 60000,
    "max_output_bytes": 24000,
    "policy": {
      "allow_writes": false,
      "mcp_policy": "none",
      "max_concurrent_runs": 1
    },
    "output_contract": {
      "output_mode": "jsonl",
      "max_output_bytes": 24000
    }
  }
}
```

Minimal lifecycle status/read calls:

```json
{
  "name": "qe_agent_run_status",
  "arguments": {
    "run_id": "example-run-id"
  }
}
```

```json
{
  "name": "qe_agent_run_read",
  "arguments": {
    "run_id": "example-run-id",
    "include_transitions": true
  }
}
```

Write-capable runs require an explicit write policy. Codex requires
`allow_writes: true` plus `sandbox_mode: "workspace-write"`. Unsafe sandbox or
permission modes such as `danger-full-access` and `bypassPermissions` are
rejected. Recursive runner calls are blocked by default with
`recursion_blocked`.

Compatibility and policy notes:

- `prompt` is the canonical input field. The legacy `task` alias is still
  accepted by the legacy runner wrappers. `qe_delegate_agent` uses `prompt` as
  its canonical input so new callers do not depend on wrapper aliases.
- Existing bounded runner tools are compatibility wrappers over the public
  delegation engine route. Help may expose engine metadata and lifecycle read
  boundaries, but it must not imply unrestricted swarms or multi-turn
  continuation.
- Delegation direction, target capabilities, lifecycle state, and prompt
  envelope construction are internal semantics used to make the bounded runner
  behavior inspectable and consistent.
- `qe_agent_run_status` and `qe_agent_run_read` are read-only projections over
  QE lifecycle records, not arbitrary file readers.
- Claude runner execution currently supports only `permission_mode: "plan"`;
  other permission modes fail closed instead of being accepted and ignored.
- `mcp_policy` currently supports only `"none"` because child MCP config
  inheritance is outside this trust boundary.
- `max_concurrent_runs` is capped at `1` per server process.

Troubleshooting:

- `auth_missing`: log in to the local provider CLI, then retry the same MCP
  tool call.
- `not_installed`: install the missing local `codex` or `claude` CLI.
- `timeout` or `prompt_stalled`: reduce prompt scope or raise `timeout_ms`
  within the schema maximum.
- `budget_exceeded`: reduce prompt scope or retry after provider quota resets.
- `policy_denied`: check `cwd`, write policy, output cap, recursion depth, and
  MCP config policy.
