#!/usr/bin/env node

import {
  buildExpertPrompt,
  listExpertResources,
  readExpert,
  readExpertResource,
  readMethodology,
  recommendExpert,
  searchExperts,
} from './lib/qe_expert_library.mjs';
import { getAgentRunProjection } from './lib/agent_engine_delegation.mjs';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_VERSION = '0.2.5';
let activeRunnerCount = 0;
const FALLBACK_AGENT_TOOL_SCHEMAS = {
  qe_run_codex_agent: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: { type: 'string' },
      prompt: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
      max_output_bytes: { type: 'integer', minimum: 200, maximum: 1000000 },
      allow_writes: { type: 'boolean' },
      sandbox_mode: { type: 'string', enum: ['read-only', 'workspace-write'] },
      call_depth: { type: 'integer', minimum: 0, maximum: 1 },
      call_chain_id: { type: 'string' },
      origin_engine: { type: 'string' },
      max_turns: { type: 'integer', minimum: 1, maximum: 5 },
      max_budget_usd: { type: 'number', minimum: 0, maximum: 10 },
      max_concurrent_runs: { type: 'integer', minimum: 1, maximum: 1 },
      mcp_policy: { type: 'string', enum: ['none'] },
      output_mode: { type: 'string', enum: ['text', 'json', 'stream-json', 'jsonl'] },
    },
  },
  qe_run_claude_agent: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: { type: 'string' },
      prompt: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
      max_output_bytes: { type: 'integer', minimum: 200, maximum: 1000000 },
      allow_writes: { type: 'boolean' },
      permission_mode: { type: 'string', enum: ['plan'] },
      call_depth: { type: 'integer', minimum: 0, maximum: 1 },
      call_chain_id: { type: 'string' },
      origin_engine: { type: 'string' },
      max_turns: { type: 'integer', minimum: 1, maximum: 5 },
      max_budget_usd: { type: 'number', minimum: 0, maximum: 10 },
      max_concurrent_runs: { type: 'integer', minimum: 1, maximum: 1 },
      mcp_policy: { type: 'string', enum: ['none'] },
      output_mode: { type: 'string', enum: ['text', 'json', 'stream-json', 'jsonl'] },
    },
  },
  qe_cross_agent_help: {
    type: 'object',
    properties: {},
  },
  qe_delegate_agent: {
    type: 'object',
    additionalProperties: false,
    required: ['target_engine'],
    anyOf: [{ required: ['prompt'] }, { required: ['task'] }],
    properties: {
      task: { type: 'string' },
      prompt: { type: 'string' },
      target_engine: { type: 'string', enum: ['claude', 'codex'] },
      intent: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
      max_output_bytes: { type: 'integer', minimum: 200, maximum: 1000000 },
      allow_writes: { type: 'boolean' },
      sandbox_mode: { type: 'string', enum: ['read-only', 'workspace-write'] },
      permission_mode: { type: 'string', enum: ['plan'] },
      call_depth: { type: 'integer', minimum: 0, maximum: 1 },
      call_chain_id: { type: 'string' },
      origin_engine: { type: 'string' },
      max_turns: { type: 'integer', minimum: 1, maximum: 5 },
      max_budget_usd: { type: 'number', minimum: 0, maximum: 10 },
      max_concurrent_runs: { type: 'integer', minimum: 1, maximum: 1 },
      mcp_policy: { type: 'string', enum: ['none'] },
      output_mode: { type: 'string', enum: ['text', 'json', 'stream-json', 'jsonl'] },
      policy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allow_writes: { type: 'boolean' },
          sandbox_mode: { type: 'string', enum: ['read-only', 'workspace-write'] },
          permission_mode: { type: 'string', enum: ['plan'] },
          mcp_policy: { type: 'string', enum: ['none'] },
          max_concurrent_runs: { type: 'integer', minimum: 1, maximum: 1 },
        },
      },
      output_contract: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output_mode: { type: 'string', enum: ['text', 'json', 'stream-json', 'jsonl'] },
          max_output_bytes: { type: 'integer', minimum: 200, maximum: 1000000 },
        },
      },
    },
  },
  qe_agent_run_status: {
    type: 'object',
    additionalProperties: false,
    required: ['run_id'],
    properties: {
      run_id: { type: 'string' },
    },
  },
  qe_agent_run_read: {
    type: 'object',
    additionalProperties: false,
    required: ['run_id'],
    properties: {
      run_id: { type: 'string' },
      include_transitions: { type: 'boolean' },
    },
  },
};

