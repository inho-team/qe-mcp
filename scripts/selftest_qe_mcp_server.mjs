#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  makeAgentRunResult,
  normalizeRequest,
  parseOutput,
  resolveAllowedCwd,
  runAgentCommand,
  runProcess,
  sanitizeEnv,
} from './lib/agent_runner_common.mjs';
import {
  ackSupervisorEvent,
  getSupervisorStatus,
  listSupervisorEvents,
  listSupervisorSpecs,
  planSupervisorInstall,
} from './lib/supervisor_tools.mjs';
import {
  syncRegistryToClients,
  writeRegistry,
} from './lib/qe_mcp_registry.mjs';

const serverPath = resolve(process.cwd(), 'scripts', 'qe_mcp_server.mjs');
const cliPath = resolve(process.cwd(), 'scripts', 'qe_mcp.mjs');
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

function createLineClient() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
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
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return new Promise((resolvePromise) => pending.set(id, resolvePromise));
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

function supervisorEvent(overrides = {}) {
  return {
    schema: 'qe.supervisor.event.v1',
    event_id: 'evt_warn',
    severity: 'WARN',
    source: 'qe-mcp',
    workspace: '/tmp/qe-supervisor-selftest',
    monitor_id: 'qe-mcp-doctor',
    dedupe_key: 'doctor-warning',
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_seen_at: '2026-07-01T00:00:00.000Z',
    ack: { state: 'unacked', acked_at: null, acked_by: null, expires_at: null },
    summary: 'doctor warning',
    details: 'bounded detail',
    evidence_path: '.qe/state/supervisor/logs/qe-mcp-doctor.log',
    evidence_fingerprint: 'sha256:a',
    remediation_hint: 'run qe-mcp doctor',
    ...overrides,
  };
}

