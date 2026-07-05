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
import {
  buildToolSchemas,
  normalizeAgentRunRequest,
} from './lib/agent_runner_contract.mjs';

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

function createLineClient(env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
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
    agentEngineDelegation: 'agent_engine_delegation.mjs',
    delegateRunner: 'delegate_runner.mjs',
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

function createCountingFakeSpawn(options = {}) {
  const fakeSpawn = createFakeSpawn(options);
  let count = 0;
  return {
    spawnImpl(...args) {
      count += 1;
      return fakeSpawn(...args);
    },
    get count() {
      return count;
    },
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
    writeRegistry(registryPath, {
      version: 1,
      servers: {
        qeExpertLibrary: {
          transport: 'stdio',
          command: 'custom-node',
          args: ['custom-server.mjs'],
        },
      },
    });
    const preserveInit = await runCli(['init-registry', '--registry', registryPath], workspace);
    const preserved = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (preserveInit.code !== 0 || preserved.servers.qeExpertLibrary.command !== 'custom-node') {
      throw new Error('init-registry rewrote existing registry without --force');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function hasDelegationDirection(value) {
  if (!value || typeof value !== 'object') return false;
  if (
    typeof value.origin_engine === 'string' &&
    typeof value.target_engine === 'string' &&
    (typeof value.delegation_direction === 'string' || typeof value.direction === 'string') &&
    'call_depth' in value
  ) {
    return true;
  }
  return Object.values(value).some((item) => hasDelegationDirection(item));
}

function assertNoRawLifecycleCapture(record, label) {
  const text = JSON.stringify(record);
  const rawFields = new Set(['raw_prompt', 'raw_stdout', 'raw_stderr', 'prompt', 'stdout', 'stderr']);
  const assertNoRawField = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nestedValue] of Object.entries(value)) {
      if (rawFields.has(key)) {
        throw new Error(`${label} persisted raw lifecycle field ${key}`);
      }
      assertNoRawField(nestedValue);
    }
  };
  assertNoRawField(record);
  for (const secret of ['PHASE2_RAW_PROMPT_SECRET', 'PHASE2_RAW_STDOUT_SECRET', 'PHASE2_RAW_STDERR_SECRET']) {
    if (text.includes(secret)) {
      throw new Error(`${label} persisted raw lifecycle capture ${secret}`);
    }
  }
}

function readLifecycleRecordFromResult(result, helperExports, stateRoot = process.cwd()) {
  const lifecycle = result?.metadata?.lifecycle || {};
  const runId = lifecycle.run_id;
  if (!runId) return null;
  const recordPath =
    typeof helperExports?.agentEngineDelegation?.getLifecycleRecordPath === 'function'
      ? helperExports.agentEngineDelegation.getLifecycleRecordPath(runId, stateRoot)
      : resolve(stateRoot, '.qe', 'state', 'agent-runs', `${runId}.json`);
  const resolved = resolve(recordPath);
  if (!resolved.includes(`${resolve(stateRoot, '.qe', 'state')}`)) {
    throw new Error(`lifecycle record escaped QE state namespace: ${recordPath}`);
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

function assertEngineDelegationExports(engineModule) {
  if (!engineModule) {
    throw new Error('agent_engine_delegation module missing');
  }
  const exportNames = Object.keys(engineModule);
  const hasExportMatching = (pattern) => exportNames.some((name) => pattern.test(name));
  if (!hasExportMatching(/direction/i)) {
    throw new Error('agent_engine_delegation missing direction helper export');
  }
  if (!hasExportMatching(/prompt|envelope/i)) {
    throw new Error('agent_engine_delegation missing prompt/envelope helper export');
  }
  if (!hasExportMatching(/lifecycle|record/i)) {
    throw new Error('agent_engine_delegation missing lifecycle helper export');
  }
  if (!hasExportMatching(/capabil|route|decision|delegate/i)) {
    throw new Error('agent_engine_delegation missing capability/decision helper export');
  }
}

async function runDelegationEngineCoreTests(helperExports) {
  assertEngineDelegationExports(helperExports.agentEngineDelegation);

  if (typeof helperExports.codexRunner?.runCodexAgent !== 'function') {
    throw new Error('codex runner helper missing for delegation engine compatibility test');
  }

  const mismatchSpawn = createCountingFakeSpawn({
    stdout: '{"type":"result","summary":"should not spawn","result":"should not spawn"}\n',
  });
  const mismatch = await helperExports.codexRunner.runCodexAgent(
    {
      prompt: 'capability mismatch probe',
      output_mode: 'xml',
      origin_engine: 'claude',
      intent: 'capability-mismatch-selftest',
      timeout_ms: 1000,
    },
    { spawnImpl: mismatchSpawn.spawnImpl }
  );
  if (mismatch.status !== 'error' || mismatch.error?.category !== 'policy_denied') {
    throw new Error('capability mismatch did not return structured denial');
  }
  if (mismatchSpawn.count !== 0) {
    throw new Error('capability mismatch launched subprocess before denial');
  }

  const successSpawn = createCountingFakeSpawn({
    stdout: '{"type":"result","summary":"PHASE2_RAW_STDOUT_SECRET","result":"delegation ok"}\n',
    stderr: 'PHASE2_RAW_STDERR_SECRET\n',
  });
  const delegated = await helperExports.codexRunner.runCodexAgent(
    {
      task: 'PHASE2_RAW_PROMPT_SECRET',
      origin_engine: 'claude',
      intent: 'legacy-task-alias-selftest',
      timeout_ms: 1000,
      call_chain_id: 'phase2-selftest-chain',
    },
    { spawnImpl: successSpawn.spawnImpl }
  );
  if (delegated.status !== 'ok' || delegated.summary !== 'PHASE2_RAW_STDOUT_SECRET') {
    throw new Error('delegation engine broke legacy task alias compatibility');
  }
  if (successSpawn.count !== 1) {
    throw new Error('accepted delegation did not launch exactly one subprocess');
  }
  const lifecycleRecord = readLifecycleRecordFromResult(delegated, helperExports);
  if (!hasDelegationDirection(delegated.metadata) && !hasDelegationDirection(lifecycleRecord)) {
    throw new Error('delegation direction metadata missing from result/lifecycle');
  }
  if (!lifecycleRecord) {
    throw new Error('delegation lifecycle record missing from run id');
  }
  assertNoRawLifecycleCapture(lifecycleRecord, 'delegation lifecycle record');
  if (
    delegated.metadata?.lifecycle?.state_path ||
    delegated.metadata?.lifecycle?.record_path ||
    delegated.metadata?.lifecycle?.recordPath
  ) {
    throw new Error('delegation lifecycle result leaked a local state path');
  }
  const delegatedRunId = delegated.metadata?.lifecycle?.run_id;
  if (delegatedRunId && typeof helperExports.agentEngineDelegation?.getLifecycleRecordPath === 'function') {
    rmSync(helperExports.agentEngineDelegation.getLifecycleRecordPath(delegatedRunId), { force: true });
  }

  if (typeof helperExports.delegateRunner?.runDelegateAgent !== 'function') {
    throw new Error('delegate runner helper missing for public engine surface test');
  }
  const publicWorkspace = mkdtempSync(resolve(tmpdir(), 'qe-public-engine-selftest-'));
  try {
    const codexDelegateSpawn = createCountingFakeSpawn({
      stdout: '{"type":"result","summary":"delegate codex ok","result":"delegate codex ok"}\n',
    });
    const codexDelegate = await helperExports.delegateRunner.runDelegateAgent(
      {
        target_engine: 'codex',
        prompt: 'PUBLIC_ENGINE_RAW_PROMPT_SECRET',
        origin_engine: 'selftest',
        timeout_ms: 1000,
      },
      { spawnImpl: codexDelegateSpawn.spawnImpl, stateRoot: publicWorkspace }
    );
    if (codexDelegate.status !== 'ok' || codexDelegate.metadata?.target_engine !== 'codex') {
      throw new Error('qe_delegate_agent helper did not route Codex target through engine');
    }
    if (codexDelegateSpawn.count !== 1) {
      throw new Error('qe_delegate_agent Codex helper did not launch exactly once');
    }
    const claudeDelegateSpawn = createCountingFakeSpawn({
      stdout: JSON.stringify({ summary: 'delegate claude ok', result: 'delegate claude ok' }),
    });
    const claudeDelegate = await helperExports.delegateRunner.runDelegateAgent(
      {
        target_engine: 'claude',
        prompt: 'delegate claude prompt',
        origin_engine: 'selftest',
        timeout_ms: 1000,
      },
      { spawnImpl: claudeDelegateSpawn.spawnImpl, stateRoot: publicWorkspace }
    );
    if (claudeDelegate.status !== 'ok' || claudeDelegate.metadata?.target_engine !== 'claude') {
      throw new Error('qe_delegate_agent helper did not route Claude target through engine');
    }
    const deniedDelegateSpawn = createCountingFakeSpawn({
      stdout: '{"type":"result","summary":"should not spawn","result":"should not spawn"}\n',
    });
    const deniedDelegate = await helperExports.delegateRunner.runDelegateAgent(
      {
        target_engine: 'claude',
        prompt: 'PUBLIC_ENGINE_DENIED_PROMPT_SECRET',
        output_mode: 'jsonl',
        origin_engine: 'selftest',
        timeout_ms: 1000,
      },
      { spawnImpl: deniedDelegateSpawn.spawnImpl, stateRoot: publicWorkspace }
    );
    if (deniedDelegate.status !== 'error' || deniedDelegate.error?.category !== 'policy_denied') {
      throw new Error('qe_delegate_agent helper did not return structured denial');
    }
    if (deniedDelegateSpawn.count !== 0) {
      throw new Error('qe_delegate_agent helper denial launched subprocess');
    }
    const statusProjection = await helperExports.agentEngineDelegation.getAgentRunProjection(
      codexDelegate.metadata.lifecycle.run_id,
      { stateRoot: publicWorkspace }
    );
    if (
      statusProjection.direction?.target_engine !== 'codex' ||
      statusProjection.request?.prompt_sha256 === undefined ||
      JSON.stringify(statusProjection).includes('PUBLIC_ENGINE_RAW_PROMPT_SECRET') ||
      JSON.stringify(statusProjection).includes(process.cwd()) ||
      Object.hasOwn(statusProjection.request || {}, 'cwd')
    ) {
      throw new Error('agent run projection leaked raw prompt/cwd or missed direction metadata');
    }
    const deniedProjection = await helperExports.agentEngineDelegation.getAgentRunProjection(
      deniedDelegate.metadata.lifecycle.run_id,
      { stateRoot: publicWorkspace }
    );
    if (deniedProjection.status !== 'denied' || deniedProjection.decision?.accepted !== false) {
      throw new Error('agent run projection did not expose denied lifecycle');
    }
    try {
      await helperExports.agentEngineDelegation.getAgentRunProjection('../escape', { stateRoot: publicWorkspace });
      throw new Error('agent run projection allowed path traversal run_id');
    } catch (error) {
      if (!/invalid lifecycle run id/.test(error.message)) throw error;
    }
  } finally {
    rmSync(publicWorkspace, { recursive: true, force: true });
  }

  const raceWorkspace = mkdtempSync(resolve(tmpdir(), 'qe-agent-lifecycle-race-'));
  try {
    const run = await helperExports.agentEngineDelegation.createDelegationRun({
      request: {
        engine: 'codex',
        prompt: 'race probe',
        cwd: process.cwd(),
        origin_engine: 'selftest',
        output_mode: 'jsonl',
        mcp_policy: 'none',
        allow_writes: false,
        timeout_ms: 1000,
        max_output_bytes: 4000,
        call_depth: 0,
        call_chain_id: 'phase2-race-chain',
        max_turns: 1,
        max_budget_usd: 0.05,
        max_concurrent_runs: 1,
        sandbox_mode: 'read-only',
        permission_mode: 'plan',
      },
      targetEngine: 'codex',
      command: 'codex',
      options: { stateRoot: raceWorkspace, spawnImpl: successSpawn.spawnImpl },
    });
    await Promise.all([
      helperExports.agentEngineDelegation.transitionDelegationRun(run, 'started', { reason: 'race-a' }),
      helperExports.agentEngineDelegation.transitionDelegationRun(run, 'failed', { reason: 'race-b' }),
    ]);
    const raced = JSON.parse(readFileSync(run.path, 'utf8'));
    const reasons = raced.transitions.map((transition) => transition.reason).filter(Boolean);
    if (!reasons.includes('race-a') || !reasons.includes('race-b')) {
      throw new Error('delegation lifecycle transition queue dropped concurrent transitions');
    }
  } finally {
    rmSync(raceWorkspace, { recursive: true, force: true });
  }

  const corruptWorkspace = mkdtempSync(resolve(tmpdir(), 'qe-agent-lifecycle-corrupt-'));
  try {
    const corruptDir = resolve(corruptWorkspace, '.qe', 'state', 'agent-runs');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'corrupt-run.json'), '{"run_id":"wrong","status":"completed"}\n');
    try {
      await helperExports.agentEngineDelegation.getAgentRunProjection('corrupt-run', { stateRoot: corruptWorkspace });
      throw new Error('agent run projection accepted malformed lifecycle state');
    } catch (error) {
      if (error.category !== 'corrupt_state') throw error;
    }
  } finally {
    rmSync(corruptWorkspace, { recursive: true, force: true });
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

  try {
    normalizeAgentRunRequest({ prompt: 'mcp', engine: 'codex', mcp_policy: 'allowlist' });
    throw new Error('normalizeAgentRunRequest allowed child MCP config');
  } catch (error) {
    if (error.category !== 'mcp_config_rejected') throw error;
  }

  try {
    normalizeRequest({ task: 'parallel', max_concurrent_runs: 2 }, 'codex');
    throw new Error('normalizeRequest allowed parallel runner calls');
  } catch (error) {
    if (error.category !== 'policy_denied') throw error;
  }

  try {
    normalizeRequest({ task: 'claude unsafe', permission_mode: 'default' }, 'claude');
    throw new Error('normalizeRequest allowed unsupported Claude permission mode');
  } catch (error) {
    if (error.category !== 'policy_denied') throw error;
  }

  const aliasRequest = normalizeRequest({ task: 'legacy alias' }, 'codex');
  if (aliasRequest.prompt !== 'legacy alias' || aliasRequest.output_mode !== 'jsonl') {
    throw new Error('normalizeRequest did not preserve legacy task alias');
  }

  const schemas = buildToolSchemas();
  if (
    schemas.qe_run_claude_agent.properties.permission_mode.enum.length !== 1 ||
    schemas.qe_run_claude_agent.properties.permission_mode.enum[0] !== 'plan' ||
    schemas.qe_run_claude_agent.properties.mcp_policy.enum[0] !== 'none' ||
    schemas.qe_run_codex_agent.properties.max_concurrent_runs.maximum !== 1 ||
    !schemas.qe_run_codex_agent.properties.task
  ) {
    throw new Error('runner tool schemas drifted from canonical contract');
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

// Runs passive MCP regression checks and active runner negative-path checks.
async function main() {
  await runRunnerModuleTests();
  runSupervisorModuleTests();
  await runRegistrySyncTests();
  const helperExports = await loadOptionalHelperExports();
  await runDelegationEngineCoreTests(helperExports);
  const mcpProjectionRun =
    typeof helperExports.delegateRunner?.runDelegateAgent === 'function'
      ? await helperExports.delegateRunner.runDelegateAgent(
          {
            target_engine: 'codex',
            prompt: 'PUBLIC_ENGINE_MCP_RAW_PROMPT_SECRET',
            origin_engine: 'selftest',
            timeout_ms: 1000,
          },
          {
            spawnImpl: createFakeSpawn({
              stdout: '{"type":"result","summary":"PUBLIC_ENGINE_MCP_RAW_STDOUT_SECRET","result":"ok"}\n',
            }),
          }
        )
      : null;
  const lineClient = createLineClient();
  try {
    lineClient.child.stdin.write('{not-json}\n');
    const lineInit = await lineClient.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: 'claude-code', version: '2.1.170' },
    });
    if (lineInit.result?.protocolVersion !== '2025-03-26') {
      throw new Error('newline JSON-RPC initialize framing failed after malformed line');
    }
  } finally {
    lineClient.close();
  }
  const mismatchClient = createLineClient();
  try {
    const mismatchInit = await mismatchClient.request('initialize', {
      protocolVersion: '2099-01-01',
      capabilities: {},
    });
    if (mismatchInit.result?.protocolVersion !== '2025-03-26') {
      throw new Error('initialize should negotiate to supported protocol version');
    }
  } finally {
    mismatchClient.close();
  }
  const resourcesOnlyClient = createLineClient({ QE_MCP_EXPOSE_RESOURCES: '1', QE_MCP_EXPOSE_PROMPTS: '' });
  try {
    const resourcesOnly = await resourcesOnlyClient.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
    });
    if (!resourcesOnly.result?.capabilities?.resources || resourcesOnly.result?.capabilities?.prompts) {
      throw new Error('resource-only capability flag exposed wrong optional surfaces');
    }
  } finally {
    resourcesOnlyClient.close();
  }
  const promptsOnlyClient = createLineClient({ QE_MCP_EXPOSE_RESOURCES: '', QE_MCP_EXPOSE_PROMPTS: '1' });
  try {
    const promptsOnly = await promptsOnlyClient.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
    });
    if (promptsOnly.result?.capabilities?.resources || !promptsOnly.result?.capabilities?.prompts) {
      throw new Error('prompt-only capability flag exposed wrong optional surfaces');
    }
  } finally {
    promptsOnlyClient.close();
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
    const agentRunStatus = await client.request('tools/call', {
      name: 'qe_agent_run_status',
      arguments: { run_id: mcpProjectionRun?.metadata?.lifecycle?.run_id || 'missing' },
    });
    const agentRunRead = await client.request('tools/call', {
      name: 'qe_agent_run_read',
      arguments: { run_id: mcpProjectionRun?.metadata?.lifecycle?.run_id || 'missing' },
    });
    const agentRunTraversal = await client.request('tools/call', {
      name: 'qe_agent_run_read',
      arguments: { run_id: '../escape' },
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
      'qe_delegate_agent',
      'qe_agent_run_status',
      'qe_agent_run_read',
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
    const delegateTool = tools.result?.tools?.find((tool) => tool.name === 'qe_delegate_agent');
    if (
      delegateTool?.inputSchema?.properties?.target_engine?.enum?.join(',') !== 'claude,codex' ||
      !delegateTool?.inputSchema?.required?.includes('target_engine') ||
      !Array.isArray(delegateTool?.inputSchema?.anyOf)
    ) {
      throw new Error('qe_delegate_agent schema missing bounded target_engine enum or required input contract');
    }
    if (
      agentRunStatus.result?.structuredContent?.direction?.target_engine !== 'codex' ||
      agentRunStatus.result?.structuredContent?.transitions !== undefined
    ) {
      throw new Error('qe_agent_run_status did not return compact lifecycle status');
    }
    const agentRunReadText = JSON.stringify(agentRunRead.result?.structuredContent || {});
    if (
      agentRunRead.result?.structuredContent?.direction?.target_engine !== 'codex' ||
      !Array.isArray(agentRunRead.result?.structuredContent?.transitions) ||
      agentRunReadText.includes('PUBLIC_ENGINE_MCP_RAW_PROMPT_SECRET') ||
      agentRunReadText.includes('PUBLIC_ENGINE_MCP_RAW_STDOUT_SECRET')
    ) {
      throw new Error('qe_agent_run_read did not return redacted lifecycle projection');
    }
    if (!agentRunTraversal.error) {
      throw new Error('qe_agent_run_read allowed invalid run_id traversal');
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
        String(path).includes('/.qe/state/mcp-maintenance/')
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
        String(path).includes('/.qe/state/mcp-maintenance/')
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
        !helperSchemas?.qe_run_claude_agent?.properties?.task ||
        helperSchemas?.qe_run_claude_agent?.properties?.permission_mode?.enum?.join(',') !== 'plan' ||
        helperSchemas?.qe_run_codex_agent?.properties?.mcp_policy?.enum?.join(',') !== 'none'
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
      const legacyTaskCodex = await helperExports.codexRunner.runCodexAgent(
        { task: 'legacy task alias', timeout_ms: 1000 },
        { spawnImpl: createFakeSpawn({ stdout: '{"type":"result","summary":"alias ok","result":"alias ok"}\n' }) }
      );
      if (legacyTaskCodex.status !== 'ok' || legacyTaskCodex.summary !== 'alias ok') {
        throw new Error('qe_run_codex_agent did not preserve legacy task alias');
      }
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
        permission_mode: 'default',
      });
      if (unsafeClaude.status !== 'error' || unsafeClaude.error?.category !== 'policy_denied') {
        throw new Error('qe_run_claude_agent allowed unsafe permission policy');
      }
    }

    console.log('qe_mcp_server_ok');
  } finally {
    client.close();
    const mcpProjectionRunId = mcpProjectionRun?.metadata?.lifecycle?.run_id;
    if (mcpProjectionRunId && typeof helperExports.agentEngineDelegation?.getLifecycleRecordPath === 'function') {
      rmSync(helperExports.agentEngineDelegation.getLifecycleRecordPath(mcpProjectionRunId), { force: true });
    }
    rmSync(supervisorWorkspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
