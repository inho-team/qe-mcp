import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOpenAiCompatAgent, resolveConfig, ENDPOINT_ENV, KEY_ENV } from '../openai_compat_runner.mjs';

const GOOD_ENV = { [ENDPOINT_ENV]: 'https://fugu.example/v1', [KEY_ENV]: 'SECRET_KEY_VALUE', QE_OPENAI_COMPAT_MODEL: 'fugu-1' };

function fakeFetch(payload, { ok = true, status = 200, throwErr = null } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return { ok, status, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

test('key passed as an argument is refused (env-only trust boundary)', async () => {
  for (const field of ['api_key', 'apiKey', 'key', 'authorization', 'token']) {
    const r = await runOpenAiCompatAgent({ prompt: 'hi', [field]: 'x' }, { env: GOOD_ENV, fetchImpl: fakeFetch({}) });
    assert.equal(r.status, 'error');
    assert.equal(r.error.category, 'policy_denied');
  }
});

test('missing endpoint -> not_installed; missing key -> auth_missing', async () => {
  const noEp = await runOpenAiCompatAgent({ prompt: 'hi' }, { env: {}, fetchImpl: fakeFetch({}) });
  assert.equal(noEp.error.category, 'not_installed');
  const noKey = await runOpenAiCompatAgent({ prompt: 'hi' }, { env: { [ENDPOINT_ENV]: 'https://x/v1', QE_OPENAI_COMPAT_MODEL: 'm' }, fetchImpl: fakeFetch({}) });
  assert.equal(noKey.error.category, 'auth_missing');
});

test('the API key is never present in the returned result', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'the answer' } }] });
  const r = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl });
  assert.equal(r.status, 'ok');
  assert.doesNotMatch(JSON.stringify(r), /SECRET_KEY_VALUE/);
  // but the key IS sent in the Authorization header only
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer SECRET_KEY_VALUE');
});

test('success path returns an AgentRunResult-shaped ok result', async () => {
  const r = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl: fakeFetch({ choices: [{ message: { content: 'line1\nline2' } }] }) });
  assert.equal(r.engine, 'openai-compat');
  assert.equal(r.status, 'ok');
  assert.equal(r.summary, 'line1');
  assert.equal(r.metadata.model, 'fugu-1');
});

test('malformed response -> malformed_output', async () => {
  const r = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl: fakeFetch({ nope: true }) });
  assert.equal(r.error.category, 'malformed_output');
});

test('HTTP 401 -> auth_missing; 429 -> budget_exceeded', async () => {
  const r401 = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl: fakeFetch({}, { ok: false, status: 401 }) });
  assert.equal(r401.error.category, 'auth_missing');
  const r429 = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl: fakeFetch({}, { ok: false, status: 429 }) });
  assert.equal(r429.error.category, 'budget_exceeded');
});

test('missing prompt -> policy_denied', async () => {
  const r = await runOpenAiCompatAgent({}, { env: GOOD_ENV, fetchImpl: fakeFetch({}) });
  assert.equal(r.error.category, 'policy_denied');
});

test('non-https endpoint is refused (cleartext key hazard); localhost exempt', () => {
  const http = resolveConfig({}, { [ENDPOINT_ENV]: 'http://fugu.example/v1', [KEY_ENV]: 'k', QE_OPENAI_COMPAT_MODEL: 'm' });
  assert.equal(http.ok, false);
  assert.equal(http.result.error.category, 'policy_denied');
  const https = resolveConfig({}, { [ENDPOINT_ENV]: 'https://fugu.example/v1', [KEY_ENV]: 'k', QE_OPENAI_COMPAT_MODEL: 'm' });
  assert.equal(https.ok, true);
  const local = resolveConfig({}, { [ENDPOINT_ENV]: 'http://localhost:1234/v1', [KEY_ENV]: 'k', QE_OPENAI_COMPAT_MODEL: 'm' });
  assert.equal(local.ok, true);
});

test('resolveConfig strips trailing slash from base url', () => {
  const r = resolveConfig({}, { [ENDPOINT_ENV]: 'https://x/v1///', [KEY_ENV]: 'k', QE_OPENAI_COMPAT_MODEL: 'm' });
  assert.equal(r.ok, true);
  assert.equal(r.config.baseUrl, 'https://x/v1');
});

