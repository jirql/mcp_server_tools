/**
 * Enhanced Tmux Operations Library
 * Advanced tmux session, window, and pane management
 * Integrates with SessionManager for unified lifecycle
 * Optimized for fast response with aggressive caching
 */

import { spawn } from 'child_process';

// ============================================================================
// Cached Environment State (with TTL and exponential backoff)
// ============================================================================
const _envCache = {
  available: null,
  version: null,
  serverRunning: false,
  lastCheck: 0,
  failureCount: 0,
  maxRetries: 3,
  prewarmed: false
};

const CACHE_TTL = 30000;
const BACKOFF_MS = [500, 1000, 2000, 4000];
const PREWARM_DELAY = 100;

let _prewarmPromise = null;

function getCacheStatus() {
  const now = Date.now();
  const entry = _envCache;
  
  if (entry.available !== null && (now - entry.lastCheck) < CACHE_TTL) {
    return {
      valid: true,
      available: entry.available,
      version: entry.version,
      serverRunning: entry.serverRunning,
      cached: true
    };
  }
  
  return { cached: false };
}

async function prewarmTmuxEnvironment() {
  if (_envCache.prewarmed) {
    return _envCache;
  }
  
  if (_prewarmPromise) {
    return _prewarmPromise;
  }
  
  _prewarmPromise = checkTmuxEnvironment(true);
  const result = await _prewarmPromise;
  _envCache.prewarmed = true;
  _prewarmPromise = null;
  return result;
}

function schedulePrewarm() {
  setTimeout(() => {
    prewarmTmuxEnvironment().catch(() => {});
  }, PREWARM_DELAY);
}

schedulePrewarm();

// ============================================================================
// Tmux Server Management (with exponential backoff)
// ============================================================================
async function checkTmuxEnvironment(skipCache = false) {
  if (!skipCache) {
    const cache = getCacheStatus();
    if (cache.cached) {
      return cache;
    }
  }

  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        updateCache({
          available: false,
          error: 'Check timeout'
        });
        resolve({ ..._envCache, cached: false });
      }
    }, 2000);

    const check = spawn('tmux', ['display-message', '-p', '#{version}'], {
      timeout: 1500
    });
    let versionOutput = '';
    let stderrOutput = '';

    check.stdout.on('data', (data) => {
      versionOutput += data.toString().trim();
    });

    check.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    check.on('close', (code) => {
      if (resolved) return;
      clearTimeout(timeout);
      resolved = true;

      let error = null;
      if (code === 127) {
        error = 'tmux not installed';
        _envCache.failureCount++;
      } else if (code === 1 && stderrOutput.includes('no server running')) {
        updateCache({
          available: true,
          version: versionOutput || 'unknown',
          serverRunning: false,
          error: null,
          note: 'Server not running, will auto-start'
        });
        resolve({ ..._envCache, cached: false });
        return;
      } else if (code !== 0) {
        error = stderrOutput || 'Unknown tmux error';
        _envCache.failureCount++;
      } else if (!versionOutput) {
        error = 'tmux returned empty version';
        _envCache.failureCount++;
      }

      if (error) {
        updateCache({
          available: false,
          version: versionOutput || null,
          serverRunning: false,
          error
        });
      } else {
        _envCache.failureCount = 0;
        updateCache({
          available: true,
          version: versionOutput,
          serverRunning: true,
          error: null
        });
      }

      resolve({ ..._envCache, cached: false });
    });

    check.on('error', (err) => {
      if (resolved) return;
      clearTimeout(timeout);
      resolved = true;
      
      updateCache({
        available: false,
        error: err.code === 'ENOENT' ? 'tmux not found' : err.message
      });

      resolve({ ..._envCache, cached: false });
    });
  });
}

function updateCache(env) {
  _envCache.available = env.available;
  if (env.version) _envCache.version = env.version;
  _envCache.serverRunning = env.serverRunning || false;
  _envCache.lastCheck = Date.now();
  _envCache.error = env.error;
}

// ============================================================================
// Core Spawn Function with Connection Recovery (with exponential backoff)
// ============================================================================
async function spawnTmuxCommand(args, options = {}) {
  const { timeout = 10000, retries = 2, delay = 1000 } = options;

  const env = await checkTmuxEnvironment();
  if (!env.available) {
    throw new Error(env.error || 'tmux not available');
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await executeTmuxCommand(args, timeout);
    } catch (error) {
      if (attempt === retries) throw error;

      if (error.message.includes('no server') || error.message.includes('no session')) {
        const serverResult = await tryStartTmuxServer();
        if (!serverResult) {
          throw error;
        }
      }

      // Exponential backoff
      const backoffDelay = delay * Math.pow(2, attempt);
      await sleep(backoffDelay);
    }
  }
}

