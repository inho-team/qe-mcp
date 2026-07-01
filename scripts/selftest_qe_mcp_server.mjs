#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  makeAgentRunResult,
  normalizeRequest,
  parseOutput,
  resolveAllowedCwd,
  runProcess,
  sanitizeEnv,
} from './lib/agent_runner_common.mjs';

const serverPath = resolve(process.cwd(), 'scripts', 'qe_mcp_server.mjs');
const libDir = resolve(process.cwd(), 'scripts', 'lib');

// Encodes a JSON-RPC message for stdio MCP framing.
function encode(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

// Starts a local MCP server process and returns a minimal test client.
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

// Imports optional runner helpers for direct regression checks.
async function loadOptionalHelperExports() {
  const helperModules = {
    codexRunner: 'codex_runner.mjs',
    claudeRunner: 'claude_runner.mjs',
    crossAgentHelp: 'cross_agent_help.mjs',
    agentRunnerContract: 'agent_runner_contract.mjs',
  };

  const exportsByModule = {};
  for (const [key, fileName] of Object.entries(helperModules)) {
    const modulePath = resolve(libDir, fileName);
    if (!existsSync(modulePath)) {
      continue;
    }
    exportsByModule[key] = await import(pathToFileURL(modulePath).href);
  }
  return exportsByModule;
}

// Creates a deterministic child_process.spawn replacement for runner tests.
function createFakeSpawn({ stdout = '', stderr = '', code = 0, delayMs = 0, neverClose = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = (signal = 'SIGTERM') => {
      child.exitCode = null;
      child.emit('close', null, signal);
      return true;
    };
    setTimeout(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      if (!neverClose) {
        child.exitCode = code;
        child.emit('close', code, null);
      }
    }, delayMs);
    return child;
  };
}