const AGENT_TOOL_HELP = [
  {
    name: 'qe_run_codex_agent',
    sideEffects: 'May launch a Codex agent. Default read-only; writes require allow_writes and workspace-write.',
    auth: 'Uses the local Codex CLI/session auth already configured on this machine.',
    timeout: 'Bounded by timeout_ms; default 60000 ms, max 600000 ms.',
    outputCap: 'Bounded by max_output_bytes; default 24000 bytes, max 1000000 bytes.',
    recursion: 'Do not invoke from a nested Codex/Claude agent task that could route back into this tool.',
  },
  {
    name: 'qe_run_claude_agent',
    sideEffects: 'May launch a Claude agent. Permission mode is fixed to plan with restricted tools.',
    auth: 'Uses the local Claude CLI/session auth already configured on this machine.',
    timeout: 'Bounded by timeout_ms; default 60000 ms, max 600000 ms.',
    outputCap: 'Bounded by max_output_bytes; default 24000 bytes, max 1000000 bytes.',
    recursion: 'Do not invoke from a nested Codex/Claude agent task that could route back into this tool.',
  },
  {
    name: 'qe_cross_agent_help',
    sideEffects: 'Passive help only; never launches agent runners or edits files.',
    auth: 'No new auth flow; only documents local runner expectations.',
    timeout: 'Returns immediately from local help data.',
    outputCap: 'Structured help payload is compact local metadata.',
    recursion: 'Safe to call during planning because it does not recurse into other agents.',
  },
];
const EXPOSE_RESOURCES = process.env.QE_MCP_EXPOSE_RESOURCES === '1';
const EXPOSE_PROMPTS = process.env.QE_MCP_EXPOSE_PROMPTS === '1';

function initializeCapabilities() {
  return {
    tools: {},
    ...(EXPOSE_RESOURCES ? { resources: {} } : {}),
    ...(EXPOSE_PROMPTS ? { prompts: {} } : {}),
  };
}

// Detects optional runner helper absence without hiding real import failures.
function isMissingOptionalModule(error, specifier) {
  return (
    error?.code === 'ERR_MODULE_NOT_FOUND' &&
    String(error.message || '').includes(specifier.split('/').pop())
  );
}

// Loads active runner helpers only when their local modules are present.
async function loadOptionalAgentHelpers() {
  const helpers = {};
  const optionalModules = [
    ['runCodexAgent', './lib/codex_runner.mjs'],
    ['runClaudeAgent', './lib/claude_runner.mjs'],
    ['runDelegateAgent', './lib/delegate_runner.mjs'],
    ['getCrossAgentHelp', './lib/cross_agent_help.mjs'],
    ['buildToolSchemas', './lib/agent_runner_contract.mjs'],
  ];

  for (const [exportName, specifier] of optionalModules) {
    try {
      const module = await import(specifier);
      if (typeof module[exportName] === 'function') {
        helpers[exportName] = module[exportName];
      }
    } catch (error) {
      if (!isMissingOptionalModule(error, specifier)) {
        throw error;
      }
    }
  }

  return helpers;
}

const optionalAgentHelpers = await loadOptionalAgentHelpers();

