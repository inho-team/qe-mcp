#!/usr/bin/env node

import {
  buildExpertPrompt,
  listExpertPacks,
  listExpertResources,
  readExpert,
  readExpertResource,
  readMethodology,
  recommendExpert,
  searchExperts,
} from './lib/qe_expert_library.mjs';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_VERSION = '0.1.0';

function listTools() {
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
      description: 'Read one QE expert by name. Does not accept raw file paths.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          includeReferences: { type: 'boolean' },
          maxBytes: { type: 'integer', minimum: 200, maximum: 24000 },
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
      name: 'qe_expert_prompt',
      description: 'Build a bounded prompt payload that applies a named QE expert to a task.',
      inputSchema: {
        type: 'object',
        required: ['expert'],
        properties: {
          expert: { type: 'string' },
          task: { type: 'string' },
          mode: { type: 'string', enum: ['apply', 'review', 'plan'] },
          maxBytes: { type: 'integer', minimum: 200, maximum: 24000 },
        },
      },
    },
    {
      name: 'qe_expert_library_help',
      description: 'Return a compact help payload for the QE expert-library MCP server.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

function toolResponse(payload) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: typeof payload === 'string' ? { text: payload } : payload,
  };
}

function callTool(name, args = {}) {
  if (name === 'qe_search_experts') {
    return toolResponse(searchExperts(args));
  }

  if (name === 'qe_recommend_expert') {
    return toolResponse(recommendExpert(args));
  }

  if (name === 'qe_read_expert') {
    return toolResponse(readExpert(args));
  }

  if (name === 'qe_read_methodology') {
    return toolResponse(readMethodology(args));
  }

  if (name === 'qe_expert_prompt') {
    return toolResponse(buildExpertPrompt(args));
  }

  if (name === 'qe_expert_library_help') {
    return toolResponse({
      workflow: ['qe_search_experts', 'qe_recommend_expert', 'qe_read_expert or qe_expert_prompt'],
      resources: ['qe://experts/catalog', 'qe://experts/<name>', 'qe://expert-packs/<pack>'],
      prompts: ['qe-use-expert', 'qe-review-with-expert', 'qe-plan-with-expert'],
      packs: listExpertPacks().packs,
      note: 'This server exposes passive local expert guidance. Verify current APIs before implementation.',
    });
  }

  throw new Error(`Unsupported tool: ${name}`);
}

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

function sendMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, error) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error.message || String(error),
    },
  });
}

function handleRequest(message) {
  const { id, method, params = {} } = message;

  try {
    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
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
      sendResponse(id, callTool(params.name, params.arguments || {}));
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

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
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

    handleRequest(JSON.parse(body));
  }
});