// Verifies runner helpers without launching real Codex or Claude CLIs.
async function runRunnerModuleTests() {
  const env = sanitizeEnv({
    PATH: '/bin',
    HOME: '/tmp/home',
    ANTHROPIC_API_KEY: 'secret',
    CODEX_TOKEN: 'secret',
    LANG: 'C',
  });
  if (env.ANTHROPIC_API_KEY || env.CODEX_TOKEN || env.PATH !== '/bin' || env.HOME !== '/tmp/home') {
    throw new Error('sanitizeEnv did not apply allow/deny policy');
  }

  try {
    resolveAllowedCwd('..');
    throw new Error('resolveAllowedCwd allowed parent directory escape');
  } catch (error) {
    if (error.category !== 'policy_denied') throw error;
  }

  const outsideDir = mkdtempSync(resolve(tmpdir(), 'qe-mcp-outside-'));
  const linkPath = resolve(process.cwd(), '.__qe_selftest_outside_link');
  try {
    symlinkSync(outsideDir, linkPath);
    try {
      resolveAllowedCwd(linkPath);
      throw new Error('resolveAllowedCwd allowed symlink escape');
    } catch (error) {
      if (error.category !== 'policy_denied') throw error;
    }
  } finally {
    rmSync(linkPath, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }

  const jsonParsed = parseOutput({
    stdout: JSON.stringify({ summary: 'ok summary', result: 'ok result' }),
    outputMode: 'json',
  });
  if (jsonParsed.status !== 'ok' || jsonParsed.summary !== 'ok summary') {
    throw new Error('json output normalization failed');
  }

  const jsonlParsed = parseOutput({
    stdout: '{"type":"event","summary":"step"}\nnot-json\n{"type":"result","result":"done"}\n',
    outputMode: 'jsonl',
  });
  if (jsonlParsed.status !== 'error' || jsonlParsed.normalization.normalization_status !== 'partial') {
    throw new Error('jsonl partial normalization failed');
  }

  const streamJsonParsed = parseOutput({
    stdout: '{"type":"result","summary":"stream done","result":"done"}\n',
    outputMode: 'stream-json',
  });
  if (streamJsonParsed.status !== 'ok' || streamJsonParsed.normalization.output_format !== 'stream-json') {
    throw new Error('stream-json normalization failed');
  }

  try {
    normalizeRequest({ task: 'nested', call_depth: 1 }, 'codex');
    throw new Error('normalizeRequest allowed nested runner recursion');
  } catch (error) {
    if (error.category !== 'recursion_blocked') throw error;
  }

  try {
    normalizeRequest({ task: 'mcp', mcp_policy: 'allowlist' }, 'claude');
    throw new Error('normalizeRequest allowed child MCP config');
  } catch (error) {
    if (error.category !== 'mcp_config_rejected') throw error;
  }

  const notInstalled = parseOutput({
    stderr: 'spawn codex ENOENT',
    outputMode: 'text',
    exitCode: 1,
  });
  if (notInstalled.error?.category !== 'not_installed') {
    throw new Error('not-installed classification failed');
  }

  const quota = parseOutput({
    stderr: 'api_error_status 429 weekly limit',
    outputMode: 'text',
    exitCode: 1,
  });
  if (quota.error?.category !== 'auth_missing') {
    throw new Error('auth/quota classification failed');
  }

  const budget = parseOutput({
    stderr: 'max budget exceeded by local cap',
    outputMode: 'text',
    exitCode: 1,
  });
  if (budget.error?.category !== 'budget_exceeded') {
    throw new Error('budget classification failed');
  }

  const capped = makeAgentRunResult({
    engine: 'codex',
    request: { max_output_bytes: 1200 },
    status: 'ok',
    summary: 'x'.repeat(2000),
    output: 'y'.repeat(4000),
    events: [{ payload: 'z'.repeat(4000) }],
  });
  if (Buffer.byteLength(JSON.stringify(capped), 'utf8') > 1200 || capped.normalization.truncated !== true) {
    throw new Error('aggregate result cap failed');
  }

  const successCapture = await runProcess('fake', ['--version'], {
    spawnImpl: createFakeSpawn({ stdout: 'fake 1.0\n' }),
  });
  if (successCapture.code !== 0 || !successCapture.stdout.includes('fake 1.0')) {
    throw new Error('fake subprocess success path failed');
  }

  const timeoutCapture = await runProcess('fake', [], {
    timeoutMs: 5,
    spawnImpl: createFakeSpawn({ neverClose: true }),
  });
  if (timeoutCapture.timedOut !== true || timeoutCapture.signal !== 'SIGTERM') {
    throw new Error('fake subprocess timeout path failed');
  }
}

// Confirms runner tools return the public AgentRunResult envelope.
function assertAgentRunResultShape(result, label) {
  for (const field of ['engine', 'status', 'summary', 'output', 'events', 'metadata', 'normalization']) {
    if (!(field in result)) throw new Error(`${label} missing AgentRunResult field ${field}`);
  }
  for (const field of ['cwd', 'duration_ms', 'exit_code', 'signal', 'call_depth', 'call_chain_id', 'origin_engine', 'lifecycle']) {
    if (!(field in result.metadata)) throw new Error(`${label} missing metadata.${field}`);
  }
  if (!('cleanup_status' in result.metadata.lifecycle)) {
    throw new Error(`${label} missing metadata.lifecycle.cleanup_status`);
  }
  for (const field of [
    'output_format',
    'normalization_status',
    'truncated',
    'stdout_bytes',
    'stderr_bytes',
    'parse_error',
    'raw_capture_policy',
  ]) {
    if (!(field in result.normalization)) throw new Error(`${label} missing normalization.${field}`);
  }
}

// Runs passive MCP regression checks and active runner negative-path checks.
async function main() {
  await runRunnerModuleTests();
  const helperExports = await loadOptionalHelperExports();
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
    const libraryHelp = await client.request('tools/call', {
      name: 'qe_expert_library_help',
    });
    const expertPromptTool = await client.request('tools/call', {
      name: 'qe_expert_prompt',
      arguments: { expert: 'Qfastapi-expert', task: 'Review endpoint design', mode: 'review' },
    });
    const expertPrompt = await client.request('prompts/get', {
      name: 'qe-use-expert',
      arguments: { expert: 'Qfastapi-expert', task: 'Review endpoint design' },
    });
    const crossAgentHelp = await client.request('tools/call', {
      name: 'qe_cross_agent_help',
    });
    const invalidCodexRun = await client.request('tools/call', {
      name: 'qe_run_codex_agent',
      arguments: {},
    });
    const invalidClaudeRun = await client.request('tools/call', {
      name: 'qe_run_claude_agent',
      arguments: {},
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
      'qe_run_codex_agent',
      'qe_run_claude_agent',
      'qe_cross_agent_help',
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
    if (!libraryHelp.result?.structuredContent?.packs?.length) {
      throw new Error('qe_expert_library_help failed to return help payload');
    }
    if (!expertPromptTool.result?.structuredContent?.messages?.[0]?.content?.text?.includes('Qfastapi-expert')) {
      throw new Error('qe_expert_prompt tool failed');
    }
    if (!expertPrompt.result?.messages?.[0]?.content?.text?.includes('Qfastapi-expert')) {
      throw new Error('qe-use-expert prompt failed');
    }
    if (crossAgentHelp.result?.structuredContent?.launchesAgentRunners !== false) {
      throw new Error('qe_cross_agent_help should be passive');
    }
    const crossAgentToolNames = crossAgentHelp.result?.structuredContent?.tools?.map((tool) => tool.name) || [];
    for (const name of ['qe_run_codex_agent', 'qe_run_claude_agent', 'qe_cross_agent_help']) {
      if (!crossAgentToolNames.includes(name)) {
        throw new Error(`qe_cross_agent_help missing ${name}`);
      }
    }
    const codexRunError =
      invalidCodexRun.error?.message || invalidCodexRun.result?.structuredContent?.error?.message || '';
    const claudeRunError =
      invalidClaudeRun.error?.message || invalidClaudeRun.result?.structuredContent?.error?.message || '';
    if (!codexRunError.includes('prompt')) {
      throw new Error('qe_run_codex_agent missing-task validation failed');
    }
    if (!claudeRunError.includes('prompt')) {
      throw new Error('qe_run_claude_agent missing-task validation failed');
    }
    assertAgentRunResultShape(invalidCodexRun.result?.structuredContent || {}, 'codex invalid request');
    assertAgentRunResultShape(invalidClaudeRun.result?.structuredContent || {}, 'claude invalid request');
    if (truncatedRead.result?.structuredContent?.truncated !== true) {
      throw new Error('qe_read_expert maxBytes truncation failed');
    }
    if (!unknownExpert.error) {
      throw new Error('unknown expert did not fail closed');
    }

    if (typeof helperExports.agentRunnerContract?.buildToolSchemas === 'function') {
      const helperSchemas = helperExports.agentRunnerContract.buildToolSchemas();
      if (
        !helperSchemas?.qe_run_codex_agent?.properties?.task ||
        !helperSchemas?.qe_run_claude_agent?.properties?.task
      ) {
        throw new Error('buildToolSchemas export did not return an object');
      }
    }
    if (typeof helperExports.crossAgentHelp?.getCrossAgentHelp === 'function') {
      const helperHelp = await helperExports.crossAgentHelp.getCrossAgentHelp(
        {},
        { spawnImpl: createFakeSpawn({ stdout: 'runner 1.0\n' }) }
      );
      if (!helperHelp || typeof helperHelp !== 'object') {
        throw new Error('getCrossAgentHelp export did not return an object');
      }
      const stalledHelp = await helperExports.crossAgentHelp.getCrossAgentHelp(
        {},
        { spawnImpl: createFakeSpawn({ neverClose: true }) }
      );
      if (
        stalledHelp.engines?.codex?.unknown !== true ||
        stalledHelp.engines?.claude?.unknown !== true ||
        stalledHelp.safety?.raw_help_text !== 'not-returned'
      ) {
        throw new Error('getCrossAgentHelp stalled fallback failed');
      }
    }
    if (
      typeof helperExports.codexRunner?.runCodexAgent === 'function' &&
      invalidCodexRun.result?.structuredContent?.status !== 'error'
    ) {
      throw new Error('qe_run_codex_agent helper-backed negative path did not return structured error');
    }
    if (typeof helperExports.codexRunner?.runCodexAgent === 'function') {
      const unsafeCodex = await helperExports.codexRunner.runCodexAgent({
        prompt: 'policy probe',
        sandbox_mode: 'danger-full-access',
      });
      if (unsafeCodex.status !== 'error' || unsafeCodex.error?.category !== 'policy_denied') {
        throw new Error('qe_run_codex_agent allowed unsafe sandbox policy');
      }
    }
    if (
      typeof helperExports.claudeRunner?.runClaudeAgent === 'function' &&
      invalidClaudeRun.result?.structuredContent?.status !== 'error'
    ) {
      throw new Error('qe_run_claude_agent helper-backed negative path did not return structured error');
    }
    if (typeof helperExports.claudeRunner?.runClaudeAgent === 'function') {
      const unsafeClaude = await helperExports.claudeRunner.runClaudeAgent({
        prompt: 'policy probe',
        permission_mode: 'bypassPermissions',
      });
      if (unsafeClaude.status !== 'error' || unsafeClaude.error?.category !== 'policy_denied') {
        throw new Error('qe_run_claude_agent allowed unsafe permission policy');
      }
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
