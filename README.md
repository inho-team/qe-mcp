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

The expert corpus is local passive data. The server does not fetch remote code,
does not auto-trust third-party MCP servers, and does not accept raw filesystem
paths for expert reads. Expert content was migrated from the deleted optional QE
catalog and should be treated as guidance that may need current API
verification before implementation.