// --- P7 W2 / D014: envelope parity, full branch order, key-leak hardening ---

// Asserts a result carries the full AgentRunResult envelope (parity with codex/claude).
function assertFullEnvelope(r) {
  for (const f of ['engine', 'status', 'summary', 'output', 'events', 'metadata', 'normalization', 'error']) {
    assert.ok(f in r, `envelope missing field: ${f}`);
  }
  assert.deepEqual(r.events, []);
  assert.equal(r.normalization.output_format, 'text');
  assert.equal(typeof r.normalization.truncated, 'boolean');
  assert.equal(typeof r.normalization.stdout_bytes, 'number');
  assert.equal(r.normalization.stderr_bytes, 0);
  // Network-meaningless CLI metadata is null, never fabricated.
  assert.equal(r.metadata.cwd, null);
  assert.equal(r.metadata.exit_code, null);
  assert.equal(r.metadata.signal, null);
  // Single source of truth for truncation.
  assert.equal(r.metadata.truncated, r.normalization.truncated);
}

test('envelope parity: success path carries events + normalization', async () => {
  const r = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl: fakeFetch({ choices: [{ message: { content: 'hello' } }] }) });
  assert.equal(r.status, 'ok');
  assertFullEnvelope(r);
  assert.equal(r.normalization.stdout_bytes, Buffer.byteLength('hello', 'utf8'));
});

test('envelope parity: error branches carry events + normalization', async () => {
  const notInstalled = await runOpenAiCompatAgent({ prompt: 'q' }, { env: {}, fetchImpl: fakeFetch({}) });
  assertFullEnvelope(notInstalled);
  const malformed = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl: fakeFetch({ nope: true }) });
  assertFullEnvelope(malformed);
});

test('resolveConfig 5-branch order (arg-key precedence over not_installed)', () => {
  // 1. arg-supplied key is refused BEFORE the baseUrl check, even with an empty env.
  const argKey = resolveConfig({ api_key: 'x' }, {});
  assert.equal(argKey.ok, false);
  assert.equal(argKey.result.error.category, 'policy_denied');
  // 2. missing baseUrl -> not_installed
  assert.equal(resolveConfig({}, {}).result.error.category, 'not_installed');
  // 3. baseUrl set, missing key -> auth_missing
  assert.equal(resolveConfig({}, { [ENDPOINT_ENV]: 'https://x/v1', QE_OPENAI_COMPAT_MODEL: 'm' }).result.error.category, 'auth_missing');
  // 4. baseUrl + key set, missing model -> policy_denied
  assert.equal(resolveConfig({}, { [ENDPOINT_ENV]: 'https://x/v1', [KEY_ENV]: 'k' }).result.error.category, 'policy_denied');
  // 5. non-https non-localhost -> policy_denied
  assert.equal(resolveConfig({}, { [ENDPOINT_ENV]: 'http://x/v1', [KEY_ENV]: 'k', QE_OPENAI_COMPAT_MODEL: 'm' }).result.error.category, 'policy_denied');
});

test('key never leaks on any post-Authorization failure branch', async () => {
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  const branches = [
    ['timeout', fakeFetch({}, { throwErr: abortErr })],
    ['nonzero_exit', fakeFetch({}, { throwErr: new Error('connection reset') })],
    ['auth_missing', fakeFetch({}, { ok: false, status: 401 })],
    ['auth_missing', fakeFetch({}, { ok: false, status: 403 })],
    ['malformed_output', fakeFetch({ nope: true })],
  ];
  for (const [expectedCategory, fetchImpl] of branches) {
    const r = await runOpenAiCompatAgent({ prompt: 'q' }, { env: GOOD_ENV, fetchImpl });
    assert.equal(r.error.category, expectedCategory);
    // The key is placed in the Authorization header BEFORE these branches fire;
    // assert it never surfaces anywhere in the whole returned envelope.
    assert.doesNotMatch(JSON.stringify(r), /SECRET_KEY_VALUE/);
  }
});
