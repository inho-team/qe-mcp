import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeAgentRunRequest,
  policyDenied as contractPolicyDenied,
  resolveAllowedCwd as resolveContractAllowedCwd,
} from './agent_runner_contract.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = realpathSync(resolve(MODULE_DIR, '..', '..'));

export const OUTPUT_FORMATS = new Set(['text', 'json', 'jsonl', 'stream-json', 'unknown']);
export const NORMALIZATION_STATUSES = new Set(['parsed', 'partial', 'malformed', 'truncated', 'empty']);
export const ERROR_CATEGORIES = new Set([
  'not_installed',
  'auth_missing',
  'permission_denied',
  'mcp_config_rejected',
  'timeout',
  'prompt_stalled',
  'nonzero_exit',
  'malformed_output',
  'policy_denied',
  'recursion_blocked',
  'budget_exceeded',
]);

export const DEFAULTS = {
  timeout_ms: 60000,
  max_output_bytes: 24000,
  max_budget_usd: 0.05,
  max_concurrent_runs: 1,
  max_depth: 1,
  help_timeout_ms: 3000,
  help_max_bytes: 12000,
  help_freshness_hours: 24,
};

const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  '__CF_USER_TEXT_ENCODING',
]);

const ENV_DENY_PATTERNS = [
  'TOKEN',
  'KEY',
  'SECRET',
  'PASSWORD',
  'AUTH',
  'COOKIE',
  'MCP',
  'CLAUDE',
  'CODEX',
  'OPENAI',
  'ANTHROPIC',
];

// Measures UTF-8 payload size for local capture budgets.
function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

// Truncates text on UTF-8 character boundaries.
export function truncateUtf8(value, maxBytes) {
  const text = String(value || '');
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  let output = '';
  let bytes = 0;
  for (const char of text) {
    const next = Buffer.byteLength(char, 'utf8');
    if (bytes + next > maxBytes) break;
    output += char;
    bytes += next;
  }
  return { text: output, truncated: true };
}

// Builds a small child-process environment without auth or MCP secrets.
export function sanitizeEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (!ENV_ALLOWLIST.has(key)) continue;
    if (ENV_DENY_PATTERNS.some((pattern) => key.toUpperCase().includes(pattern))) continue;
    if (typeof value === 'string') env[key] = value;
  }
  if (!env.PATH && source.PATH) env.PATH = source.PATH;
  return env;
}

// Exposes the secret-key deny policy for tests and diagnostics.
export function isDeniedEnvKey(key) {
  return ENV_DENY_PATTERNS.some((pattern) => String(key).toUpperCase().includes(pattern));
}

// Resolves and verifies that runner cwd stays inside approved roots.
export function resolveAllowedCwd(cwd = REPO_ROOT, allowedRoots = [REPO_ROOT]) {
  return resolveContractAllowedCwd(cwd || REPO_ROOT, allowedRoots);
}

// Creates a policy-denied error with the runner taxonomy category.
export function policyError(message) {
  return contractPolicyDenied(message);
}

// Normalizes caller output mode without widening the allowed parser surface.
function normalizeOutputMode(mode, fallback = 'json') {
  const value = String(mode || fallback);
  return OUTPUT_FORMATS.has(value) && value !== 'unknown' ? value : fallback;
}

// Validates runner arguments and applies bounded execution defaults.
export function normalizeRequest(args = {}, engine) {
  const request = normalizeAgentRunRequest(
    { ...args, engine },
    { engine, allowedRoots: [REPO_ROOT] }
  );
  return {
    ...request,
    // Keep parser fallback behavior explicit for callers that pass unknown modes.
    output_mode: normalizeOutputMode(request.output_mode, engine === 'codex' ? 'jsonl' : 'json'),
  };
}