function writeSupervisorEvents(workspace, lines) {
  const dir = join(workspace, '.qe', 'state', 'supervisor');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

function runSupervisorModuleTests() {
  const workspace = mkdtempSync(resolve(tmpdir(), 'qe-supervisor-selftest-'));
  try {
    const missing = getSupervisorStatus({ workspace_root: workspace });
    if (missing.status !== 'PASS' || !missing.errors.some((error) => error.code === 'missing_file')) {
      throw new Error('supervisor missing event file did not fail open');
    }

    const warn = supervisorEvent();
    const fail = supervisorEvent({
      event_id: 'evt_fail',
      severity: 'FAIL',
      monitor_id: 'qe-mcp-sync-dry-run',
      dedupe_key: 'sync-failed',
      evidence_fingerprint: 'sha256:f',
    });
    writeSupervisorEvents(workspace, [
      JSON.stringify(warn),
      '{bad-json',
      'x'.repeat(17 * 1024),
      JSON.stringify(fail),
    ]);
    mkdirSync(join(workspace, '.qe', 'state', 'supervisor', 'locks'), { recursive: true });
    writeFileSync(join(workspace, '.qe', 'state', 'supervisor', 'locks', 'qe-mcp-doctor.lock'), 'stale', 'utf8');

    const degraded = getSupervisorStatus({ workspace_root: workspace });
    if (
      degraded.status !== 'FAIL' ||
      !degraded.errors.some((error) => error.code === 'malformed_or_truncated') ||
      !degraded.errors.some((error) => error.code === 'oversized_event') ||
      !degraded.errors.some((error) => error.code === 'locked')
    ) {
      throw new Error('supervisor degraded event parsing failed');
    }
    const failEvents = listSupervisorEvents({ workspace_root: workspace, severity: 'FAIL' });
    if (failEvents.count !== 1 || failEvents.events[0].event_id !== 'evt_fail') {
      throw new Error('supervisor severity filtering failed');
    }
    const badSeverity = listSupervisorEvents({ workspace_root: workspace, severity: 'NOPE' });
    if (badSeverity.status !== 'error' || !badSeverity.errors.some((error) => error.code === 'bad_severity')) {
      throw new Error('supervisor bad severity should fail closed');
    }

    const ackFirst = ackSupervisorEvent({ workspace_root: workspace, event_id: 'evt_warn', actor: 'selftest' });
    if (ackFirst.status !== 'acked') throw new Error('supervisor first ack failed');
    const ackRepeat = ackSupervisorEvent({ workspace_root: workspace, event_id: 'evt_warn', actor: 'selftest' });
    if (ackRepeat.status !== 'noop') throw new Error('supervisor repeated ack should be noop');
    const missingAck = ackSupervisorEvent({ workspace_root: workspace, event_id: 'evt_missing', actor: 'selftest' });
    if (missingAck.status !== 'error' || missingAck.error?.category !== 'not_found' || missingAck.side_effects !== 'none') {
      throw new Error('supervisor missing ack should fail without side effects');
    }
    const visibleAfterAck = listSupervisorEvents({ workspace_root: workspace, include_acked: false });
    if (visibleAfterAck.events.some((event) => event.event_id === 'evt_warn')) {
      throw new Error('supervisor duplicate-after-ack should stay hidden');
    }

    writeSupervisorEvents(workspace, [
      JSON.stringify(warn),
      JSON.stringify(supervisorEvent({ event_id: 'evt_warn_new_evidence', evidence_fingerprint: 'sha256:b' })),
      JSON.stringify(supervisorEvent({ event_id: 'evt_warn_higher_severity', severity: 'FAIL' })),
    ]);
    const reopened = listSupervisorEvents({ workspace_root: workspace, include_acked: false });
    if (
      !reopened.events.some((event) => event.event_id === 'evt_warn_new_evidence') ||
      !reopened.events.some((event) => event.event_id === 'evt_warn_higher_severity')
    ) {
      throw new Error('supervisor ack reopen rules failed');
    }

    const specs = listSupervisorSpecs();
    if (
      !specs.specs.some((spec) => spec.monitor_id === 'qe-mcp-doctor') ||
      !specs.specs.some((spec) => spec.monitor_id === 'qe-mcp-sync-dry-run') ||
      !specs.specs.some((spec) => spec.monitor_id === 'qe-framework-install-state') ||
      !specs.specs.some((spec) => spec.monitor_id === 'qe-background-jobs')
    ) {
      throw new Error('supervisor monitor specs missing required entries');
    }

    const unsupported = planSupervisorInstall({ platform: 'freebsd' });
    if (unsupported.error_code !== 'UNSUPPORTED_PLATFORM' || unsupported.side_effects !== 'none') {
      throw new Error('supervisor unsupported platform response failed');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runCli(args, cwd = process.cwd()) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

async function runRegistrySyncTests() {
  const workspace = mkdtempSync(resolve(tmpdir(), 'qe-registry-selftest-'));
  try {
    const registryPath = join(workspace, 'registry.json');
    const paths = {
      claude: join(workspace, 'claude.json'),
      codex: join(workspace, 'config.toml'),
      gemini: join(workspace, 'settings.json'),
    };
    const windowsServerPath = 'C:\\Users\\Dev User\\AppData\\Roaming\\npm\\node_modules\\@inho-team\\qe-mcp\\scripts\\qe_mcp_server.mjs';
    writeRegistry(registryPath, {
      version: 1,
      servers: {
        qeExpertLibrary: {
          transport: 'stdio',
          command: 'C:\\Program Files\\nodejs\\node.exe',
          args: [windowsServerPath],
          cwd: 'C:\\Users\\Dev User\\AppData\\Roaming\\npm\\node_modules\\@inho-team\\qe-mcp',
          env: { QE_TEST: 'a"b\\c' },
          trust: true,
          enabledClients: ['claude', 'codex', 'gemini'],
        },
      },
    });

    syncRegistryToClients({ registryPath, clients: ['claude', 'codex', 'gemini'], paths });
    const claude = JSON.parse(readFileSync(paths.claude, 'utf8'));
    const gemini = JSON.parse(readFileSync(paths.gemini, 'utf8'));
    const codex = readFileSync(paths.codex, 'utf8');
    if (claude.mcpServers?.qeExpertLibrary?.type !== 'stdio') {
      throw new Error('claude MCP sync omitted type=stdio');
    }
    if (claude.mcpServers.qeExpertLibrary.args[0] !== windowsServerPath) {
      throw new Error('claude MCP sync changed Windows-style server path');
    }
    if (gemini.mcpServers?.qeExpertLibrary?.trust !== true) {
      throw new Error('gemini MCP sync omitted trust flag');
    }
    if (!codex.includes('C:\\\\Program Files\\\\nodejs\\\\node.exe') || !codex.includes('QE_TEST = "a\\"b\\\\c"')) {
      throw new Error('codex MCP sync did not TOML-escape Windows path/env values');
    }

    const firstInit = await runCli(['init-registry', '--registry', registryPath, '--force'], workspace);
    const secondInit = await runCli(['init-registry', '--registry', registryPath], workspace);
    if (firstInit.code !== 0 || secondInit.code !== 0) {
      throw new Error(`init-registry should be idempotent (first=${firstInit.code}, second=${secondInit.code})`);
    }
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (!registry.servers?.qeExpertLibrary) {
      throw new Error('init-registry did not write qeExpertLibrary');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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

  const textParsed = parseOutput({
    stdout: 'plain text result\n',
    stderr: 'warning only\n',
    outputMode: 'text',
    exitCode: 0,
  });
  if (textParsed.status !== 'ok' || textParsed.summary !== 'plain text result') {
    throw new Error('text output normalization failed');
  }

  const malformedJson = parseOutput({
    stdout: '{',
    outputMode: 'json',
    exitCode: 0,
  });
  if (malformedJson.status !== 'error' || malformedJson.error?.category !== 'malformed_output') {
    throw new Error('malformed JSON classification failed');
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

  const commandResult = await runAgentCommand({
    engine: 'codex',
    request: {
      cwd: process.cwd(),
      output_mode: 'jsonl',
      max_output_bytes: 4000,
      timeout_ms: 1000,
      call_depth: 0,
      call_chain_id: 'selftest-chain',
      origin_engine: 'selftest',
    },
    command: 'fake',
    args: ['run'],
    outputMode: 'jsonl',
    spawnImpl: createFakeSpawn({ stdout: '{"type":"result","summary":"agent done","result":"done"}\n' }),
  });
  if (
    commandResult.status !== 'ok' ||
    commandResult.metadata.lifecycle.cleanup_status !== 'not_needed' ||
    commandResult.normalization.output_format !== 'jsonl'
  ) {
    throw new Error('runAgentCommand lifecycle normalization failed');
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

function isMaintenanceStatePath(path) {
  return String(path).replace(/\\/g, '/').includes('.qe/state/mcp-maintenance/');
}

// Runs passive MCP regression checks and active runner negative-path checks.
async function main() {
  await runRunnerModuleTests();
  runSupervisorModuleTests();
  await runRegistrySyncTests();
  const helperExports = await loadOptionalHelperExports();
  const lineClient = createLineClient();
  try {
    const lineInit = await lineClient.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: 'claude-code', version: '2.1.170' },
    });
    if (lineInit.result?.protocolVersion !== '2025-11-25') {
      throw new Error('newline JSON-RPC initialize framing failed');
    }
  } finally {
    lineClient.close();
  }
  const client = createClient();
  const supervisorWorkspace = mkdtempSync(resolve(tmpdir(), 'qe-supervisor-mcp-selftest-'));
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
    const maintenanceCatalog = await client.request('tools/call', {
      name: 'qe_list_maintenance_jobs',
      arguments: { job_ids: ['qprofile', 'qrefresh', 'qe-mcp-check'] },
    });
    const maintenanceDryRun = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: { job_id: 'qe-mcp-check', mode: 'dry-run', workspace_root: process.cwd() },
    });
    const maintenanceDeniedWrite = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: {
        job_id: 'qe-mcp-check',
        mode: 'dry-run',
        workspace_root: process.cwd(),
        permission_profile: 'source-write',
      },
    });
    const maintenanceDeniedRecoverable = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: { job_id: 'qrefresh', mode: 'run-once', workspace_root: process.cwd() },
    });
    const recoverableDryRun = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: { job_id: 'qrefresh', mode: 'dry-run', workspace_root: process.cwd() },
    });
    const recoverableFingerprint = recoverableDryRun.result?.structuredContent?.approval_fingerprint;
    const recoverableMismatch = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: {
        job_id: 'qrefresh',
        mode: 'run-once',
        workspace_root: process.cwd(),
        confirm_recoverable_write: true,
        approval_fingerprint: 'wrong',
      },
    });
    const recoverablePermissionMismatch = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: {
        job_id: 'qrefresh',
        mode: 'run-once',
        workspace_root: process.cwd(),
        permission_profile: 'report-only',
        confirm_recoverable_write: true,
        approval_fingerprint: recoverableFingerprint,
      },
    });
    const recoverableRunId = `recoverable_${Date.now()}`;
    const recoverableApproved = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: {
        job_id: 'qrefresh',
        mode: 'run-once',
        run_id: recoverableRunId,
        workspace_root: process.cwd(),
        confirm_recoverable_write: true,
        approval_fingerprint: recoverableFingerprint,
      },
    });
    const recoverableStatus = await client.request('tools/call', {
      name: 'qe_get_maintenance_job_status',
      arguments: { run_id: recoverableRunId, workspace_root: process.cwd() },
    });
    const recoverableLog = await client.request('tools/call', {
      name: 'qe_get_maintenance_job_log',
      arguments: { run_id: recoverableRunId, workspace_root: process.cwd(), max_bytes: 1200 },
    });
    const maintenanceRunId = `selftest_${Date.now()}`;
    const maintenanceRun = await client.request('tools/call', {
      name: 'qe_run_maintenance_job',
      arguments: {
        job_id: 'qe-mcp-check',
        mode: 'run-once',
        run_id: maintenanceRunId,
        workspace_root: process.cwd(),
        timeout_ms: 120000,
      },
    });
    const maintenanceStatus = await client.request('tools/call', {
      name: 'qe_get_maintenance_job_status',
      arguments: { run_id: maintenanceRunId, workspace_root: process.cwd() },
    });
    const maintenanceLog = await client.request('tools/call', {
      name: 'qe_get_maintenance_job_log',
      arguments: { run_id: maintenanceRunId, workspace_root: process.cwd(), max_bytes: 1200 },
    });
    writeSupervisorEvents(supervisorWorkspace, [JSON.stringify(supervisorEvent({ event_id: 'evt_mcp_warn' }))]);
    const supervisorStatus = await client.request('tools/call', {
      name: 'qe_supervisor_status',
      arguments: { workspace_root: supervisorWorkspace },
    });
    const supervisorEvents = await client.request('tools/call', {
      name: 'qe_supervisor_events',
      arguments: { workspace_root: supervisorWorkspace, severity: 'WARN', limit: 5 },
    });
    const supervisorAck = await client.request('tools/call', {
      name: 'qe_supervisor_ack',
      arguments: { workspace_root: supervisorWorkspace, event_id: 'evt_mcp_warn', actor: 'selftest' },
    });
    const supervisorMissingAck = await client.request('tools/call', {
      name: 'qe_supervisor_ack',
      arguments: { workspace_root: supervisorWorkspace, event_id: 'evt_missing', actor: 'selftest' },
    });
    const supervisorSpecs = await client.request('tools/call', {
      name: 'qe_supervisor_specs',
      arguments: {},
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
    if (init.result?.capabilities?.resources || init.result?.capabilities?.prompts) {
      throw new Error('initialize should not advertise resources/prompts by default');
    }
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
      'qe_list_maintenance_jobs',
      'qe_run_maintenance_job',
      'qe_get_maintenance_job_status',
      'qe_get_maintenance_job_log',
      'qe_supervisor_status',
      'qe_supervisor_events',
      'qe_supervisor_ack',
      'qe_supervisor_specs',
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
    const maintenanceJobs = maintenanceCatalog.result?.structuredContent?.jobs || [];
    if (
      !maintenanceJobs.some((job) => job.job_id === 'qprofile' && job.recommended_destination === 'framework-local') ||
      !maintenanceJobs.some((job) => job.job_id === 'qrefresh' && job.class === 'recoverable-write') ||
      !maintenanceJobs.some((job) => job.job_id === 'qe-mcp-check' && job.class === 'read-only')
    ) {
      throw new Error('qe_list_maintenance_jobs did not return expected catalog entries');
    }
    if (
      maintenanceDryRun.result?.structuredContent?.status !== 'dry_run' ||
      maintenanceDryRun.result?.structuredContent?.policy?.source_write_allowed !== false ||
      maintenanceDryRun.result?.structuredContent?.policy?.runner_delegation_allowed !== false
    ) {
      throw new Error('qe_run_maintenance_job dry-run policy failed');
    }
    if (
      maintenanceDeniedWrite.result?.structuredContent?.status !== 'error' ||
      maintenanceDeniedWrite.result?.structuredContent?.error?.category !== 'policy_denied'
    ) {
      throw new Error('qe_run_maintenance_job allowed source-write permission');
    }
    if (
      maintenanceDeniedRecoverable.result?.structuredContent?.status !== 'error' ||
      maintenanceDeniedRecoverable.result?.structuredContent?.error?.category !== 'policy_denied'
    ) {
      throw new Error('qe_run_maintenance_job allowed recoverable-write run-once without approval');
    }
    if (
      recoverableDryRun.result?.structuredContent?.status !== 'dry_run' ||
      recoverableDryRun.result?.structuredContent?.approval_required !== true ||
      !recoverableFingerprint ||
      !recoverableDryRun.result?.structuredContent?.changed_paths_preview?.every((path) =>
        isMaintenanceStatePath(path)
      )
    ) {
      throw new Error('qe_run_maintenance_job recoverable dry-run preview failed');
    }
    if (
      recoverableMismatch.result?.structuredContent?.status !== 'error' ||
      recoverableMismatch.result?.structuredContent?.error?.category !== 'policy_denied'
    ) {
      throw new Error('qe_run_maintenance_job allowed mismatched recoverable approval');
    }
    if (
      recoverablePermissionMismatch.result?.structuredContent?.status !== 'error' ||
      recoverablePermissionMismatch.result?.structuredContent?.error?.category !== 'policy_denied'
    ) {
      throw new Error('qe_run_maintenance_job allowed mismatched recoverable permission_profile');
    }
    if (
      recoverableApproved.result?.structuredContent?.status !== 'completed' ||
      recoverableApproved.result?.structuredContent?.approval_id !== recoverableFingerprint ||
      !recoverableApproved.result?.structuredContent?.recovery_manifest?.entries?.length ||
      !recoverableApproved.result?.structuredContent?.changed_paths?.every((path) =>
        isMaintenanceStatePath(path)
      )
    ) {
      throw new Error('qe_run_maintenance_job approved recoverable-write failed');
    }
    if (recoverableStatus.result?.structuredContent?.state?.recovery_manifest?.approval_id !== recoverableFingerprint) {
      throw new Error('qe_get_maintenance_job_status missing recoverable manifest');
    }
    if (!String(recoverableLog.result?.structuredContent?.text || '').includes('recovery_manifest')) {
      throw new Error('qe_get_maintenance_job_log missing recoverable log content');
    }
    if (
      maintenanceRun.result?.structuredContent?.status !== 'completed' ||
      maintenanceRun.result?.structuredContent?.job?.effective_permission !== 'read-only'
    ) {
      throw new Error('qe_run_maintenance_job read-only run-once failed');
    }
    if (maintenanceStatus.result?.structuredContent?.state?.run?.run_id !== maintenanceRunId) {
      throw new Error('qe_get_maintenance_job_status failed to read run state');
    }
    if (!String(maintenanceLog.result?.structuredContent?.text || '').includes('npm run check')) {
      throw new Error('qe_get_maintenance_job_log failed to read run log');
    }
    if (
      supervisorStatus.result?.structuredContent?.status !== 'WARN' ||
      supervisorStatus.result?.structuredContent?.side_effects !== 'none'
    ) {
      throw new Error('qe_supervisor_status failed');
    }
    if (
      supervisorEvents.result?.structuredContent?.count !== 1 ||
      supervisorEvents.result?.structuredContent?.raw_capture_policy !== 'preview-only'
    ) {
      throw new Error('qe_supervisor_events failed');
    }
    if (supervisorAck.result?.structuredContent?.status !== 'acked') {
      throw new Error('qe_supervisor_ack failed');
    }
    if (
      supervisorMissingAck.result?.structuredContent?.status !== 'error' ||
      supervisorMissingAck.result?.structuredContent?.error?.category !== 'not_found'
    ) {
      throw new Error('qe_supervisor_ack missing event should fail closed');
    }
    if (!supervisorSpecs.result?.structuredContent?.specs?.some((spec) => spec.monitor_id === 'qe-mcp-doctor')) {
      throw new Error('qe_supervisor_specs failed');
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
    rmSync(supervisorWorkspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
