import { createBaseResult, makeRunnerError } from './agent_runner_contract.mjs';

// Measures raw output size before preview truncation.
function byteLength(value) {
  return Buffer.byteLength(value || '', 'utf8');
}

// Truncates captured output to the requested preview budget.
function truncate(value, maxBytes) {
  const buffer = Buffer.from(value || '', 'utf8');
  if (buffer.length <= maxBytes) return { text: value || '', truncated: false, bytes: buffer.length };
  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
    bytes: buffer.length,
  };
}

// Maps parsed runner error payloads into QE error categories.
function classifyParsedError(payload) {
  const text = JSON.stringify(payload).toLowerCase();
  if (payload?.api_error_status === 429 || text.includes('quota') || text.includes('weekly limit')) {
    return makeRunnerError('budget_exceeded', payload.result || 'budget or quota exceeded', true);
  }
  if (text.includes('auth') || text.includes('login')) {
    return makeRunnerError('auth_missing', payload.result || 'authentication unavailable', true);
  }
  if (payload?.is_error) {
    return makeRunnerError('nonzero_exit', payload.result || 'runner returned an error', false);
  }
  return null;
}

// Parses JSONL output while preserving malformed-line counts.
function parseJsonLines(text) {
  const events = [];
  let badLineCount = 0;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      badLineCount += 1;
    }
  }
  return { events, badLineCount };
}

// Converts subprocess capture into a normalized AgentRunResult.
export function normalizeProcessOutput(request, capture) {
  const stdout = capture.stdout || '';
  const stderr = capture.stderr || '';
  const stdoutBytes = capture.stdout_bytes ?? byteLength(stdout);
  const stderrBytes = capture.stderr_bytes ?? byteLength(stderr);
  const maxBytes = request.max_output_bytes || 24000;
  const preview = truncate(stdout, maxBytes);
  const stderrPreview = truncate(stderr, Math.min(maxBytes, 8000));
  const duration = capture.duration_ms || 0;

  if (capture.timed_out) {
    return createBaseResult(request, {
      status: 'timeout',
      summary: 'runner timed out',
      output: preview.text,
      duration_ms: duration,
      signal: capture.signal || 'SIGTERM',
      error: makeRunnerError('timeout', 'runner timed out', true),
      normalization: {
        output_format: stdout ? request.output_mode : 'empty',
        normalization_status: stdout ? 'partial' : 'empty',
        truncated: preview.truncated,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        parse_error: null,
        raw_capture_policy: preview.truncated ? 'preview' : stdout ? 'full' : 'metadata_only',
      },
      metadata: {
        stderr_preview: stderrPreview.text,
        lifecycle: capture.lifecycle,
      },
    });
  }

  if (!stdout && !stderr && capture.exit_code === 0) {
    return createBaseResult(request, {
      status: 'error',
      summary: 'empty runner output',
      exit_code: capture.exit_code,
      duration_ms: duration,
      error: makeRunnerError('malformed_output', 'empty output', false),
      normalization: {
        output_format: 'empty',
        normalization_status: 'malformed',
        truncated: false,
        stdout_bytes: 0,
        stderr_bytes: 0,
        parse_error: 'empty output',
        raw_capture_policy: 'metadata_only',
      },
    });
  }

  if (request.output_mode === 'jsonl' || request.output_mode === 'stream-json') {
    const { events, badLineCount } = parseJsonLines(stdout);
    const final = [...events].reverse().find((event) => event.type === 'result' || event.summary || event.result);
    const summary = final?.summary || final?.result || (events.length ? `${events.length} event(s)` : 'no parseable events');
    const malformed = events.length === 0 && badLineCount > 0;
    return createBaseResult(request, {
      status: malformed || capture.exit_code ? 'error' : 'ok',
      summary: String(summary),
      output: final?.result || preview.text,
      events,
      exit_code: capture.exit_code ?? 0,
      duration_ms: duration,
      error: malformed ? makeRunnerError('malformed_output', 'no parseable JSONL events', false) : undefined,
      normalization: {
        output_format: 'jsonl',
        normalization_status: badLineCount ? 'parsed_with_warnings' : 'parsed',
        truncated: preview.truncated,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        parse_error: badLineCount ? `${badLineCount} malformed JSONL line(s) skipped` : null,
        raw_capture_policy: preview.truncated ? 'preview' : 'full',
      },
      metadata: {
        stderr_preview: stderrPreview.text,
        bad_line_count: badLineCount,
        lifecycle: capture.lifecycle,
      },
    });
  }

  if (request.output_mode === 'json') {
    try {
      const parsed = JSON.parse(stdout);
      const parsedError = classifyParsedError(parsed);
      return createBaseResult(request, {
        status: parsedError || capture.exit_code ? 'error' : 'ok',
        summary: parsed.summary || parsed.result || parsed.message || (parsedError ? parsedError.message : 'runner completed'),
        output: typeof parsed.result === 'string' ? parsed.result : preview.text,
        exit_code: capture.exit_code ?? 0,
        duration_ms: duration,
        error: parsedError || (capture.exit_code ? makeRunnerError('nonzero_exit', `exit ${capture.exit_code}`, true) : undefined),
        normalization: {
          output_format: 'json',
          normalization_status: 'parsed',
          truncated: preview.truncated,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          parse_error: null,
          raw_capture_policy: preview.truncated ? 'preview' : 'full',
        },
        metadata: {
          stderr_preview: stderrPreview.text,
          lifecycle: capture.lifecycle,
        },
      });
    } catch (error) {
      return createBaseResult(request, {
        status: 'error',
        summary: 'malformed JSON output',
        output: preview.text,
        exit_code: capture.exit_code ?? 0,
        duration_ms: duration,
        error: makeRunnerError('malformed_output', error.message, false),
        normalization: {
          output_format: 'json',
          normalization_status: 'malformed',
          truncated: preview.truncated,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          parse_error: error.message,
          raw_capture_policy: 'preview',
        },
        metadata: {
          stderr_preview: stderrPreview.text,
          lifecycle: capture.lifecycle,
        },
      });
    }
  }

  return createBaseResult(request, {
    status: capture.exit_code ? 'error' : 'ok',
    summary: capture.exit_code ? `runner exited ${capture.exit_code}` : 'runner completed',
    output: preview.text,
    exit_code: capture.exit_code ?? 0,
    duration_ms: duration,
    error: capture.exit_code ? makeRunnerError('nonzero_exit', `exit ${capture.exit_code}`, true) : undefined,
    normalization: {
      output_format: 'text',
      normalization_status: preview.truncated ? 'truncated' : 'parsed',
      truncated: preview.truncated,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      parse_error: null,
      raw_capture_policy: preview.truncated ? 'preview' : 'full',
    },
    metadata: {
      stderr_preview: stderrPreview.text,
      lifecycle: capture.lifecycle,
    },
  });
}