// Builds the normalized result envelope returned by runner tools.
export function makeAgentRunResult({
  engine,
  request = {},
  status = 'error',
  summary = '',
  output = '',
  events = [],
  metadata = {},
  normalization = {},
  error = null,
}) {
  const result = {
    engine,
    status,
    summary,
    output,
    events: Array.isArray(events) ? events : [],
    metadata: {
      cwd: request.cwd || metadata.cwd || '',
      model: request.model || metadata.model || null,
      duration_ms: metadata.duration_ms || 0,
      exit_code: metadata.exit_code ?? null,
      signal: metadata.signal ?? null,
      call_depth: request.call_depth ?? metadata.call_depth ?? 0,
      call_chain_id: request.call_chain_id || metadata.call_chain_id || '',
      origin_engine: request.origin_engine || metadata.origin_engine || 'unknown',
      target_engine: metadata.target_engine || engine,
      delegation_direction: metadata.delegation_direction || `${request.origin_engine || metadata.origin_engine || 'unknown'}->${metadata.target_engine || engine}`,
      decision: metadata.decision || null,
      lifecycle: {
        cleanup_status: metadata.lifecycle?.cleanup_status || 'not_needed',
        run_id: metadata.lifecycle?.run_id || null,
        state_path: metadata.lifecycle?.state_path || null,
        record_path: metadata.lifecycle?.record_path || metadata.lifecycle?.state_path || null,
        status: metadata.lifecycle?.status || null,
      },
    },
    normalization: {
      output_format: normalization.output_format || request.output_mode || 'unknown',
      normalization_status: normalization.normalization_status || 'empty',
      truncated: normalization.truncated === true,
      stdout_bytes: normalization.stdout_bytes || 0,
      stderr_bytes: normalization.stderr_bytes || 0,
      parse_error: normalization.parse_error ?? null,
      raw_capture_policy: 'preview-only',
    },
  };
  if (error) result.error = normalizeError(error);
  return enforceAggregateBudget(result, request.max_output_bytes || DEFAULTS.max_output_bytes);
}

// Maps raw errors into the public runner error taxonomy.
export function normalizeError(error) {
  const category = ERROR_CATEGORIES.has(error?.category) ? error.category : 'nonzero_exit';
  return {
    category,
    message: error?.message || String(error || category),
    retryable: Boolean(error?.retryable ?? ['auth_missing', 'timeout', 'prompt_stalled', 'nonzero_exit', 'budget_exceeded'].includes(category)),
  };
}

// Classifies process output and exit state into runner error categories.
export function classifyProcessError({ code, signal, stdout, stderr, timedOut, parseError }) {
  const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
  if (timedOut) return { category: stdout || stderr ? 'timeout' : 'prompt_stalled', message: 'subprocess timed out' };
  if (/enoent|not found|no such file or directory|command not found/.test(text)) return { category: 'not_installed', message: 'runner command is not installed' };
  if (/max budget|budget exceeded|turn limit|local cap|output cap/.test(text)) return { category: 'budget_exceeded', message: 'runner budget or local cap exceeded' };
  if (
    /weekly limit|quota|not logged in|please run \/login/.test(text) ||
    /api_error_status["']?\s*:\s*(429|4\d\d|5\d\d)/.test(text)
  ) {
    return { category: 'auth_missing', message: 'provider auth/quota unavailable' };
  }
  if (/permission denied|not allowed/.test(text)) return { category: 'permission_denied', message: 'permission denied' };
  if (parseError) return { category: 'malformed_output', message: parseError };
  if (code !== 0 || signal) return { category: 'nonzero_exit', message: `subprocess exited with ${code ?? signal}` };
  return null;
}

// Parses text, JSON, and event-stream output into result fields.
export function parseOutput({ stdout = '', stderr = '', outputMode = 'text', exitCode = 0, timedOut = false, maxOutputBytes = DEFAULTS.max_output_bytes }) {
  const stdoutBytes = byteLength(stdout);
  const stderrBytes = byteLength(stderr);
  const previewBudget = Math.max(500, Math.floor(maxOutputBytes / 3));
  const stdoutPreview = truncateUtf8(stdout, previewBudget);
  const stderrPreview = truncateUtf8(stderr, Math.min(4000, previewBudget));
  let output = stdoutPreview.text;
  let summary = output ? output.split(/\r?\n/).find(Boolean) || '' : '';
  let events = [];
  let parseError = null;
  let normalizationStatus = output ? 'parsed' : 'empty';
  let format = outputMode === 'stream-json' ? 'stream-json' : outputMode;

  if (outputMode === 'json') {
    try {
      const parsed = stdout ? JSON.parse(stdout) : null;
      if (parsed && typeof parsed === 'object') {
        output = parsed.result || parsed.output || parsed.summary || JSON.stringify(parsed);
        summary = parsed.summary || parsed.result || output;
        if (parsed.is_error === true) {
          normalizationStatus = 'parsed';
        }
      } else {
        normalizationStatus = 'empty';
      }
    } catch (error) {
      parseError = error.message;
      normalizationStatus = stdout ? 'malformed' : 'empty';
    }
  } else if (outputMode === 'jsonl' || outputMode === 'stream-json') {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const bad = [];
    events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        bad.push(line);
      }
    }
    const resultEvent = [...events].reverse().find((item) => item.type === 'result' || item.summary || item.result);
    output = resultEvent?.result || resultEvent?.summary || stdoutPreview.text;
    summary = resultEvent?.summary || resultEvent?.result || output.split(/\r?\n/).find(Boolean) || '';
    if (bad.length > 0) {
      parseError = `${bad.length} malformed JSONL line(s) skipped`;
      normalizationStatus = events.length > 0 ? 'partial' : 'malformed';
    } else {
      normalizationStatus = events.length > 0 ? 'parsed' : 'empty';
    }
  }

  const truncated = stdoutPreview.truncated || stderrPreview.truncated || stdoutBytes + stderrBytes > maxOutputBytes;
  if (truncated && normalizationStatus === 'parsed') normalizationStatus = 'truncated';
  const processError = classifyProcessError({ code: exitCode, stdout, stderr, timedOut, parseError });

  return {
    status: timedOut ? 'timeout' : processError ? 'error' : 'ok',
    summary: truncateUtf8(summary, 1000).text,
    output: truncateUtf8(output, Math.max(500, Math.floor(maxOutputBytes / 2))).text,
    events: events.slice(0, 20),
    normalization: {
      output_format: OUTPUT_FORMATS.has(format) ? format : 'unknown',
      normalization_status: NORMALIZATION_STATUSES.has(normalizationStatus) ? normalizationStatus : 'partial',
      truncated,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      parse_error: parseError,
      raw_capture_policy: 'preview-only',
    },
    error: processError,
  };
}

