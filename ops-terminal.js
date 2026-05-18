/**
 * Terminal Operations Library
 * Unified shell/terminal session operations
 * Optimized for fast response
 */

import { SessionState } from './session-manager.js';
import { validateCommand, validatePath } from './security.js';
import { createLogger } from './utils-logger.js';

const logger = createLogger('TERMINAL');
let sessionManager = null;

const FAST_COMMANDS = [
  /^ls\b/, /^pwd\b/, /^whoami\b/, /^id\b/, /^date\b/, /^hostname\b/,
  /^echo\b/, /^cat\b/, /^head\b/, /^tail\b/, /^wc\b/, /^which\b/,
  /^type\b/, /^uname\b/, /^uptime\b/, /^df\b/, /^free\b/,
  /^ip\s+addr\b/, /^ip\s+route\b/, /^ifconfig\b/, /^netstat\b/
];

const LONG_RUNNING_PATTERNS = [
  /\bnmap\b/, /\bhydra\b/, /\bjohn\b/, /\bhashcat\b/, /\bsqlmap\b/,
  /\bgobuster\b/, /\bdirb\b/, /\bnuclei\b/, /\bmasscan\b/,
  /\bmsfconsole\b/, /\bsliver\b/, /\bwget\b/, /\bcurl\b.*-O/,
  /\bping\b/, /\btraceroute\b/, /\bnc\b.*-l/, /\bpython\b.*http\.server/
];

function isFastCommand(cmd) {
  const trimmed = cmd.trim();
  for (const pattern of FAST_COMMANDS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

function isLongRunningCommand(cmd) {
  const trimmed = cmd.trim();
  for (const pattern of LONG_RUNNING_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

export function setSessionManager(sm) {
  sessionManager = sm;
}

export const terminalOps = {
  async create(sessionId, shell, args, env, cols, rows, cwd, options = {}) {
    try {
      if (!sessionManager || !sessionManager.createSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const sessionOptions = {};
      if (options.mcpSessionId) sessionOptions.ownerHttpSessionId = options.mcpSessionId;
      const session = sessionManager.createSession(
        sessionId, shell, args, env, cols, rows, cwd, sessionOptions
      );

      return {
        success: true,
        sessionId: sessionId,
        pid: session.pid,
        state: session.state,
        message: 'Terminal session created'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async write(sessionId, data) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      session.write(data);
      return { success: true, bytesWritten: data.length };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async read(sessionId, clear, wait, pattern, timeout) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (wait && wait !== 'false' && wait !== false) {
        const timeoutMs = Math.min((timeout || 10) * 1000, 300000);
        let condition;

        switch (wait) {
          case 'idle':
            condition = 'idle';
            break;
          case 'output':
            condition = 'has_output';
            break;
          case 'pattern':
            if (!pattern) {
              return { success: false, error: 'pattern parameter required when wait=pattern' };
            }
            const regex = new RegExp(pattern);
            condition = (s) => regex.test(s.outputBuffer);
            break;
        }

        if (condition) {
          const result = await session.waitForCondition(condition, timeoutMs);
          const output = session.read(clear !== false);
          return {
            success: true,
            output,
            hasOutput: output.length > 0,
            state: session.state,
            isComplete: session.state === SessionState.IDLE,
            waited: true,
            waitResult: result
          };
        }
      }

      const output = session.read(clear !== false);
      const isComplete = session.state === SessionState.IDLE;

      return {
        success: true,
        output: output,
        hasOutput: output.length > 0,
        state: session.state,
        isComplete: isComplete
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async exec(sessionId, command, timeout, options = {}) {
    const startTime = Date.now();

    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (session.state === SessionState.EXITED || session.state === SessionState.ERROR) {
        return { success: false, error: 'Session is not active', state: session.state };
      }

      const cmd = validateCommand(command);
      
      const fastCmd = isFastCommand(cmd);
      const longRunning = isLongRunningCommand(cmd);
      
      const defaultTimeout = longRunning ? 300 : (fastCmd ? 5 : 30);
      const timeoutMs = Math.min((timeout || defaultTimeout) * 1000, 300000);

      if (options.async || longRunning) {
        session.write(cmd + '\n');
        session.addToHistory(cmd);
        
        if (longRunning) {
          session.autoDetectBackground(cmd);
        }
        
        return {
          success: true,
          output: '',
          command: cmd,
          sent: true,
          async: true,
          longRunning: longRunning,
          message: longRunning ? 'Long-running command started. Use read to get output.' : 'Command sent. Use read to get output.',
          duration: Date.now() - startTime
        };
      }

      session.write(cmd + '\n');
      session.addToHistory(cmd);

      return new Promise((resolve) => {
        let resolved = false;
        let completed = false;
        let timeoutHandle = null;
        let checkInterval = null;

        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
          }
          try {
            session.off('command-complete', onComplete);
            session.off('exit', onExit);
          } catch (e) {
          }
        };

        const onComplete = (result) => {
          if (resolved) return;
          completed = true;
          cleanup();
          resolve({
            success: true,
            output: result.output || session.read(true),
            completed: true,
            duration: Date.now() - startTime,
            exitCode: result.exitCode
          });
        };

        const onExit = ({ exitCode }) => {
          if (resolved) return;
          cleanup();
          resolve({
            success: true,
            output: session.read(true),
            completed: true,
            duration: Date.now() - startTime,
            exitCode: exitCode,
            sessionExited: true
          });
        };

        session.on('command-complete', onComplete);
        session.on('exit', onExit);

        if (fastCmd) {
          checkInterval = setInterval(() => {
            if (resolved) return;
            if (session.state === SessionState.IDLE) {
              cleanup();
              resolve({
                success: true,
                output: session.read(true),
                completed: true,
                duration: Date.now() - startTime,
                fastPath: true
              });
            }
          }, 50);

          setTimeout(() => {
            if (resolved) return;
            cleanup();
            resolve({
              success: true,
              output: session.read(true),
              completed: true,
              duration: Date.now() - startTime,
              fastPath: true,
              forced: true
            });
          }, 200);
        }

        timeoutHandle = setTimeout(() => {
          if (resolved) return;
          cleanup();
          resolve({
            success: true,
            output: session.read(true),
            completed: false,
            duration: Date.now() - startTime,
            timedOut: true
          });
        }, timeoutMs);

        if (session.state === SessionState.IDLE || session.state === SessionState.EXITED) {
          if (!completed) {
            setTimeout(() => onComplete({ output: session.read(false), exitCode: session.exitCode }), 10);
          }
        }
      });
    } catch (error) {
      logger.error('Terminal exec error', { error: error.message });
      return { success: false, error: error.message };
    }
  },

  async signal(sessionId, signal) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      const result = session.sendSignal(signal);
      return {
        success: true,
        signal: signal,
        sent: result
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async resize(sessionId, cols, rows) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      session.resize(cols, rows);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async kill(sessionId) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      sessionManager.kill(sessionId);
      return { success: true, message: 'Session killed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async info(sessionId) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      return {
        success: true,
        ...session.getInfo()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async rename(sessionId, name) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      session.setName(name);
      return { success: true, sessionId, name };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async stream(sessionId, command) {
    try {
      if (!sessionManager || !sessionManager.getSession) {
        return { success: false, error: 'sessionManager not initialized' };
      }
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      session.write(command + '\n');
      return {
        success: true,
        sessionId: sessionId,
        streaming: true
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
