// openai_compat_runner.mjs — bounded runner for a generic OpenAI-compatible endpoint.
// This module is now an opt-in, experiment-only MCP tool (qe_run_openai_compat_agent),
// env-gated via QE_OPENAI_COMPAT_BASE_URL. The 10-task benchmark (G042) that previously
// gated this integration was DROPPED per DECISION_LOG D014: claude+codex already provide
// cross-model independence; a Fugu-as-default benchmark contradicts QE philosophy.
//
// Trust boundary (inherited from the QE runner contract):
//   - API key is ENV-ONLY. Passing a key in args is refused (policy_denied).
//   - The key is never logged and never appears in the returned result.
//   - Missing endpoint -> not_installed; missing key -> auth_missing.
//   - The network call is injectable (fetchImpl) so the boundary is unit-testable
//     without a live endpoint and live-callable when the env is configured.

import { makeRunnerError } from './agent_runner_contract.mjs';

export const ENDPOINT_ENV = 'QE_OPENAI_COMPAT_BASE_URL';
export const KEY_ENV = 'QE_OPENAI_COMPAT_API_KEY';
export const MODEL_ENV = 'QE_OPENAI_COMPAT_MODEL';

const KEY_ARG_FIELDS = ['api_key', 'apiKey', 'key', 'authorization', 'token'];

/** Clamps a string to maxBytes UTF-8 bytes, returning the clamped string. */
function clampBytes(str, maxBytes) {
  const buf = Buffer.from(String(str), 'utf8');
  return buf.length <= maxBytes ? String(str) : buf.subarray(0, maxBytes).toString('utf8');
}

/**
 * Single choke-point for all result envelopes returned by this runner.
 * Every return path (success and all errorResult branches) passes through here
 * to guarantee full envelope parity with sibling runners (codex/claude).
 * Fields: engine, status, summary, output, events, metadata, normalization, error.
 * Network-meaningless metadata fields (cwd, exit_code, signal) are set to null.
 */
function normalizeEnvelope(partial) {
  const output = typeof partial.output === 'string' ? partial.output : '';
  const truncated = Boolean(partial.metadata?.truncated ?? false);
  return {
    engine: partial.engine ?? 'openai-compat',
    status: partial.status ?? 'error',
    summary: partial.summary ?? '',
    output,
    events: [],
    metadata: {
      cwd: null,
      model: partial.metadata?.model ?? null,
      duration_ms: partial.metadata?.duration_ms ?? 0,
      exit_code: null,
      signal: null,
      vendor: partial.metadata?.vendor ?? 'openai-compat',
      truncated,
    },
    normalization: {
      output_format: 'text',
      truncated,
      stdout_bytes: Buffer.byteLength(output, 'utf8'),
      stderr_bytes: 0,
    },
    error: partial.error ?? null,
  };
}

/** Builds a structured error result for all non-success branches. */
function errorResult(category, message) {
  return normalizeEnvelope({
    engine: 'openai-compat',
    status: 'error',
    summary: '',
    output: '',
    error: makeRunnerError(category, message),
    metadata: { vendor: 'openai-compat' },
  });
}

/**
 * Resolves endpoint/key/model from the environment only.
 * Returns `{ ok: true, config }` on success or `{ ok: false, result }` with a
 * structured error envelope on any policy/auth/config failure.
 * Args-supplied key fields are always rejected (policy_denied) before any other check.
 */
export function resolveConfig(args = {}, env = process.env) {
  for (const field of KEY_ARG_FIELDS) {
    if (args[field] != null) {
      return { ok: false, result: errorResult('policy_denied', `API key must come from ${KEY_ENV}, not the "${field}" argument`) };
    }
  }
  const baseUrl = env[ENDPOINT_ENV];
  if (!baseUrl) return { ok: false, result: errorResult('not_installed', `no OpenAI-compatible endpoint configured (set ${ENDPOINT_ENV})`) };
  // Require https so the Bearer key is never sent in cleartext (localhost exempt for dev).
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(baseUrl);
  if (!/^https:\/\//i.test(baseUrl) && !isLocal) {
    return { ok: false, result: errorResult('policy_denied', `endpoint must use https:// (got a non-TLS URL); refusing to send the API key in cleartext`) };
  }
  const apiKey = env[KEY_ENV];
  if (!apiKey) return { ok: false, result: errorResult('auth_missing', `no API key configured (set ${KEY_ENV})`) };
  const model = args.model || env[MODEL_ENV];
  if (!model) return { ok: false, result: errorResult('policy_denied', `no model specified (arg.model or ${MODEL_ENV})`) };
  return { ok: true, config: { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model } };
}

/**
 * Run one bounded chat completion against an OpenAI-compatible endpoint.
 * The key is read from env, sent only in the Authorization header, and never
 * logged or returned. Returns a full AgentRunResult-shaped envelope via normalizeEnvelope.
 */
export async function runOpenAiCompatAgent(args = {}, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 60000, 1000), 120000);
  const maxBytes = Math.min(Math.max(Number(args.max_output_bytes) || 24000, 200), 24000);

  const prompt = args.prompt || args.task;
  if (!prompt || typeof prompt !== 'string') return errorResult('policy_denied', 'prompt is required');

  const resolved = resolveConfig(args, env);
  if (!resolved.ok) return resolved.result;
  const { baseUrl, apiKey, model } = resolved.config;

  if (typeof fetchImpl !== 'function') return errorResult('not_installed', 'no fetch implementation available (Node < 18 without a fetch polyfill)');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      // Authorization is the ONLY place the key appears; never logged.
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') return errorResult('timeout', `request exceeded ${timeoutMs}ms`);
    return errorResult('nonzero_exit', `request failed: ${err && err.message ? err.message : 'unknown error'}`);
  }
  clearTimeout(timer);

  if (!response || !response.ok) {
    const code = response ? response.status : 0;
    const category = code === 401 || code === 403 ? 'auth_missing' : code === 429 ? 'budget_exceeded' : 'nonzero_exit';
    return errorResult(category, `endpoint returned HTTP ${code}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return errorResult('malformed_output', 'response was not valid JSON');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return errorResult('malformed_output', 'response missing choices[0].message.content');

  const output = clampBytes(content, maxBytes);
  const wasTruncated = Buffer.byteLength(output, 'utf8') < Buffer.byteLength(content, 'utf8');
  return normalizeEnvelope({
    engine: 'openai-compat',
    status: 'ok',
    summary: output.split('\n', 1)[0].slice(0, 200),
    output,
    error: null,
    metadata: { vendor: 'openai-compat', model, truncated: wasTruncated },
  });
}