function executeTmuxCommand(args, timeout) {
  const execCacheKey = `tmux_${args.join('_')}`;
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args);
    const MAX_OUTPUT = 1024 * 1024; // 1MB limit
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`tmux command timeout: ${args.slice(0, 3).join(' ')}`));
      }
    }, timeout);

    child.stdout.on('data', (data) => {
      if (stdoutBytes < MAX_OUTPUT) {
        stdoutChunks.push(data);
        stdoutBytes += data.length;
      }
    });

    child.stderr.on('data', (data) => {
      stderrChunks.push(data);
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();

      if (code === 0) {
        resolve({
          stdout,
          stderr,
          code,
          timedOut: false
        });
      } else {
        reject(new Error(
          `tmux exit ${code}: ${stderr.split('\n')[0] || 'unknown error'}`
        ));
      }
    });
  });
}

async function tryStartTmuxServer() {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['start-server']);
    child.on('close', (code) => {
      _tmuxServerRunning = code === 0;
      resolve(_tmuxServerRunning);
    });
    child.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _cleanAnsiOutput(text) {
  if (!text) return '';
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\([B0]/g, '')
    .replace(/\x1b\[([0-9]+)G/g, '')
    .replace(/\[([0-9]+)@[0-9]+\+[^\]]+\]/g, '')
    .replace(/\x07/g, '')
    .replace(/\r$/g, '')
    .trim();
}

// ============================================================================
// Tmux Session Registry (integrates with SessionManager)
// ============================================================================
const _sessionRegistry = new Map();

function registerTmuxSession(sessionName, metadata = {}) {
  _sessionRegistry.set(sessionName, {
    name: sessionName,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    pid: null,
    windows: 1,
    panes: 1,
    attached: false,
    metadata,
    commands: []
  });
}

function updateTmuxSession(sessionName, updates = {}) {
  const session = _sessionRegistry.get(sessionName);
  if (session) {
    Object.assign(session, updates, { lastAccess: Date.now() });
  }
}

function unregisterTmuxSession(sessionName) {
  _sessionRegistry.delete(sessionName);
}

function getTmuxSessionInfo(sessionName) {
  return _sessionRegistry.get(sessionName) || null;
}

function getAllTmuxSessions() {
  return Array.from(_sessionRegistry.values());
}

// ============================================================================
// Error Response Factory
// ============================================================================
function tmuxNotAvailableResponse(envCheck) {
  return {
    success: false,
    error: `Tmux is not available: ${envCheck?.error || 'unknown'}`,
    suggestion: 'Use the terminal tool instead for shell operations',
    fallback: 'terminal',
    canRetry: envCheck?.error === 'tmux server not running',
    environment: {
      available: envCheck?.available || false,
      version: envCheck?.version || null,
      serverRunning: envCheck?.serverRunning || false
    }
  };
}

