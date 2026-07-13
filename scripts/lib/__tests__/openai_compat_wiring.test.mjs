import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildToolSchemas, RUNNER_ENGINES } from '../agent_runner_contract.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(MODULE_DIR, '..', '..', 'qe_mcp_server.mjs');

function encode(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function createMcpClient(env = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: resolve(MODULE_DIR, '..', '..', '..'),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
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
      const message = JSON.parse(buffer.slice(headerEnd + 4, bodyEnd).toString('utf8'));
      buffer = buffer.slice(bodyEnd);
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

async function withMcpClient(env, fn) {
  const client = createMcpClient(env);
  try {
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
    return await fn(client);
  } finally {
    client.close();
  }
}

async function withDelayedOpenAiCompatEndpoint(fn) {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }, 200);
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

// Verifies the qe_run_openai_compat_agent MCP schema wiring (P7 W2 / D014).
// The server (qe_mcp_server.mjs) is a stdio script; these tests target the
// importable schema source (buildToolSchemas) plus the frozen delegation
// contract. Live tools/list/dispatch is covered by smoke_qe_mcp_runner_tools.mjs.

test('buildToolSchemas exposes openai-compat under both the short key and the tool key', () => {
  const schemas = buildToolSchemas();
  assert.ok(schemas.openaiCompat, 'short key openaiCompat missing');
  assert.ok(schemas.qe_run_openai_compat_agent, 'tool key qe_run_openai_compat_agent missing');
  // Dual-key must reference the same schema object (mirrors codex/claude).
  assert.equal(schemas.openaiCompat, schemas.qe_run_openai_compat_agent);
});

test('openai-compat schema is network-only: no sandbox_mode / permission_mode / cwd', () => {
  const props = buildToolSchemas().qe_run_openai_compat_agent.properties;
  for (const forbidden of ['sandbox_mode', 'permission_mode', 'cwd', 'allow_writes']) {
    assert.equal(props[forbidden], undefined, `network runner schema must not expose ${forbidden}`);
  }
  assert.deepEqual(Object.keys(props).sort(), ['max_output_bytes', 'model', 'prompt', 'task', 'timeout_ms']);
});

test('openai-compat schema bounds match the runner clamps, not the CLI commonProperties', () => {
  const props = buildToolSchemas().qe_run_openai_compat_agent.properties;
  // Runner clamps to 120000 / 24000; must NOT inherit the CLI 600000 / 1000000 bounds.
  assert.equal(props.timeout_ms.maximum, 120000);
  assert.notEqual(props.timeout_ms.maximum, 600000);
  assert.equal(props.max_output_bytes.maximum, 24000);
  assert.notEqual(props.max_output_bytes.maximum, 1000000);
});

test('openai-compat is NOT added to the frozen CLI delegate contract', () => {
  // It is a standalone network runner, never a delegate target.
  assert.deepEqual([...RUNNER_ENGINES], ['claude', 'codex']);
  assert.equal(RUNNER_ENGINES.includes('openai-compat'), false);
});

test('MCP server exposes openai-compat in tools/list with the network-only schema', async () => {
  await withMcpClient({ QE_MCP_EXPOSE_RUNNERS: '1' }, async (client) => {
    const tools = await client.request('tools/list');
    const tool = tools.result.tools.find((candidate) => candidate.name === 'qe_run_openai_compat_agent');
    assert.ok(tool, 'qe_run_openai_compat_agent missing from tools/list');
    const props = tool.inputSchema.properties;
    assert.equal(props.sandbox_mode, undefined);
    assert.equal(props.permission_mode, undefined);
    assert.equal(props.timeout_ms.maximum, 120000);
    assert.equal(props.max_output_bytes.maximum, 24000);
  });
});

test('MCP server dispatch returns structured not_installed when endpoint env is unset', async () => {
  await withMcpClient(
    {
      QE_MCP_EXPOSE_RUNNERS: '1',
      QE_OPENAI_COMPAT_BASE_URL: '',
      QE_OPENAI_COMPAT_API_KEY: '',
      QE_OPENAI_COMPAT_MODEL: '',
    },
    async (client) => {
    const response = await client.request('tools/call', {
      name: 'qe_run_openai_compat_agent',
      arguments: { prompt: 'ping' },
    });
    const result = response.result.structuredContent;
    assert.equal(result.engine, 'openai-compat');
    assert.equal(result.status, 'error');
    assert.equal(result.error.category, 'not_installed');
    assert.deepEqual(result.events, []);
    assert.equal(result.normalization.output_format, 'text');
    }
  );
});

test('MCP server preserves openai-compat engine on success and active-runner limit', async () => {
  await withDelayedOpenAiCompatEndpoint(async (baseUrl) => {
    await withMcpClient(
      {
        QE_OPENAI_COMPAT_BASE_URL: baseUrl,
        QE_OPENAI_COMPAT_API_KEY: 'TEST_KEY',
        QE_OPENAI_COMPAT_MODEL: 'test-model',
        QE_MCP_EXPOSE_RUNNERS: '1',
      },
      async (client) => {
        const first = client.request('tools/call', {
          name: 'qe_run_openai_compat_agent',
          arguments: { prompt: 'slow' },
        });
        const second = client.request('tools/call', {
          name: 'qe_run_openai_compat_agent',
          arguments: { prompt: 'blocked' },
        });
        const results = (await Promise.all([first, second])).map((response) => response.result.structuredContent);
        const ok = results.find((result) => result.status === 'ok');
        const blocked = results.find((result) => result.error?.category === 'budget_exceeded');
        assert.equal(ok.engine, 'openai-compat');
        assert.equal(blocked.engine, 'openai-compat');
      }
    );
  });
});