// Shrinks result payloads until they fit the caller-visible output budget.
export function enforceAggregateBudget(result, maxBytes = DEFAULTS.max_output_bytes) {
  let next = result;
  if (byteLength(JSON.stringify(next)) <= maxBytes) return next;

  next = {
    ...next,
    summary: truncateUtf8(next.summary, 500).text,
    output: truncateUtf8(next.output, 1000).text,
    events: Array.isArray(next.events) ? next.events.slice(0, 5) : [],
    normalization: { ...next.normalization, truncated: true, normalization_status: 'truncated' },
  };
  if (next.error?.message) {
    next.error = { ...next.error, message: truncateUtf8(next.error.message, 500).text };
  }
  if (byteLength(JSON.stringify(next)) <= maxBytes) return next;
  return {
    ...next,
    output: truncateUtf8(next.output, 200).text,
    events: [],
    summary: truncateUtf8(next.summary, 200).text,
  };
}

// Runs a subprocess with shell disabled, bounded capture, and timeout cleanup.
export function runProcess(command, args, {
  cwd = REPO_ROOT,
  timeoutMs = DEFAULTS.timeout_ms,
  maxOutputBytes = DEFAULTS.max_output_bytes,
  env = sanitizeEnv(),
  spawnImpl = spawn,
} = {}) {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cleanupStatus = 'not_needed';
    let child;

    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ code: null, signal: null, stdout: '', stderr: error.message, duration_ms: Date.now() - started, timedOut: false, cleanup_status: 'not_started' });
      return;
    }

    const cap = Math.max(maxOutputBytes * 2, maxOutputBytes + 4096);
    const append = (current, chunk) => {
      const combined = current + chunk.toString('utf8');
      return truncateUtf8(combined, cap).text;
    };

    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      stderr = append(stderr, error.message || String(error));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      cleanupStatus = 'sigterm_sent';
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        cleanupStatus = 'sigterm_failed';
      }
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
            cleanupStatus = 'sigkill_sent';
          } catch {
            cleanupStatus = 'sigkill_failed';
          }
        }
      }, 2000).unref();
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut && cleanupStatus === 'sigterm_sent') cleanupStatus = 'terminated';
      resolvePromise({
        code,
        signal,
        stdout,
        stderr,
        duration_ms: Date.now() - started,
        timedOut,
        cleanup_status: cleanupStatus,
      });
    });
  });
}

// Executes a prepared runner command and returns a normalized AgentRunResult.
export async function runAgentCommand({ engine, request, command, args, outputMode, spawnImpl }) {
  const processResult = await runProcess(command, args, {
    cwd: request.cwd,
    timeoutMs: request.timeout_ms,
    maxOutputBytes: request.max_output_bytes,
    env: sanitizeEnv(),
    spawnImpl,
  });
  const parsed = parseOutput({
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    outputMode,
    exitCode: processResult.code,
    timedOut: processResult.timedOut,
    maxOutputBytes: request.max_output_bytes,
  });
  return makeAgentRunResult({
    engine,
    request,
    status: parsed.status,
    summary: parsed.summary,
    output: parsed.output,
    events: parsed.events,
    metadata: {
      duration_ms: processResult.duration_ms,
      exit_code: processResult.code,
      signal: processResult.signal,
      lifecycle: { cleanup_status: processResult.cleanup_status },
    },
    normalization: parsed.normalization,
    error: parsed.error,
  });
}
