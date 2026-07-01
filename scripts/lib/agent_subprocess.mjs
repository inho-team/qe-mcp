import { spawn } from 'child_process';
import { unlinkSync } from 'fs';

// Builds a capture object for commands that fail before process start.
export function createNotInstalledCapture(error, startedAt = Date.now()) {
  return {
    exit_code: null,
    signal: null,
    stdout: '',
    stderr: error.message || String(error),
    duration_ms: Date.now() - startedAt,
    timed_out: false,
    error,
  };
}

// Appends process output without exceeding the configured byte cap.
function appendBounded(current, chunk, maxBytes) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  if (next.length <= maxBytes) return next;
  return next.subarray(0, maxBytes);
}

// Removes generated temporary files on subprocess exit.
function cleanupTempFiles(paths = []) {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

// Runs a command with shell disabled, bounded output, and timeout cleanup.
export function runSubprocess(command, args, options = {}) {
  const startedAt = Date.now();
  const maxOutputBytes = options.max_output_bytes || 24000;
  const timeoutMs = options.timeout_ms || 60000;
  const tempFiles = options.temp_files || [];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      cleanupTempFiles(tempFiles);
      resolve(createNotInstalledCapture(error, startedAt));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let terminationSignal = null;
    let killSignal = null;

    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk, Math.min(maxOutputBytes, 8000));
    });
    child.on('error', (error) => {
      stderr = appendBounded(stderr, Buffer.from(error.message), Math.min(maxOutputBytes, 8000));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminationSignal = 'SIGTERM';
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Process may already be gone.
      }
      setTimeout(() => {
        if (!child.killed) {
          killSignal = 'SIGKILL';
          try {
            if (process.platform !== 'win32' && child.pid) {
              process.kill(-child.pid, 'SIGKILL');
            } else {
              child.kill('SIGKILL');
            }
          } catch {
            // Process may already be gone.
          }
        }
      }, 2000).unref();
    }, timeoutMs);

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      cleanupTempFiles(tempFiles);
      resolve({
        exit_code: code,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdout_bytes: stdout.length,
        stderr_bytes: stderr.length,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        lifecycle: {
          pid: child.pid,
          process_group: process.platform !== 'win32',
          timeout_ms: timeoutMs,
          termination_signal: terminationSignal,
          kill_signal: killSignal,
          cleanup_status: 'completed',
        },
      });
    });
  });
}
