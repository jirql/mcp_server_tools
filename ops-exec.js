/**
 * Command Execution Library
 * Direct child_process execution (no PTY overhead)
 * Integrated with Intelligent Enhancement Layer
 */

import { spawn } from 'child_process';
import { validateCommand, validatePath } from './security.js';
import { enhancer } from './intelligent/index.js';

let sessionManager = null;

export function setSessionManager(sm) {
  sessionManager = sm;
}

function collectOutput(child, timeoutMs) {
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
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      resolve({ stdout, stderr, exitCode, timedOut });
    };

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
  async exec(command, timeout, cwd, env) {
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

      const child = spawn('/bin/bash', ['-c', finalCommand], {
        cwd: workDir,
        env: { ...process.env, ...(env || {}) },
        timeout: maxTimeout
      });

      const result = await collectOutput(child, maxTimeout);

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
      };

      if (enhancement.needsExecution) {
        response.enhancement = enhancement.result;
      }

      return response;
    } catch (error) {
      return { success: false, error: error.message };
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

    async function worker() {
      while (idx < commands.length) {
        const cmd = commands[idx++];
        try {
          const result = await execOps.exec(cmd, timeout);
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
      concurrency: poolSize
    };
  },

  async stream(command, cwd) {
    try {
      const cmd = validateCommand(command);
      const workDir = cwd ? validatePath(cwd) : undefined;

      if (!sessionManager || !sessionManager.createSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }

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