// Resolves active runner MCP schemas with a static fallback.
function getAgentToolSchemas() {
  if (typeof optionalAgentHelpers.buildToolSchemas !== 'function') {
    return FALLBACK_AGENT_TOOL_SCHEMAS;
  }

  try {
    const helperSchemas = optionalAgentHelpers.buildToolSchemas();
    if (!helperSchemas || typeof helperSchemas !== 'object') {
      return FALLBACK_AGENT_TOOL_SCHEMAS;
    }
    return {
      ...FALLBACK_AGENT_TOOL_SCHEMAS,
      qe_run_codex_agent:
        helperSchemas.qe_run_codex_agent || helperSchemas.codex || FALLBACK_AGENT_TOOL_SCHEMAS.qe_run_codex_agent,
      qe_run_claude_agent:
        helperSchemas.qe_run_claude_agent || helperSchemas.claude || FALLBACK_AGENT_TOOL_SCHEMAS.qe_run_claude_agent,
      qe_cross_agent_help:
        helperSchemas.qe_cross_agent_help || helperSchemas.help || FALLBACK_AGENT_TOOL_SCHEMAS.qe_cross_agent_help,
      qe_delegate_agent:
        helperSchemas.qe_delegate_agent || helperSchemas.delegate || FALLBACK_AGENT_TOOL_SCHEMAS.qe_delegate_agent,
      qe_agent_run_status:
        helperSchemas.qe_agent_run_status || helperSchemas.status || FALLBACK_AGENT_TOOL_SCHEMAS.qe_agent_run_status,
      qe_agent_run_read:
        helperSchemas.qe_agent_run_read || helperSchemas.read || FALLBACK_AGENT_TOOL_SCHEMAS.qe_agent_run_read,
    };
  } catch {
    return FALLBACK_AGENT_TOOL_SCHEMAS;
  }
}

// Normalizes passive cross-agent help payloads for MCP structuredContent.
function buildCrossAgentHelpPayload(payload) {
  const normalizedPayload =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : { overview: 'Local cross-agent runner contracts for Codex and Claude.' };

  const tools = Array.isArray(normalizedPayload.tools)
    ? normalizedPayload.tools
    : normalizedPayload.tools && typeof normalizedPayload.tools === 'object'
      ? Object.entries(normalizedPayload.tools).map(([name, value]) => ({ name, ...value }))
      : AGENT_TOOL_HELP;
  const notes = Array.isArray(normalizedPayload.notes)
    ? normalizedPayload.notes
    : [
        'qe_cross_agent_help is passive and never launches agent runners.',
        'Use qe_run_codex_agent or qe_run_claude_agent only when explicit bounded local CLI execution is required.',
      ];

  return {
    ...normalizedPayload,
    launchesAgentRunners: false,
    tools,
    notes,
  };
}

