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
```

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
