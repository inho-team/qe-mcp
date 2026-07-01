#!/usr/bin/env node

import { spawn } from 'child_process';
import { resolve } from 'path';

const serverPath = resolve(process.cwd(), 'scripts', 'qe_mcp_server.mjs');

function encode(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function createClient() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  let buffer = Buffer.alloc(0);
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
      const length = Number(match[1]);
      const end = headerEnd + 4 + length;
      if (buffer.length < end) return;
      const body = buffer.slice(headerEnd + 4, end).toString('utf8');
      buffer = buffer.slice(end);
      const message = JSON.parse(body);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  let nextId = 1;
  return {
    child,
    request(method, params = {}) {
      const id = nextId++;
      const message = { jsonrpc: '2.0', id, method, params };
      child.stdin.write(encode(message));
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

async function main() {
  const client = createClient();
  try {
    const init = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
    const tools = await client.request('tools/list');
    const resources = await client.request('resources/list');
    const prompts = await client.request('prompts/list');
    const expertSearch = await client.request('tools/call', {
      name: 'qe_search_experts',
      arguments: { query: 'fastapi testing', limit: 5 },
    });
    const expertRecommend = await client.request('tools/call', {
      name: 'qe_recommend_expert',
      arguments: { task: 'Build a FastAPI endpoint with async tests', client: 'codex' },
    });
    const expertRead = await client.request('tools/call', {
      name: 'qe_read_expert',
      arguments: { name: 'Qfastapi-expert', maxBytes: 800 },
    });
    const methodologyRead = await client.request('tools/call', {
      name: 'qe_read_methodology',
      arguments: { expert: 'Qfastapi-expert', reference: 'testing-async', maxBytes: 800 },
    });
    const expertPrompt = await client.request('prompts/get', {
      name: 'qe-use-expert',
      arguments: { expert: 'Qfastapi-expert', task: 'Review endpoint design' },
    });
    const truncatedRead = await client.request('tools/call', {
      name: 'qe_read_expert',
      arguments: { name: 'Qfastapi-expert', maxBytes: 200 },
    });
    const unknownExpert = await client.request('tools/call', {
      name: 'qe_read_expert',
      arguments: { name: '../Qfastapi-expert' },
    });

    if (init.result?.serverInfo?.name !== 'qe-expert-library') throw new Error('initialize failed');
    const toolNames = tools.result?.tools?.map((tool) => tool.name) || [];
    for (const name of [
      'qe_search_experts',
      'qe_recommend_expert',
      'qe_read_expert',
      'qe_read_methodology',
      'qe_expert_prompt',
      'qe_expert_library_help',
    ]) {
      if (!toolNames.includes(name)) throw new Error(`tools/list missing ${name}`);
    }
    const resourceUris = resources.result?.resources?.map((resource) => resource.uri) || [];
    if (!resourceUris.includes('qe://experts/catalog')) {
      throw new Error('resources/list missing qe://experts/catalog');
    }
    if (!prompts.result?.prompts?.some((p) => p.name === 'qe-use-expert')) {
      throw new Error('prompts/list missing qe-use-expert');
    }
    if (!expertSearch.result?.structuredContent?.results?.some((item) => item.name === 'Qfastapi-expert')) {
      throw new Error('qe_search_experts failed to find Qfastapi-expert');
    }
    if (!expertRecommend.result?.structuredContent?.recommendations?.some((item) => item.name === 'Qfastapi-expert')) {
      throw new Error('qe_recommend_expert failed to recommend Qfastapi-expert');
    }
    if (!expertRead.result?.structuredContent?.content?.includes('Qfastapi-expert')) {
      throw new Error('qe_read_expert failed to return expert content');
    }
    if (!/testing/i.test(methodologyRead.result?.structuredContent?.content || '')) {
      throw new Error('qe_read_methodology failed to return reference content');
    }
    if (!expertPrompt.result?.messages?.[0]?.content?.text?.includes('Qfastapi-expert')) {
      throw new Error('qe-use-expert prompt failed');
    }
    if (truncatedRead.result?.structuredContent?.truncated !== true) {
      throw new Error('qe_read_expert maxBytes truncation failed');
    }
    if (!unknownExpert.error) {
      throw new Error('unknown expert did not fail closed');
    }

    console.log('qe_mcp_server_ok');
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
