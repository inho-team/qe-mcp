#!/usr/bin/env node

import { spawn } from 'child_process';
import { resolve } from 'path';

const serverPath = resolve(process.cwd(), 'scripts', 'qe_mcp_server.mjs');
const ALLOWED_GRACEFUL_ERRORS = new Set(['auth_missing', 'not_installed', 'timeout', 'prompt_stalled', 'budget_exceeded']);

// Encodes a JSON-RPC request for MCP stdio framing.
function encode(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

// Starts qe_mcp_server and exposes a small request/notify client.
function createClient() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const bodyEnd = headerEnd + 4 + Number(match[1]);
      if (buffer.length < bodyEnd) return;
      const body = buffer.slice(headerEnd + 4, bodyEnd).toString('utf8');
      buffer = buffer.slice(bodyEnd);
      const message = JSON.parse(body);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  return {
    request(method, params = {}) {
      const id = nextId++;
      child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
      return new Promise((resolvePromise) => pending.set(id, resolvePromise));
    },
    notify(method, params = {}) {
      child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
    },
    close() {
      child.kill();
    },
  };
}

// Reduces runner payloads to stable smoke-test evidence.
function summarizeRunner(name, response) {
  const result = response.result?.structuredContent;
  if (!result) {
    return { name, status: 'mcp_error', error: response.error || null };
  }
  return {
    name,
    status: result.status,
    summary: result.summary,
    error: result.error || null,
    normalization: result.normalization,
    exit_code: result.metadata?.exit_code ?? null,
    run_id: result.metadata?.lifecycle?.run_id || null,
  };
}

// Accepts local auth/quota failures as graceful smoke results.
function isAcceptableSmoke(summary) {
  if (summary.status === 'ok') return true;
  return summary.status === 'error' && ALLOWED_GRACEFUL_ERRORS.has(summary.error?.category);
}

// Runs passive help plus active runner tool calls through the MCP stdio path.
async function main() {
  const client = createClient();
  try {
    const init = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
    const tools = await client.request('tools/list');
    const toolNames = tools.result?.tools?.map((tool) => tool.name) || [];
    for (const name of [
      'qe_run_codex_agent',
      'qe_run_claude_agent',
      'qe_cross_agent_help',
      'qe_delegate_agent',
      'qe_agent_run_status',
      'qe_agent_run_read',
      'qe_run_openai_compat_agent',
    ]) {
      if (!toolNames.includes(name)) throw new Error(`missing tool: ${name}`);
    }

    // openai-compat is a network-only, env-gated runner: verify its tools/list
    // schema shape and that it fails gracefully (not_installed) with no endpoint
    // configured — no live network call is made.
    const openaiTool = tools.result?.tools?.find((tool) => tool.name === 'qe_run_openai_compat_agent');
    const ocProps = openaiTool?.inputSchema?.properties || {};
    if (ocProps.sandbox_mode || ocProps.permission_mode) {
      throw new Error('qe_run_openai_compat_agent schema must not expose sandbox_mode/permission_mode');
    }
    if (ocProps.timeout_ms?.maximum !== 120000 || ocProps.max_output_bytes?.maximum !== 24000) {
      throw new Error('qe_run_openai_compat_agent schema bounds must be timeout_ms<=120000, max_output_bytes<=24000');
    }
    const openaiCompat = summarizeRunner(
      'qe_run_openai_compat_agent',
      await client.request('tools/call', { name: 'qe_run_openai_compat_agent', arguments: { prompt: 'ping' } })
    );
    if (openaiCompat.status !== 'ok' && !isAcceptableSmoke(openaiCompat)) {
      throw new Error(`qe_run_openai_compat_agent failed ungracefully: ${JSON.stringify(openaiCompat)}`);
    }
    if (!process.env.QE_OPENAI_COMPAT_BASE_URL && openaiCompat.error?.category !== 'not_installed') {
      throw new Error(`unconfigured openai-compat must return not_installed, got ${openaiCompat.error?.category}`);
    }

    const help = await client.request('tools/call', { name: 'qe_cross_agent_help' });
    if (help.result?.structuredContent?.launchesAgentRunners !== false) {
      throw new Error('qe_cross_agent_help is not passive');
    }

    const commonArgs = {
      prompt: 'Return exactly: ok',
      timeout_ms: Number(process.env.QE_MCP_SMOKE_TIMEOUT_MS || 20000),
      max_output_bytes: 4000,
      allow_writes: false,
    };
    const codex = summarizeRunner(
      'qe_run_codex_agent',
      await client.request('tools/call', { name: 'qe_run_codex_agent', arguments: commonArgs })
    );
    const claude = summarizeRunner(
      'qe_run_claude_agent',
      await client.request('tools/call', { name: 'qe_run_claude_agent', arguments: commonArgs })
    );
    const lifecycleRunId =
      codex.status === 'ok'
        ? (await client.request('tools/call', { name: 'qe_agent_run_status', arguments: { run_id: codex.run_id } }))
        : null;
    const summary = {
      server: init.result?.serverInfo,
      help_passive: true,
      public_engine_tools: true,
      status_read: lifecycleRunId ? lifecycleRunId.result?.structuredContent?.status || 'missing' : 'skipped',
      runners: [codex, claude, openaiCompat],
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.runners.every(isAcceptableSmoke)) {
      process.exitCode = 1;
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
