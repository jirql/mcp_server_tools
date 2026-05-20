/**
 * Command Execution Library
 * Direct child_process execution (no PTY overhead)
 * Integrated with Intelligent Enhancement Layer
 */

import { spawn } from 'child_process';
import { validateCommand, validatePath } from './security.js';
import { enhancer } from './intelligent/index.js';

let sessionManager = null;

let execIdCounter = 0;
const execRegistry = new Map();

export function setSessionManager(sm) {
  sessionManager = sm;
}

function ensureSessionManager() {
  if (!sessionManager) throw new Error('sessionManager not initialized');
  return sessionManager;
}

function collectOutput(child, timeoutMs, signal) {
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const MAX_OUTPUT = 5 * 1024 * 1024;

  return new Promise((resolve) => {
    let settled = false;
    let exitCode = null;
    let timedOut = false;

    const doResolve = () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    const onAbort = () => {
      timedOut = true;
      if (!child.killed) child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        doResolve();
      }, 2000);
    };

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        doResolve();
      }, 2000);
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      if (stdoutBytes < MAX_OUTPUT) {
        stdoutChunks.push(data);
        stdoutBytes += data.length;
      }
    });

    child.stderr.on('data', (data) => {
      if (stderrBytes < MAX_OUTPUT) {
        stderrChunks.push(data);
        stderrBytes += data.length;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: null, timedOut: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      exitCode = code;
      doResolve();
    });
  });
}

export const execOps = {
  generateExecId() {
    return `exec_${Date.now()}_${++execIdCounter}`;
  },

  cancelExec(execId) {
    const ctrl = execRegistry.get(execId);
    if (!ctrl) return { success: false, error: `No such execution: ${execId}` };
    ctrl.abort();
    execRegistry.delete(execId);
    return { success: true, cancelled: execId };
  },

  cancelAllExec() {
    const ids = Array.from(execRegistry.keys());
    for (const id of ids) {
      const ctrl = execRegistry.get(id);
      if (ctrl) ctrl.abort();
    }
    execRegistry.clear();
    return { success: true, cancelled: ids.length };
  },

  async exec(command, timeout, cwd, env, execId = null) {
    const maxTimeout = Math.max((timeout || 60) * 1000, 5000);
    const startTime = Date.now();

    try {
      const cmd = validateCommand(command);
      const workDir = cwd ? validatePath(cwd) : undefined;

      const enhancement = enhancer.process(cmd);

      let finalCommand = cmd;
      if (enhancement.needsExecution) {
        finalCommand = enhancement.enhancedCommand;
      }

      let signal;
      if (execId) {
        const ctrl = new AbortController();
        execRegistry.set(execId, ctrl);
        signal = ctrl.signal;
      }

      const child = spawn('/bin/bash', ['-c', finalCommand], {
        cwd: workDir,
        env: { ...process.env, ...(env || {}) },
        timeout: maxTimeout,
        signal,
      });

      const result = await collectOutput(child, maxTimeout, signal);
      if (execId) execRegistry.delete(execId);

      const FAILURE_SUGGESTIONS = {
        ENOENT: "Command not found. Install the tool or use an absolute path.",
        EACCES: "Permission denied. Use sudo or check file permissions.",
        ENOTDIR: "Path is not a directory. Check the working directory path.",
        ETIMEDOUT: "Command timed out. Increase timeout or simplify the command.",
      };

      const spawnError = result.exitCode === null && result.stderr;
      const suggestion = spawnError
        ? Object.entries(FAILURE_SUGGESTIONS).find(([code]) => result.stderr.includes(code))?.[1]
          || "Command failed to start. Check command syntax and availability."
        : result.timedOut
          ? "Command timed out. Consider increasing timeout or using a simpler command."
          : result.exitCode !== 0
            ? "Command exited with non-zero code. Check the stderr output for details."
            : undefined;

      const response = {
        success: true,
        output: result.stdout || result.stderr,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
        duration: Date.now() - startTime,
        completed: !result.timedOut,
        timedOut: result.timedOut || false,
        command: cmd,
        execId,
      };

      if (suggestion) {
        response.suggestion = suggestion;
        response.failedCommand = cmd;
      }
      if (result.exitCode !== null && result.exitCode !== 0) {
        response.exitCode = result.exitCode;
      }

      if (enhancement.needsExecution) {
        response.enhancement = enhancement.result;
      }

      return response;
    } catch (error) {
      if (execId) execRegistry.delete(execId);
      if (error.name === 'AbortError') {
        return { success: false, error: 'Execution cancelled', execId, cancelled: true };
      }
      return {
        success: false,
        error: error.message,
        failedCommand: command,
        suggestion: "An unexpected error occurred. Check system state and command syntax.",
      };
    }
  },

  async batch(commands, options = {}) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return { success: false, error: 'commands must be a non-empty array' };
    }

    const maxConcurrency = Math.min(options.concurrency || 5, 20);
    const timeout = options.timeout || 60;
    const results = [];
    let idx = 0;
    const batchExecId = options.execId || generateExecId();

    async function worker() {
      while (idx < commands.length) {
        const cmd = commands[idx++];
        const cmdExecId = `${batchExecId}_${idx}`;
        try {
          const result = await execOps.exec(cmd, timeout, undefined, undefined, cmdExecId);
          results.push({ command: cmd, ...result });
        } catch (error) {
          results.push({ command: cmd, success: false, error: error.message });
        }
      }
    }

    const poolSize = Math.min(maxConcurrency, commands.length);
    const workers = Array.from({ length: poolSize }, () => worker());
    await Promise.all(workers);

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
      success: true,
      results,
      summary: { total: results.length, succeeded, failed },
      concurrency: poolSize,
      execId: batchExecId,
    };
  },

  async stream(command, cwd) {
    try {
      const cmd = validateCommand(command);
      const workDir = cwd ? validatePath(cwd) : undefined;

      ensureSessionManager();

      const sessionId = `stream_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const session = sessionManager.createSession(
        sessionId,
        '/bin/bash',
        ['-c', cmd],
        {},
        120, 30,
        workDir
      );

      return {
        success: true,
        sessionId: sessionId,
        pid: session.pid,
        message: 'Command started. Use terminal read to get output.',
        state: session.state
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