// Validates required string fields before active runner dispatch.
function requireNonEmptyString(value, fieldName, toolName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${toolName} requires a non-empty "${fieldName}" string`);
  }
  return value.trim();
}

// Converts legacy task input into prompt input for runner tools.
function normalizeRunnerArgs(toolName, args = {}) {
  const prompt = args.prompt ?? args.task;
  return {
    ...args,
    prompt: requireNonEmptyString(prompt, 'prompt', toolName),
  };
}

// Dispatches active runner calls through optional local helpers.
async function callRunnerTool(toolName, runner, args, engineOverride = null) {
  if (typeof runner !== 'function') {
    throw new Error(`${toolName} is unavailable because its local runner helper is not present`);
  }
  const engine = engineOverride || (toolName.includes('codex') ? 'codex' : 'claude');
  if (activeRunnerCount >= 1) {
    return toolResponse({
      engine,
      status: 'error',
      summary: 'active runner limit reached',
      output: '',
      events: [],
      metadata: {
        cwd: null,
        model: args.model || null,
        duration_ms: 0,
        exit_code: null,
        signal: null,
        call_depth: args.call_depth || 0,
        call_chain_id: args.call_chain_id || '',
        origin_engine: args.origin_engine || 'unknown',
        lifecycle: { cleanup_status: 'not_started' },
      },
      normalization: {
        output_format: args.output_mode || 'unknown',
        normalization_status: 'empty',
        truncated: false,
        stdout_bytes: 0,
        stderr_bytes: 0,
        parse_error: null,
        raw_capture_policy: 'preview-only',
      },
      error: {
        category: 'budget_exceeded',
        message: 'only one active runner call is allowed per server process',
        retryable: true,
      },
    });
  }
  activeRunnerCount += 1;
  try {
    return toolResponse(await runner(args));
  } finally {
    activeRunnerCount -= 1;
  }
}

function normalizeDelegateArgs(args = {}) {
  const targetEngine = args.target_engine || args.engine;
  if (targetEngine !== 'codex' && targetEngine !== 'claude') {
    return {
      targetEngine,
      runner: null,
      args: {
        ...args,
        engine: targetEngine,
      },
      error: {
        category: 'policy_denied',
        message: 'target_engine must be codex or claude',
        retryable: false,
      },
    };
  }
  const policy = args.policy && typeof args.policy === 'object' ? args.policy : {};
  const outputContract = args.output_contract && typeof args.output_contract === 'object' ? args.output_contract : {};
  return {
    targetEngine,
    runner: targetEngine === 'codex' ? optionalAgentHelpers.runCodexAgent : optionalAgentHelpers.runClaudeAgent,
    args: {
      ...args,
      ...policy,
      ...outputContract,
      engine: targetEngine,
      origin_engine: args.origin_engine || 'mcp',
      intent: args.intent || 'generic-delegation',
    },
    error: null,
  };
}

function delegateErrorResponse(args, error) {
  const engine = args.target_engine || args.engine || 'unknown';
  return toolResponse({
    engine,
    status: 'error',
    summary: error.message,
    output: '',
    events: [],
    metadata: {
      cwd: args.cwd || null,
      model: args.model || null,
      duration_ms: 0,
      exit_code: null,
      signal: null,
      call_depth: args.call_depth || 0,
      call_chain_id: args.call_chain_id || '',
      origin_engine: args.origin_engine || 'mcp',
      target_engine: engine,
      delegation_direction: `${args.origin_engine || 'mcp'}->${engine}`,
      lifecycle: { cleanup_status: 'not_started', run_id: null, state_path: null, record_path: null, status: 'denied' },
    },
    normalization: {
      output_format: args.output_mode || 'unknown',
      normalization_status: 'empty',
      truncated: false,
      stdout_bytes: 0,
      stderr_bytes: 0,
      parse_error: null,
      raw_capture_policy: 'metadata_only',
    },
    error,
  });
}

// Returns all passive expert tools plus opt-in runner tools.
function listTools() {
  const agentToolSchemas = getAgentToolSchemas();
  return [
    {
      name: 'qe_search_experts',
      description: 'Search passive QE expert-library skills and methodologies by compact metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          domain: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          includeDeprecated: { type: 'boolean' },
        },
      },
    },
    {
      name: 'qe_recommend_expert',
      description: 'Recommend QE experts for a task without loading full expert content.',
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string' },
          client: { type: 'string' },
          maxRecommendations: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
    {
      name: 'qe_read_expert',
      description:
        'Read one QE expert by name. Does not accept raw file paths. With format:"prompt" it returns a bounded prompt payload that applies the expert to a task (task/mode apply here).',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          includeReferences: { type: 'boolean' },
          maxBytes: { type: 'integer', minimum: 200, maximum: 24000 },
          format: { type: 'string', enum: ['raw', 'prompt'] },
          task: { type: 'string' },
          mode: { type: 'string', enum: ['apply', 'review', 'plan'] },
        },
      },
    },
    {
      name: 'qe_read_methodology',
      description: 'Read a bounded methodology/reference document attached to a named QE expert.',
      inputSchema: {
        type: 'object',
        required: ['expert', 'reference'],
        properties: {
          expert: { type: 'string' },
          reference: { type: 'string' },
          maxBytes: { type: 'integer', minimum: 200, maximum: 24000 },
        },
      },
    },
    {
      name: 'qe_run_codex_agent',
      description:
        'Run a bounded local Codex CLI subprocess. Side effects: default read-only; writes require allow_writes and workspace-write. Auth: uses existing local Codex CLI/session auth. Timeout/output: bounded by timeout_ms and max_output_bytes. Recursion and child MCP config inheritance are blocked by default.',
      inputSchema: agentToolSchemas.qe_run_codex_agent,
    },
    {
      name: 'qe_run_claude_agent',
      description:
        'Run a bounded local Claude CLI subprocess. Side effects: permission_mode is fixed to plan with restricted tools. Auth: uses existing local Claude CLI/session auth. Timeout/output: bounded by timeout_ms and max_output_bytes. Recursion and child MCP config inheritance are blocked by default.',
      inputSchema: agentToolSchemas.qe_run_claude_agent,
    },
    {
      name: 'qe_cross_agent_help',
      description:
        'Return passive bounded-runner help. Side effects: none. Auth: none beyond local runner expectations. Timeout: immediate local response. Output cap: compact structured help only. Recursion: safe because this tool never launches runners.',
      inputSchema: agentToolSchemas.qe_cross_agent_help,
    },
    {
      name: 'qe_delegate_agent',
      description:
        'Run a bounded generic delegation through the internal engine route. Side effects: may launch the selected local Codex or Claude CLI. Auth: existing local CLI/session auth only. Timeout/output: bounded by the runner contract. Recursion, child MCP config inheritance, concurrent fan-out, and unsafe writes are denied by default.',
      inputSchema: agentToolSchemas.qe_delegate_agent,
    },
    {
      name: 'qe_agent_run_status',
      description:
        'Read compact lifecycle status for a delegated run by run_id. Side effects: none. Returns redacted metadata only; no raw prompt/stdout/stderr or arbitrary file paths.',
      inputSchema: agentToolSchemas.qe_agent_run_status,
    },
    {
      name: 'qe_agent_run_read',
      description:
        'Read a bounded redacted lifecycle projection for a delegated run by run_id. Side effects: none. Returns direction, decision, transitions, and compact output metadata only.',
      inputSchema: agentToolSchemas.qe_agent_run_read,
    },
  ];
}

// Wraps plain payloads into MCP text and structured responses.
function toolResponse(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    structuredContent: typeof payload === 'string' ? { text: payload } : payload,
  };
}

// Handles MCP tool calls and routes each name to its implementation.
async function callTool(name, args = {}) {
  if (name === 'qe_search_experts') {
    return toolResponse(searchExperts(args));
  }

  if (name === 'qe_recommend_expert') {
    return toolResponse(recommendExpert(args));
  }

  if (name === 'qe_read_expert') {
    if (args.format === 'prompt') {
      return toolResponse(
        buildExpertPrompt({ expert: args.name, task: args.task, mode: args.mode, maxBytes: args.maxBytes }),
      );
    }
    return toolResponse(readExpert(args));
  }

  if (name === 'qe_read_methodology') {
    return toolResponse(readMethodology(args));
  }

  if (name === 'qe_run_codex_agent') {
    return callRunnerTool(name, optionalAgentHelpers.runCodexAgent, args);
  }

  if (name === 'qe_run_claude_agent') {
    return callRunnerTool(name, optionalAgentHelpers.runClaudeAgent, args);
  }

  if (name === 'qe_cross_agent_help') {
    const payload =
      typeof optionalAgentHelpers.getCrossAgentHelp === 'function'
        ? await optionalAgentHelpers.getCrossAgentHelp()
        : null;
    return toolResponse(buildCrossAgentHelpPayload(payload));
  }

  if (name === 'qe_delegate_agent') {
    const normalized = normalizeDelegateArgs(args);
    if (normalized.error) {
      return delegateErrorResponse(args, normalized.error);
    }
    const runner = optionalAgentHelpers.runDelegateAgent || normalized.runner;
    const runnerArgs = optionalAgentHelpers.runDelegateAgent ? args : normalized.args;
    return callRunnerTool(name, runner, runnerArgs, normalized.targetEngine);
  }

  if (name === 'qe_agent_run_status') {
    const projection = await getAgentRunProjection(requireNonEmptyString(args.run_id, 'run_id', name), {
      includeTransitions: false,
    });
    return toolResponse(projection);
  }

  if (name === 'qe_agent_run_read') {
    const projection = await getAgentRunProjection(requireNonEmptyString(args.run_id, 'run_id', name), {
      includeTransitions: args.include_transitions !== false,
    });
    return toolResponse(projection);
  }

  throw new Error(`Unsupported tool: ${name}`);
}

// Lists prompt templates exposed by the passive expert library.
function listPrompts() {
  return [
    {
      name: 'qe-use-expert',
      description: 'Load a QE expert and apply it to the current task.',
      arguments: [
        { name: 'expert', required: true },
        { name: 'task', required: false },
      ],
    },
    {
      name: 'qe-review-with-expert',
      description: 'Review an artifact or plan through a QE expert lens.',
      arguments: [
        { name: 'expert', required: true },
        { name: 'task', required: false },
      ],
    },
    {
      name: 'qe-plan-with-expert',
      description: 'Create a bounded plan using a QE expert.',
      arguments: [
        { name: 'expert', required: true },
        { name: 'task', required: false },
      ],
    },
  ];
}

// Builds prompt responses from the expert-library prompt helpers.
function getPrompt(name, args = {}) {
  if (name === 'qe-use-expert') {
    return buildExpertPrompt({ expert: args.expert, task: args.task, mode: 'apply' });
  }
  if (name === 'qe-review-with-expert') {
    return buildExpertPrompt({ expert: args.expert, task: args.task, mode: 'review' });
  }
  if (name === 'qe-plan-with-expert') {
    return buildExpertPrompt({ expert: args.expert, task: args.task, mode: 'plan' });
  }
  throw new Error(`Unsupported prompt: ${name}`);
}

// Writes a JSON-RPC message using the same stdio framing family as the client.
let outputFraming = 'content-length';

function sendMessage(message) {
  const json = JSON.stringify(message);
  if (outputFraming === 'json-line') {
    process.stdout.write(`${json}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

// Sends a successful JSON-RPC response.
function sendResponse(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

// Sends a JSON-RPC error response without leaking stack traces.
function sendError(id, error) {
  sendMessage({
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32000,
      message: error.message || String(error),
    },
  });
}

// Dispatches incoming JSON-RPC requests from the MCP client.
async function handleRequest(message) {
  const { id, method, params = {} } = message;

  try {
    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: initializeCapabilities(),
        serverInfo: {
          name: 'qe-expert-library',
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (method === 'notifications/initialized') {
      return;
    }

    if (method === 'ping') {
      sendResponse(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResponse(id, { tools: listTools() });
      return;
    }

    if (method === 'tools/call') {
      sendResponse(id, await callTool(params.name, params.arguments || {}));
      return;
    }

    if (method === 'resources/list') {
      sendResponse(id, { resources: listExpertResources() });
      return;
    }

    if (method === 'resources/read') {
      sendResponse(id, readExpertResource(params.uri));
      return;
    }

    if (method === 'prompts/list') {
      sendResponse(id, { prompts: listPrompts() });
      return;
    }

    if (method === 'prompts/get') {
      sendResponse(id, getPrompt(params.name, params.arguments || {}));
      return;
    }

    throw new Error(`Unsupported method: ${method}`);
  } catch (error) {
    if (id !== undefined) {
      sendError(id, error);
    }
  }
}

function parseAndHandleRequest(payload) {
  try {
    void handleRequest(JSON.parse(payload));
  } catch (error) {
    sendError(null, error);
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    if (!buffer.toString('utf8', 0, Math.min(buffer.length, 32)).startsWith('Content-Length:')) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).toString('utf8').trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      outputFraming = 'json-line';
      parseAndHandleRequest(line);
      continue;
    }

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const bodyLength = Number(lengthMatch[1]);
    const totalLength = headerEnd + 4 + bodyLength;
    if (buffer.length < totalLength) return;

    const body = buffer.slice(headerEnd + 4, totalLength).toString('utf8');
    buffer = buffer.slice(totalLength);

    outputFraming = 'content-length';
    parseAndHandleRequest(body);
  }
});