// ============================================================================
// Main Tmux Operations
// ============================================================================
export const tmuxOps = {
  /**
   * Get tmux environment status
   */
  async status() {
    const env = await checkTmuxEnvironment();
    return {
      success: true,
      available: env.available,
      version: env.version,
      serverRunning: env.serverRunning,
      cached: env.cached || false,
      registeredSessions: getAllTmuxSessions().length
    };
  },

  // ========================================================================
  // SESSION OPERATIONS
  // ========================================================================

  /**
   * Create new tmux session
   * Supports HTTP Session ID binding (P1-7): when mcpSessionId is provided,
   * the session name is namespaced to prevent multi-user collisions.
   */
  async create(sessionName, options = {}) {
    const {
      cols = 80,
      rows = 24,
      cwd = null,
      command = null,
      detach = true,
      windowName = null,
      mcpSessionId = null
    } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      let safeName = (sessionName || `mcp_${Date.now()}`)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 200);

      // HTTP Session ID binding: namespace session name to prevent multi-user collisions
      if (mcpSessionId) {
        const safeSessionId = mcpSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 32);
        safeName = `${safeSessionId}_${safeName}`.substring(0, 200);
      }

      const args = ['new-session', '-s', safeName];

      if (detach) args.push('-d');
      if (cols) args.push('-x', String(cols));
      if (rows) args.push('-y', String(rows));
      if (cwd) args.push('-c', cwd);
      if (windowName) args.push('-n', windowName);
      if (command) args.push(command);

      const result = await spawnTmuxCommand(args);

      registerTmuxSession(safeName, {
        cols,
        rows,
        cwd,
        command,
        env: 'tmux'
      });

      return {
        success: true,
        sessionName: safeName,
        sessionId: safeName,
        attached: !detach,
        environment: result
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Create detached session optimized for later attach
   */
  async createDetached(sessionName, options = {}) {
    return this.create(sessionName, { ...options, detach: true });
  },

  /**
   * Attach to existing session
   * Note: This is informational - actual attach requires terminal
   */
  async attach(sessionName, options = {}) {
    const { cols = 80, rows = 24 } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      const sessionInfo = await spawnTmuxCommand([
        'list-sessions', '-F',
        '#{session_name}|#{session_windows}|#{session_attached}|#{session_created}',
        '-t', safeName
      ]);

      const [name, windows, attached] = sessionInfo.stdout.split('|');

      updateTmuxSession(safeName, { attached: attached === '1' });

      return {
        success: true,
        sessionName: name,
        attached: attached === '1',
        windows: parseInt(windows),
        message: 'Session exists. Use terminal tool for interactive attach.'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * List all tmux sessions
   */
  async list(detailed = false) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      if (detailed) {
        const result = await spawnTmuxCommand([
          'list-sessions', '-F',
          '#{session_name}|#{session_windows}|#{session_attached}|#{session_created}|#{session_height}|#{session_width}'
        ]);

        const sessions = result.stdout.split('\n')
          .filter(Boolean)
          .map(line => {
            const [name, windows, attached, created, height, width] = line.split('|');
            return {
              name,
              windows: parseInt(windows),
              attached: attached === '1',
              created: parseInt(created) * 1000,
              height: parseInt(height),
              width: parseInt(width)
            };
          });

        return { success: true, sessions, count: sessions.length };
      } else {
        const result = await spawnTmuxCommand(['list-sessions', '-F', '#{session_name}']);
        const sessions = result.stdout.split('\n').filter(Boolean);

        return { success: true, sessions, count: sessions.length };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Kill tmux session
   */
  async kill(sessionName, options = {}) {
    const { force = false } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      await spawnTmuxCommand([
        force ? 'kill-session' : 'kill-session',
        '-t', safeName
      ]);

      unregisterTmuxSession(safeName);

      return { success: true, sessionName: safeName };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Kill all tmux sessions
   */
  async killAll() {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      await spawnTmuxCommand(['kill-server']);

      for (const [name] of _sessionRegistry) {
        unregisterTmuxSession(name);
      }

      return { success: true, message: 'All tmux sessions killed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Rename session
   */
  async rename(oldName, newName) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeOld = oldName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeNew = newName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 200);

      await spawnTmuxCommand(['rename-session', '-t', safeOld, safeNew]);

      const session = _sessionRegistry.get(safeOld);
      if (session) {
        unregisterTmuxSession(safeOld);
        registerTmuxSession(safeNew, { ...session, name: safeNew });
      }

      return { success: true, oldName: safeOld, newName: safeNew };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // ========================================================================
  // WINDOW OPERATIONS
  // ========================================================================

  /**
   * Create new window
   */
  async createWindow(sessionName, windowName = null, options = {}) {
    const { cwd = null, command = null, attach = false } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeWindow = (windowName || `window_${Date.now()}`)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 200);

      const args = ['new-window', '-t', safeSession, '-n', safeWindow];
      if (cwd) args.push('-c', cwd);
      if (command) args.push(command);
      if (attach) args.push('-d');

      await spawnTmuxCommand(args);
      updateTmuxSession(safeSession, { windows: (_sessionRegistry.get(safeSession)?.windows || 1) + 1 });

      return { success: true, sessionName: safeSession, windowName: safeWindow };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * List windows in session
   */
  async listWindows(sessionName) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      const result = await spawnTmuxCommand([
        'list-windows', '-t', safeSession, '-F',
        '#{window_index}|#{window_name}|#{window_active}|#{window_flags}'
      ]);

      const windows = result.stdout.split('\n')
        .filter(Boolean)
        .map(line => {
          const [index, name, active, flags] = line.split('|');
          return {
            index: parseInt(index),
            name,
            active: active === '1',
            flags: flags || ''
          };
        });

      return { success: true, sessionName: safeSession, windows };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Select window
   */
  async selectWindow(sessionName, windowIndex) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      await spawnTmuxCommand(['select-window', '-t', `${safeSession}:${windowIndex}`]);

      return { success: true, sessionName: safeSession, windowIndex };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Kill window
   */
  async killWindow(sessionName, windowIndex = 0) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      await spawnTmuxCommand(['kill-window', '-t', `${safeSession}:${windowIndex}`]);

      return { success: true, sessionName: safeSession, windowIndex };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // ========================================================================
  // PANE OPERATIONS
  // ========================================================================

  /**
   * Split window (create new pane)
   */
  async splitPane(sessionName, options = {}) {
    const { windowIndex = 0, direction = 'horizontal', size = null, command = null } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const target = `${safeSession}:${windowIndex}.${direction === 'vertical' ? 'v' : 'h'}`;

      const args = ['split-window', '-t', target];
      if (direction === 'vertical') args.push('-v');
      if (direction === 'horizontal') args.push('-h');
      if (size) args.push('-p', String(size));
      if (command) args.push(command);

      await spawnTmuxCommand(args);

      return { success: true, sessionName: safeSession, windowIndex, direction };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Resize pane
   */
  async resizePane(sessionName, options = {}) {
    const { windowIndex = 0, paneIndex = 0, width = null, height = null } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const target = `${safeSession}:${windowIndex}.${paneIndex}`;

      if (width !== null) {
        await spawnTmuxCommand(['resize-pane', '-t', target, '-x', String(width)]);
      }
      if (height !== null) {
        await spawnTmuxCommand(['resize-pane', '-t', target, '-y', String(height)]);
      }

      return { success: true, sessionName: safeSession, width, height };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Select pane
   */
  async selectPane(sessionName, windowIndex = 0, paneIndex = 0) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      await spawnTmuxCommand(['select-pane', '-t', `${safeSession}:${windowIndex}.${paneIndex}`]);

      return { success: true, sessionName: safeSession, paneIndex };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * List panes in window
   */
  async listPanes(sessionName, windowIndex = 0) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      const result = await spawnTmuxCommand([
        'list-panes', '-t', `${safeSession}:${windowIndex}`, '-F',
        '#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_pid}'
      ]);

      const panes = result.stdout.split('\n')
        .filter(Boolean)
        .map(line => {
          const [index, active, width, height, pid] = line.split('|');
          return {
            index: parseInt(index),
            active: active === '1',
            width: parseInt(width),
            height: parseInt(height),
            pid: parseInt(pid)
          };
        });

      return { success: true, sessionName: safeSession, windowIndex, panes };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Kill pane
   */
  async killPane(sessionName, windowIndex = 0, paneIndex = 0) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      await spawnTmuxCommand(['kill-pane', '-t', `${safeSession}:${windowIndex}.${paneIndex}`]);

      return { success: true, sessionName: safeSession, paneIndex };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // ========================================================================
  // KEYBOARD OPERATIONS
  // ========================================================================

  /**
   * Send keys to pane
   */
  async sendKeys(sessionName, keys, options = {}) {
    const { windowIndex = 0, paneIndex = 0, enter = true } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const target = `${safeSession}:${windowIndex}.${paneIndex}`;

      const args = ['send-keys', '-t', target];
      if (Array.isArray(keys)) {
        args.push(...keys);
      } else {
        args.push(keys);
      }
      if (enter) args.push('Enter');

      await spawnTmuxCommand(args);

      const session = _sessionRegistry.get(safeSession);
      if (session) {
        session.commands.push({ keys: Array.isArray(keys) ? keys.join(' ') : keys, ts: Date.now() });
      }

      return { success: true, sessionName: safeSession, keys };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Send tmux command (prefix key)
   */
  async sendPrefix(key) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      await spawnTmuxCommand(['send-prefix', '-t', '0', key]);

      return { success: true, key };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // ========================================================================
  // CONTENT OPERATIONS
  // ========================================================================

  /**
   * Capture pane content (with ANSI escape sequence removal)
   */
  async capture(sessionName, options = {}) {
    const { windowIndex = 0, paneIndex = 0, lines = -1, startLine = null, cleanOutput = true } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const target = `${safeSession}:${windowIndex}.${paneIndex}`;

      const args = ['capture-pane', '-p', '-t', target];
      if (lines > 0) args.push('-S', String(-lines));
      if (startLine !== null) args.push('-E', String(startLine));

      const result = await spawnTmuxCommand(args, { timeout: 15000 });

      let contentLines = result.stdout.split('\n');

      if (cleanOutput) {
        contentLines = contentLines.map(line => _cleanAnsiOutput(line));
      }

      return {
        success: true,
        sessionName: safeSession,
        content: contentLines,
        lineCount: contentLines.length,
        captured: lines > 0 ? lines : contentLines.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Send text to pane (like typing)
   */
  async type(sessionName, text, options = {}) {
    const { windowIndex = 0, paneIndex = 0, delay = 10 } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const target = `${safeSession}:${windowIndex}.${paneIndex}`;

      for (const char of text) {
        await spawnTmuxCommand(['send-keys', '-t', target, char]);
        if (delay > 0) await sleep(delay);
      }

      return { success: true, sessionName: safeSession, chars: text.length };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // ========================================================================
  // BUFFER OPERATIONS
  // ========================================================================

  /**
   * List paste buffers
   */
  async listBuffers() {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const result = await spawnTmuxCommand(['list-buffers', '-F', '#{buffer_index}|#{buffer_size}']);

      const buffers = result.stdout.split('\n')
        .filter(Boolean)
        .map(line => {
          const [index, size] = line.split('|');
          return { index: parseInt(index), size: parseInt(size) };
        });

      return { success: true, buffers };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Save buffer to file
   */
  async saveBuffer(bufferIndex = 0, filePath) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      await spawnTmuxCommand(['save-buffer', '-t', String(bufferIndex), filePath]);

      return { success: true, bufferIndex, filePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // ========================================================================
  // ADVANCED OPERATIONS
  // ========================================================================

  /**
   * Execute command in session (non-blocking)
   */
  async execute(sessionName, command, options = {}) {
    const { windowIndex = 0, paneIndex = 0, waitUntilComplete = false, timeout = 30 } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const target = `${safeSession}:${windowIndex}.${paneIndex}`;

      await spawnTmuxCommand(['send-keys', '-t', target, command, 'Enter']);

      if (waitUntilComplete) {
        await sleep(timeout * 1000);
        const captureResult = await this.capture(sessionName, { windowIndex, paneIndex, lines: 20 });
        return captureResult;
      }

      return {
        success: true,
        sessionName: safeSession,
        command,
        message: 'Command sent. Use capture to get output.'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Wait for output pattern
   */
  async waitFor(sessionName, pattern, options = {}) {
    const { windowIndex = 0, paneIndex = 0, timeout = 60, interval = 500 } = options;

    const startTime = Date.now();
    const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

    while (Date.now() - startTime < timeout * 1000) {
      const result = await this.capture(safeSession, { windowIndex, paneIndex, lines: 50 });
      if (result.success) {
        const content = result.content.join('\n');
        if (content.includes(pattern)) {
          return { success: true, matched: true, pattern, attempts: Math.floor((Date.now() - startTime) / interval) };
        }
      }
      await sleep(interval);
    }

    return { success: true, matched: false, pattern, timeout: true };
  },

  /**
   * Copy mode operations
   */
  async copyMode(sessionName, options = {}) {
    const { windowIndex = 0, paneIndex = 0, command = 'copy-mode' } = options;

    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      await spawnTmuxCommand(['copy-mode', '-t', `${safeSession}:${windowIndex}.${paneIndex}`]);

      return { success: true, sessionName: safeSession, mode: 'copy' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Session info
   */
  async info(sessionName) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');

      const result = await spawnTmuxCommand([
        'list-windows', '-t', safeSession, '-F',
        '#{window_index}|#{window_name}|#{window_width}|#{window_height}'
      ]);

      const windows = result.stdout.split('\n').filter(Boolean).map(line => {
        const [index, name, width, height] = line.split('|');
        return { index: parseInt(index), name, width: parseInt(width), height: parseInt(height) };
      });

      const registered = getTmuxSessionInfo(safeSession);

      return {
        success: true,
        sessionName: safeSession,
        windows,
        registered: !!registered,
        registry: registered
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Refresh client (terminal resize)
   */
  async refresh(sessionName, clientName = null) {
    try {
      const env = await checkTmuxEnvironment();
      if (!env.available) return tmuxNotAvailableResponse(env);

      const args = ['refresh-client'];
      if (clientName) {
        args.push('-t', clientName);
      }

      await spawnTmuxCommand(args);

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};

export { checkTmuxEnvironment, getAllTmuxSessions, getTmuxSessionInfo };
