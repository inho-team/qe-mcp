# qe-mcp

Standalone MCP server for QE Framework expert-library guidance.

This repository holds the large optional expert corpus outside
`@inho-team/qe-framework` so framework installs stay small. The server exposes
compact search and recommendation by default, then returns full expert content
only after an explicit MCP tool or prompt call.

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
`qe_run_claude_agent`, and `qe_cross_agent_help`.

## Tools

- `qe_search_experts`: compact metadata search
- `qe_recommend_expert`: task-based expert recommendation
- `qe_read_expert`: explicit bounded expert read
- `qe_read_methodology`: explicit bounded methodology/reference read
- `qe_expert_prompt`: build a bounded expert prompt payload
- `qe_expert_library_help`: quick server usage summary
- `qe_run_codex_agent`: active local Codex runner with bounded timeout/output and default read-only posture
- `qe_run_claude_agent`: active local Claude runner with bounded timeout/output and default plan/read-only posture
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
`qe_run_codex_agent`, and `qe_run_claude_agent` through the stdio MCP tool path.
Authenticated runners should return `status: "ok"`. Missing local login,
missing CLI installs, provider quota limits, or bounded timeouts are reported as
structured graceful failures instead of raw crashes.

## Trust Boundary

The expert corpus is local passive data. Expert reads do not fetch remote code,
do not auto-trust third-party MCP servers, and do not accept raw filesystem
paths for expert reads. Expert content was migrated from the deleted optional QE
catalog and should be treated as guidance that may need current API
verification before implementation.

The cross-agent runner tools are active execution tools. They launch only local
CLIs with existing local auth, sanitize inherited environment variables, reject
working directories outside this repository, cap timeout/output, and block
nested cross-agent recursion by default. `qe_cross_agent_help` is passive and
does not launch either runner.

Do not use the active runner tools for routine expert-library lookups, untrusted
prompts, broad autonomous edits, or tasks that require inheriting a user's full
MCP configuration. Use the passive expert tools for guidance-only workflows.

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

Write-capable runs require an explicit write policy. Codex requires
`allow_writes: true` plus `sandbox_mode: "workspace-write"`. Unsafe sandbox or
permission modes such as `danger-full-access` and `bypassPermissions` are
rejected. Recursive runner calls are blocked by default with
`recursion_blocked`.

Troubleshooting:

- `auth_missing`: log in to the local provider CLI, then retry the same MCP
  tool call.
- `not_installed`: install the missing local `codex` or `claude` CLI.
- `timeout` or `prompt_stalled`: reduce prompt scope or raise `timeout_ms`
  within the schema maximum.
- `budget_exceeded`: reduce prompt scope or retry after provider quota resets.
- `policy_denied`: check `cwd`, write policy, output cap, recursion depth, and
  MCP config policy.
