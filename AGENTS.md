# QE MCP

## Project Overview
- **Name**: @inho-team/qe-mcp
- **Description**: Standalone QE expert-library MCP server and CLI sync tooling for Claude, Codex, and Gemini clients.

## Tech Stack
- **Runtime**: Node.js
- **Language**: JavaScript ES modules (`.mjs`)
- **Protocol surface**: stdio MCP server
- **Data corpus**: local Markdown/JSON expert library under `expert-library/`

## Build & Run
```bash
npm run check
npm run selftest
npm run runner:smoke
node scripts/qe_mcp.mjs --help
node scripts/qe_mcp_server.mjs
```

## Project Structure
```text
qe-mcp/
├── scripts/          # CLI, MCP server, tests, and implementation libraries
├── expert-library/   # local expert corpus, indexes, packs, skills, references
├── .qe/              # QE framework state and analysis
├── package.json
└── README.md
```

## Constraints
- Treat this repository as independent from `qe-framework`; do not copy `qe-mcp` assets back into `qe-framework` package payloads.
- Prefer running commands from this repo root, not the workspace wrapper.
- Active runner tools launch local CLIs only through bounded policy surfaces.
- Do not widen runner permissions, inherited MCP config, output caps, or recursion behavior without explicit design review.
- Follow existing ES module style and keep shell execution paths bounded and non-destructive by default.
- See `QE_CONVENTIONS.md` for QE workflow rules, task status, and completion criteria.

## QE Toolkit
- **Planning**: `Qplan`
- **Spec generation**: `Qgs`
- **Execution**: `Qatomic-run`
- **Verification**: `Qcode-run-task`
- **Project state**: `.qe/TASK_LOG.md`

## Task Log
- **작업 이력 및 상태**: `.qe/TASK_LOG.md` 참조
