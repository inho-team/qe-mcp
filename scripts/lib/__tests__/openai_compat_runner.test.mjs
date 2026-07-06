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
