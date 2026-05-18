/**
 * Enhanced Session Manager for interactive shell sessions
 * Features:
 * - Memory management with automatic garbage collection
 * - Zombie process detection and cleanup
 * - Output buffer streaming with size limits
 * - Session resource limits and monitoring
 * - TMUX session cleanup on exit
 * - Memory usage tracking per session
 */
import * as pty from 'node-pty';
import { createLogger } from './utils-logger.js';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';

const logger = createLogger('SESSION-MANAGER');

/**
 * Session states
 */
export const SessionState = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPED: 'stopped',
  EXITED: 'exited',
  ERROR: 'error',
  ZOMBIE: 'zombie'  // New state for zombie detection
};

/**
 * Shell prompt patterns - Extended for security tools
 */
const PROMPT_PATTERNS = {
  bash: /[$#]\s+$/,
  zsh: /[%#]\s+$/,
  fish: />\s+$/,
  sh: /[$#]\s+$/,
  dash: /[$#]\s+$/,
  ksh: /[$#]\s+$/,
  csh: /[%>]\s+$/,
  tcsh: /[%>]\s+$/,
  python: />>>\s+$|In \[\d+\]:\s*$/,
  ipython: /In \[\d+\]:\s*$|In \[\d+\]:/,
  ruby: /irb.*>\s*$/,
  node: />\s+$/,
  mysql: /mysql>\s*$/,
  psql: /=>\s*$|->\s*$/,
  sqlite: /sqlite>\s*$/,
  redis: />\s*$/,
  mongo: />\s*$/,
  msfconsole: /msf[6]?\s+\([^)]+\)\s*>/,
  msfvenom: /msfvenom\s*>/,
  sliver: /sliver\s*>\s*$/,
  metasploit: /msf\s*>/,
  netcat: />\s*$/,
  ncat: />\s*$/,
  telnet: />\s*$/,
  ftp: /ftp>\s*$/,
  sftp: /sftp>\s*$/,
  vim: /:/,
  nano: /\[.*\]$/,
  less: /:$/,
  man: /:$/,
  top: /^$/,
  htop: /^$/,
  tmux: /[$#%>]\s+$/,
  screen: /[$#%>]\s+$/,
  generic: /[\$>#%]\s*$/
};

const SPECIAL_PROMPT_PATTERNS = [
  { name: 'msfconsole', pattern: /msf[6]?\s*\([^)]*\)\s*>/ },
  { name: 'sliver', pattern: /sliver\s*>\s*/ },
  { name: 'beef', pattern: /beef>\s*/ },
  { name: 'empire', pattern: /\(Empire:\s*[^)]*\)\s*>/ },
  { name: 'pwncat', pattern: /\(remote\)\s*>\s*/ },
  { name: 'ipython', pattern: /In \[\d+\]:\s*/ },
  { name: 'jupyter', pattern: /In \[\d+\]:\s*/ },
  { name: 'pdb', pattern: /\(Pdb\)\s*/ },
  { name: 'gdb', pattern: /\(gdb\)\s*/ },
  { name: 'lldb', pattern: /\(lldb\)\s*/ }
];

/**
 * Default configuration with memory limits
 */
const DEFAULT_CONFIG = {
  maxOutputBufferSize: 5 * 1024 * 1024,
  maxCommandHistory: 100,
  cleanupIntervalMs: 60000,
  defaultTimeoutSeconds: 3600,
  maxSessions: 20,
  maxMemoryPerSession: 10 * 1024 * 1024,
  gcThresholdMB: 100,
  zombieCheckIntervalMs: 30000,
  zombieThresholdMs: 1800000,
  orphanKillTimeoutMs: 5000,
  tmuxSessionLockTimeout: 10000,
  tmuxStatusRefreshIntervalMs: 5000
};

const BLOCKED_ENV_KEYS = [
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_DEBUG',
  'LD_AUDIT', 'LD_ORIGIN_PATH', 'SHELL',
  'IFS', 'BASH_ENV', 'ENV'
];

function sanitizeEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const safe = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (BLOCKED_ENV_KEYS.includes(upper)) continue;
    if (typeof value !== 'string') continue;
    if (value.length > 4096) continue;
    safe[key] = value;
  }
  return safe;
}

function generateSecureId(prefix = '') {
  const id = randomBytes(16).toString('hex');
  return `${prefix}${Date.now().toString(36)}_${id}`;
}

/**
 * Session class with memory management and background task detection
 */
export class PTYSession extends EventEmitter {
  constructor(sessionId, shell, args, env, cols, rows, cwd, options = {}) {
    super();
    this.id = sessionId;
    this.name = options.name || null;
    this.shell = shell;
    this.args = args;
    this.created = Date.now();
    this.lastActivity = Date.now();
    this.state = SessionState.IDLE;

    // ====================================================================
    // Chunked output buffer (replaces single-string outputBuffer)
    // ====================================================================
    /** @type {string[]} Array of output chunks for O(1) append & O(n) join */
    this._outputChunks = [];
    /** Total bytes across all chunks */
    this._outputBytes = 0;
    /** Max number of chunks — prevents array bloat (~64KB each → 80 chunks ≈ 5MB) */
    this._maxChunks = 80;
    /** Target individual chunk size before starting a new chunk */
    this._chunkTargetSize = 65536; // 64KB
    /** Timestamp of last read() call — for idle auto-clear */
    this._lastReadTime = Date.now();
    /** Bytes discarded by trimming (for stats) */
    this._trimmedBytes = 0;

    // Backward-compatible accessors so external code reading .outputBuffer still works
    // (These are getters defined below via Object.defineProperty in a helper)

    this.commandHistory = [];
    this.currentCommand = '';
    this.exitCode = null;
    this.pid = null;
    this._handlersBound = false;
    this._killed = false;
    this._tmuxSessionName = null;
    this._tmuxLockTime = null;  // Track tmux lock time for concurrency
    this._tmuxStatusLastCheck = Date.now();  // Last status check timestamp
    this._tmuxStatus = null;  // Cached tmux status
    this._memoryUsage = 0;
    this._orphanTimer = null;
    this._lastGCSize = 0;
    this._ownerHttpSessionId = options.ownerHttpSessionId || null;

    // Background task detection
    this._isBackground = false;  // Manually set for long-running tasks
    this._backgroundSince = null;  // Timestamp when marked as background
    this._processStartTime = null; // When the current process started
    this._isLongRunning = false;    // Auto-detected long-running process

    // Auto-detection for background tasks
    this._autoDetectedBackground = false;  // Auto-detected via command patterns
    this._autoDetectedSince = null;  // When auto-detection occurred
    this._commandStartTime = null;  // When current command started

    // Session binding tracking
    this._boundMcpSessions = [];  // Track MCP sessions bound to this tmux

    // Known long-running command patterns (auto-detect these)
    this._KNOWN_LONG_RUNNING = [
      // Network scanners
      /\bnmap\b/, /\bgobuster\b/, /\bdirb\b/, /\bdirbuster\b/,
      /\bmasscan\b/, /\bzmap\b/, /\bnetdiscover\b/, /\barp-scan\b/,
      // Password crackers
      /\bhydra\b/, /\bjohn\b/, /\bhashcat\b/, /\bmedusa\b/,
      // Vulnerability scanners
      /\bnuclei\b/, /\bopenvas\b/, /\bnessus\b/, /\bnexpose\b/,
      // Exploitation frameworks (non-interactive)
      /\bmsfconsole\b.*-q/, /\bmsfconsole\b.*-r/,
      // File transfers (large)
      /\bwget\b.*-r/, /\bcurl\b.*-O/, /\bscp\b/, /\brsync\b.*-z/,
      // Database enumeration (slow)
      /\bsqlmap\b/, /\bnmap\b/,
      // Traffic analysis
      /\bwireshark\b/, /\btcpdump\b.*-w/, /\btshark\b.*-w/,
      // Brute force patterns
      /\b-f\b.*\bpass\b/i, /\b--wordlist\b/, /\b--dictionary\b/,
      // Long output commands
      /\blogsave\b/, /\bdd\b.*of=\/dev\//,
      // Watch/monitor commands
      /\bwatch\b/, /\btop\b.*-b/, /\biostat\b/, /\bvmstat\b/,
      // Continuous processes
      /\bping\b.*-t\b/, /\bping6\b.*-t\b/, /\bnetcat\b.*-l\b/, /\bnc\b.*-l\b/,
      /\bsocat\b.*-listen\b/, /\bpython\b.*http\.server\b/,
      // VPN/wireguard
      /\bwg\b/, /\bwireguard\b/,
      // Docker/kubernetes long running
      /\bdocker\b.*run\b/, /\bkubectl\b.*run\b/
    ];

    this.options = {
      maxOutputBufferSize: options.maxOutputBufferSize || DEFAULT_CONFIG.maxOutputBufferSize,
      maxCommandHistory: options.maxCommandHistory || DEFAULT_CONFIG.maxCommandHistory
    };

    const terminalEnv = { ...process.env, ...sanitizeEnv(env) };

    try {
      this.pty = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: cols || 120,
        rows: rows || 30,
        cwd: cwd || process.cwd(),
        env: terminalEnv,
        encoding: 'utf8'
      });

      this.pid = this.pty.pid;
      this.setupHandlers();
    } catch (error) {
      this.state = SessionState.ERROR;
      throw error;
    }
  }

  // ========================================================================
  // Backward-compatible outputBuffer / outputBufferSize accessors
  // Legacy code reading this.outputBuffer gets the joined string.
  // These are O(n) on read — prefer _getOutput() for better control.
  // ========================================================================
  get outputBuffer() {
    return this._outputChunks.length > 0 ? this._outputChunks.join('') : '';
  }
  set outputBuffer(value) {
    // Support legacy code that sets outputBuffer = '' to clear
    if (value === '') {
      this._outputChunks = [];
      this._outputBytes = 0;
    }
    // If a non-empty string is assigned (unlikely in practice),
    // replace the entire buffer with that string as a single chunk.
    else if (typeof value === 'string') {
      this._outputChunks = [value];
      this._outputBytes = Buffer.byteLength(value);
    }
  }
  get outputBufferSize() {
    return this._outputBytes;
  }
  set outputBufferSize(value) {
    // Legacy code might set this to 0 — keep _outputBytes in sync
    if (value === 0) {
      this._outputBytes = 0;
    }
  }

  setupHandlers() {
    if (this._handlersBound) return;
    this._handlersBound = true;

    const self = this;

    this._onDataHandler = (data) => {
      try {
        self.lastActivity = Date.now();

        if (typeof data !== 'string') {
          data = String(data);
        }

        // === Chunked buffer append (avoids O(n) string copy on every write) ===
        self._appendOutput(data);

        // Fast path prompt check — only look at recent output tail
        if (self.state === SessionState.RUNNING) {
          self.checkPrompt();
        } else if (self.state === SessionState.IDLE && self._outputBytes > 0) {
          // Only scan the last ~500 chars for a prompt pattern — avoids full split
          const tail = self._getOutputTail(500);
          const lastNewline = tail.lastIndexOf('\n');
          const lastLine = lastNewline >= 0 ? tail.slice(lastNewline + 1) : tail;
          if (lastLine && /[$#%>]/.test(lastLine)) {
            self.checkPrompt();
          }
        }
      } catch (err) {
        logger.debug('Data handler error', { sessionId: self.id, error: err.message });
      }
    };

    this._onExitHandler = ({ exitCode }) => {
      try {
        self.state = SessionState.EXITED;
        self.exitCode = exitCode;
        self.lastActivity = Date.now();
        self.emit('exit', exitCode);
        logger.debug('Session exited', { sessionId: self.id, exitCode });
        self.cleanup();
      } catch (err) {
        logger.error('Exit handler error', { sessionId: self.id, error: err.message });
      }
    };

    this.pty.onData(this._onDataHandler);
    this.pty.onExit(this._onExitHandler);

    if (typeof this.pty.onError === 'function') {
      this._onErrorHandler = (error) => {
        try {
          self.state = SessionState.ERROR;
          self.emit('error', error);
          logger.debug('PTY error', { sessionId: self.id, error: error.message });
        } catch (err) {
          logger.debug('Error handler error', { sessionId: self.id, error: err.message });
        }
      };
      this.pty.onError(this._onErrorHandler);
    }
  }

  // ========================================================================
  // Chunked Buffer Helpers
  // ========================================================================

  /**
   * Append data to the chunked output buffer.
   * - Appends to last chunk if it's small (< chunkTargetSize)
   * - Otherwise creates a new chunk
   * - Trims oldest chunks when total exceeds maxOutputBufferSize
   * - Emits 'data' event for streaming consumers
   */
  _appendOutput(data) {
    if (!data || data.length === 0) return;

    const dataLen = Buffer.byteLength(data);

    // Try to append to the last chunk if it's small enough
    if (this._outputChunks.length > 0) {
      const lastIdx = this._outputChunks.length - 1;
      const lastChunk = this._outputChunks[lastIdx];
      // If last chunk is still under target size, append to it
      if (Buffer.byteLength(lastChunk) < this._chunkTargetSize) {
        this._outputChunks[lastIdx] = lastChunk + data;
        this._outputBytes += dataLen;
        this._trimOutput();
        this.emit('data', data);
        return;
      }
    }

    // Push as a new chunk
    this._outputChunks.push(data);
    this._outputBytes += dataLen;

    // Enforce max chunks limit (prevents array from growing unbounded)
    if (this._outputChunks.length > this._maxChunks) {
      const removed = this._outputChunks.shift();
      this._outputBytes -= Buffer.byteLength(removed);
      this._trimmedBytes += Buffer.byteLength(removed);
    }

    this._trimOutput();
    this.emit('data', data);
  }

  /**
   * Get the entire output buffer as a single string.
   * Optionally strips ANSI escape sequences.
   * @param {boolean} [cleanAnsi=false] - Remove ANSI escape codes
   * @returns {string}
   */
  _getOutput(cleanAnsi = false) {
    if (this._outputChunks.length === 0) return '';
    const result = this._outputChunks.join('');
    return cleanAnsi ? this._stripAnsi(result) : result;
  }

  /**
   * Get only the last N bytes of output (for prompt detection, etc.).
   * Avoids joining the entire buffer — only joins enough chunks.
   * @param {number} bytes - How many bytes from the end to retrieve
   * @returns {string}
   */
  _getOutputTail(bytes) {
    if (this._outputChunks.length === 0 || bytes <= 0) return '';

    // Walk chunks from the end until we have enough bytes
    let collected = '';
    let remaining = bytes;
    for (let i = this._outputChunks.length - 1; i >= 0; i--) {
      const chunk = this._outputChunks[i];
      if (chunk.length >= remaining) {
        collected = chunk.slice(-remaining) + collected;
        break;
      }
      collected = chunk + collected;
      remaining -= chunk.length;
    }
    return collected;
  }

  /**
   * Trim the oldest chunks when total bytes exceed maxOutputBufferSize.
   * Target: trim to maxOutputBufferSize / 2 (same as original behavior,
   * but O(1) per chunk instead of O(n) string copy).
   */
  _trimOutput() {
    const maxBytes = this.options.maxOutputBufferSize;
    if (this._outputBytes <= maxBytes) return;

    const targetBytes = maxBytes >> 1; // half
    let removed = 0;

    while (this._outputChunks.length > 0 && (this._outputBytes - removed) > targetBytes) {
      const chunk = this._outputChunks.shift();
      const chunkBytes = Buffer.byteLength(chunk);
      removed += chunkBytes;
      this._trimmedBytes += chunkBytes;
    }

    this._outputBytes -= removed;
  }

  /**
   * Clear the entire output buffer.
   */
  _clearOutput() {
    this._outputChunks = [];
    this._outputBytes = 0;
  }

  /**
   * Strip ANSI escape sequences from text.
   * Matches common terminal control sequences (colors, cursor, erase, etc.).
   * @param {string} text
   * @returns {string}
   */
  _stripAnsi(text) {
    if (!text) return '';
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
               .replace(/\x1b\][0-9;]*\x07/g, '')  // OSC sequences (e.g., title)
               .replace(/\x1b[PX^_].*?\x1b\\/gs, '') // APC/SOS/PM/STS sequences
               .replace(/\x1b[\\\]_]/g, '')           // Residual escapes
               .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Control chars
  }

  checkPrompt() {
    try {
      if (this._outputBytes === 0) {
        return false;
      }

      // Only examine the last ~2KB of output — avoids full-buffer split
      const tail = this._getOutputTail(2048);
      const lines = tail.split('\n');
      const lastLine = lines[lines.length - 1] || '';
      const trimmedLine = lastLine.trim();

      // Check special prompts (msfconsole, sliver, etc.) against tail
      for (const { name, pattern } of SPECIAL_PROMPT_PATTERNS) {
        if (pattern.test(trimmedLine) || pattern.test(tail)) {
          this.state = SessionState.IDLE;
          this.emit('command-complete', {
            output: this._getOutput(),
            exitCode: this.exitCode,
            promptType: name
          });
          return true;
        }
      }

      const pattern = this.getPromptPattern();
      if (!pattern) {
        return false;
      }

      // Test the last line
      if (pattern.test(trimmedLine)) {
        this.state = SessionState.IDLE;
        this.emit('command-complete', {
          output: this._getOutput(),
          exitCode: this.exitCode
        });
        return true;
      }

      // Test last 3 lines
      const last3Lines = lines.slice(-3).join('\n');
      if (pattern.test(last3Lines)) {
        this.state = SessionState.IDLE;
        this.emit('command-complete', {
          output: this._getOutput(),
          exitCode: this.exitCode
        });
        return true;
      }

      // Test with appended space (some prompts need this)
      const lastLineWithSpace = lastLine + ' ';
      if (pattern.test(lastLineWithSpace)) {
        this.state = SessionState.IDLE;
        this.emit('command-complete', {
          output: this._getOutput(),
          exitCode: this.exitCode
        });
        return true;
      }
    } catch (err) {
      logger.debug('checkPrompt error', { sessionId: this.id, error: err.message });
    }
    return false;
  }

  getPromptPattern() {
    const shellName = this.shell.split('/').pop().toLowerCase();
    
    if (shellName.includes('msf') || shellName.includes('metasploit')) {
      return PROMPT_PATTERNS.msfconsole;
    }
    if (shellName.includes('sliver')) {
      return PROMPT_PATTERNS.sliver;
    }
    if (shellName.includes('python') || shellName === 'python3' || shellName === 'python2') {
      return PROMPT_PATTERNS.python;
    }
    if (shellName.includes('ipython')) {
      return PROMPT_PATTERNS.ipython;
    }
    if (shellName.includes('node')) {
      return PROMPT_PATTERNS.node;
    }
    if (shellName.includes('mysql')) {
      return PROMPT_PATTERNS.mysql;
    }
    if (shellName.includes('psql')) {
      return PROMPT_PATTERNS.psql;
    }
    
    return PROMPT_PATTERNS[shellName] || PROMPT_PATTERNS.generic;
  }

  isTmux() {
    return this.shell.includes('tmux') || this.currentCommand.includes('tmux');
  }

  sendTmuxPrefix() {
    if (this._killed || !this.pty) return 0;
    return this.pty.write('\x02');
  }

  sendTmuxCommand(key) {
    if (this._killed || !this.pty) return 0;
    this.sendTmuxPrefix();
    return this.pty.write(key);
  }

  write(data) {
    try {
      if (this._killed || this.state === SessionState.EXITED || this.state === SessionState.ERROR) {
        throw new Error('Session is not active');
      }

      if (!data) {
        return 0;
      }

      this.currentCommand += data;
      this.lastActivity = Date.now();

      if (this.state === SessionState.IDLE) {
        this.state = SessionState.RUNNING;
      }

      const written = this.pty.write(data);
      return written;
    } catch (err) {
      logger.error('Write error', { sessionId: this.id, error: err.message });
      throw err;
    }
  }

  sendSignal(signal) {
    try {
      if (!this.pty || this._killed) {
        return false;
      }

      switch (signal) {
        case 'SIGINT':
          this.pty.write('\x03');
          break;
        case 'SIGTSTP':
          this.pty.write('\x1A');
          break;
        case 'SIGQUIT':
          this.pty.write('\x1C');
          break;
        case 'SIGEOF':
          this.pty.write('\x04');
          break;
        default:
          this.pty.kill(signal);
      }
      this.lastActivity = Date.now();
      this.emit('signal', signal);
      return true;
    } catch (error) {
      logger.error('sendSignal error', { sessionId: this.id, signal, error: error.message });
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Read and optionally clear the output buffer.
   * @param {boolean} [clear=true] - Clear buffer after reading
   * @param {object} [options]
   * @param {boolean} [options.cleanAnsi=false] - Strip ANSI escape sequences from output
   * @returns {string} Output content
   */
  read(clear = true, options = {}) {
    const cleanAnsi = options?.cleanAnsi === true;
    const output = this._getOutput(cleanAnsi);
    this._lastReadTime = Date.now();
    if (clear) {
      this._clearOutput();
      this._lastGCSize = 0;
    }
    return output;
  }

  resize(cols, rows) {
    try {
      if (!this.pty || this._killed) return;
      this.pty.resize(cols, rows);
      this.lastActivity = Date.now();
    } catch (err) {
      logger.debug('resize error', { sessionId: this.id, error: err.message });
    }
  }

  kill(force = false) {
    if (this._killed) return;
    this._killed = true;

    if (this._orphanTimer) {
      clearTimeout(this._orphanTimer);
      this._orphanTimer = null;
    }

    try {
      if (force) {
        this.pty.kill('SIGKILL');
      } else {
        this.pty.kill('SIGTERM');
        this._orphanTimer = setTimeout(() => {
          try {
            this.pty.kill('SIGKILL');
          } catch (e) {
            // Already dead
          }
        }, DEFAULT_CONFIG.orphanKillTimeoutMs);
      }
    } catch (e) {
      // PTY already dead
    }

    this.state = SessionState.EXITED;
    this.cleanup();
  }

  async cleanup() {
    if (!this.pty) return;

    // Remove ALL event handlers to prevent memory leaks
    try {
      this.pty.offData?.(this._onDataHandler);
      this.pty.offExit?.(this._onExitHandler);
      this.pty.offError?.(this._onErrorHandler);
    } catch (e) {
      // PTY API may vary, force remove all handlers
      this.removeAllListeners('data');
      this.removeAllListeners('exit');
      this.removeAllListeners('error');
      this.removeAllListeners('zombie');
    }

    // Clear PTY reference
    const pty = this.pty;
    this.pty = null;

    // Release lock before cleanup
    this._tmuxLockTime = Date.now() + 120000;  // Lock for 2 minutes during cleanup

    // Only cleanup tmux if this is the last bound MCP session
    if (this._tmuxSessionName && this._boundMcpSessions.length <= 1) {
      await this._cleanupTmuxSession(this._tmuxSessionName);
      this._tmuxSessionName = null;
    } else if (this._tmuxSessionName) {
      // Release MCP session binding without killing tmux
      const index = this._boundMcpSessions.indexOf(this.id);
      if (index > -1) {
        this._boundMcpSessions.splice(index, 1);
      }
    }

    // Reset status tracking
    this._tmuxStatus = null;

    // Force garbage collection hints
    this._clearOutput();
    this._lastGCSize = 0;
    this.commandHistory = [];
    this.currentCommand = '';

    // 确保所有外部监听器也被移除
    this.removeAllListeners();
  }

  async _cleanupTmuxSession(tmuxName) {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);

      if (!/^[a-zA-Z0-9_]+$/.test(tmuxName)) {
        logger.warn('Invalid tmux session name - cleanup skipped', { tmuxName });
        return;
      }

      const escapeArgs = (name) => name.replace(/[^a-zA-Z0-9_]/g, '_');
      const safeName = escapeArgs(tmuxName);

      const { error, stdout, stderr } = await execPromise(
        `tmux kill-session -t ${safeName} 2>/dev/null || true`,
        { timeout: 5000 }
      );

      if (error && !stderr.includes('no such session')) {
      }
    } catch (e) {
      logger.debug('tmux cleanup warning', { tmuxName, error: e.message });
    }
  }

  markZombie() {
    if (this.state !== SessionState.ZOMBIE) {
      logger.debug('Session marked as zombie', { sessionId: this.id });
      this.state = SessionState.ZOMBIE;
      this.emit('zombie', { sessionId: this.id });
    }
  }

  addToHistory(command) {
    this.commandHistory.push({
      command,
      timestamp: Date.now()
    });

    if (this.commandHistory.length > this.options.maxCommandHistory) {
      this.commandHistory.shift();
    }
  }

  getMemoryUsage() {
    // Estimate memory usage
    const bufferMem = this._outputBytes;
    const historyMem = this.commandHistory.reduce((sum, h) => sum + h.command.length, 0);
    const commandMem = this.currentCommand.length;
    // Account for chunk array overhead (≈ 40 bytes per chunk + string object overhead)
    const chunkOverhead = this._outputChunks.length * 80;
    return bufferMem + historyMem + commandMem + chunkOverhead;
  }

  shouldTriggerGC() {
    const currentMem = this.getMemoryUsage();
    if (this._lastGCSize > 0 && currentMem > this._lastGCSize * 1.5) {
      // Memory grew 50% since last GC
      return true;
    }
    this._lastGCSize = currentMem;
    return false;
  }

  getInfo() {
    const lastCommand = this.commandHistory.length > 0
      ? this.commandHistory[this.commandHistory.length - 1].command
      : this.currentCommand;

    const tmuxInfo = this.getTmuxInfo();

    return {
      id: this.id,
      name: this.name,
      pid: this.pid,
      shell: this.shell,
      state: this.state,
      created: this.created,
      lastActivity: this.lastActivity,
      exitCode: this.exitCode,
      commandCount: this.commandHistory.length,
      tmuxSession: tmuxInfo.sessionName,
      tmuxBoundSessions: tmuxInfo.boundMcpSessions,
      isTmuxSession: this.isTmuxSession(),
      currentCommand: this.currentCommand,
      lastCommand: lastCommand,
      hasOutput: this._outputBytes > 0,
      outputBufferSize: this._outputBytes,
      memoryUsage: this.getMemoryUsage(),
      isZombie: this.state === SessionState.ZOMBIE,
      isTmux: this._tmuxSessionName !== null,
      tmuxSession: this._tmuxSessionName,
      isBackground: this._isBackground,
      isLongRunning: this._isLongRunning,
      isAutoDetectedBackground: this._autoDetectedBackground,
      autoBackgroundSince: this._autoDetectedSince,
      ownerHttpSessionId: this._ownerHttpSessionId
    };
  }

  setName(name) {
    this.name = name;
  }

  setTmuxSession(tmuxName, mcpSessionId = null) {
    // Security: validate tmux session name format
    if (!/^[a-zA-Z0-9_]+$/.test(tmuxName)) {
      throw new Error(`Invalid tmux session name format: ${tmuxName}`);
    }

    // Concurrency control: prevent race conditions
    const now = Date.now();
    if (this._tmuxLockTime && (now - this._tmuxLockTime < 1000)) {
      throw new Error(`TMUX session operation in progress, too soon: ${tmuxName}`);
    }
    this._tmuxLockTime = now;

    this._tmuxSessionName = tmuxName;

    // Add to bound sessions tracking
    if (mcpSessionId && !this._boundMcpSessions.includes(mcpSessionId)) {
      this._boundMcpSessions.push(mcpSessionId);
    }

    // Reset lock after 1 second
    setTimeout(() => { this._tmuxLockTime = null; }, 1000);

    return tmuxName;
  }

  async checkTmuxStatus() {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);

      // Check lock to prevent race conditions
      const now = Date.now();
      if (this._tmuxLockTime && (now - this._tmuxLockTime < 1000)) {
        return { exists: false, reason: 'lock_in_progress' };
      }

      // Rate limit status checks (every 5 seconds)
      if (now - this._tmuxStatusLastCheck < 5000) {
        return this._tmuxStatus || { exists: true };
      }

      this._tmuxStatusLastCheck = now;

      const { stdout } = await execPromise(
        `tmux has-session -t "${this._tmuxSessionName}" 2>/dev/null && echo "exists"`,
        { timeout: 5000 }
      );

      this._tmuxStatus = {
        exists: stdout.includes('exists'),
        checked: now,
        boundSessions: this._boundMcpSessions.length
      };

      return this._tmuxStatus;
    } catch (e) {
      return { exists: false, error: e.message };
    }
  }

  getTmuxSession() {
    return this._tmuxSessionName;
  }

  isTmuxSession() {
    return this._tmuxSessionName !== null;
  }

  getTmuxInfo() {
    return {
      sessionName: this._tmuxSessionName,
      boundMcpSessions: this._boundMcpSessions,
      lastStatusCheck: this._tmuxStatusLastCheck,
      lockTime: this._tmuxLockTime
    };
  }

  async waitForCondition(condition, timeoutMs = 30000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        let met = false;
        if (typeof condition === 'function') {
          met = condition(this);
        } else if (condition === 'idle') {
          met = this.state === SessionState.IDLE || this.state === SessionState.EXITED;
        } else if (condition === 'has_output') {
          met = this._outputBytes > 0;
        }
        if (met || Date.now() - start > timeoutMs) {
          resolve({ met, timedOut: !met, elapsed: Date.now() - start });
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  // Background task management
  markBackground(isBackground = true) {
    this._isBackground = isBackground;
    this._backgroundSince = isBackground ? Date.now() : null;
  }

  isBackground() {
    return this._isBackground;
  }

  startLongRunning(command = '') {
    this._isLongRunning = true;
    this._processStartTime = Date.now();
    this.currentCommand = command;
  }

  stopLongRunning() {
    this._isLongRunning = false;
    this._processStartTime = null;
  }

  isLongRunning() {
    return this._isLongRunning;
  }

  getProcessDuration() {
    if (!this._processStartTime) return 0;
    return Date.now() - this._processStartTime;
  }

  // Auto-detect if command is a long-running task
  autoDetectBackground(command) {
    if (!command || command.trim() === '') return false;

    const trimmedCmd = command.trim();
    const now = Date.now();

    for (const pattern of this._KNOWN_LONG_RUNNING) {
      if (pattern.test(trimmedCmd)) {
        // Re-detect if: new command matches, or same command re-executed
        if (!this._autoDetectedBackground || this.currentCommand !== trimmedCmd) {
            this._autoDetectedBackground = true;
            this._autoDetectedSince = now;
            this._commandStartTime = now;
          }
        return true;
      }
    }

    // Only reset if a SHORT time has passed since detection
    // This prevents resetting immediately after a long-running task completes
    // but allows normal commands to clear the flag if enough time passed
    if (this._autoDetectedBackground && this._autoDetectedSince) {
      const elapsed = now - this._autoDetectedSince;
      const MIN_PROTECTION_MS = 60000; // 60 seconds minimum protection

      if (elapsed < MIN_PROTECTION_MS && this.state === SessionState.IDLE) {
        return false;
      }

      // Either protection period passed OR user executed new commands
      // Check if user explicitly ran a different command
      if (this.currentCommand && trimmedCmd !== this.currentCommand) {
        this._autoDetectedBackground = false;
        this._autoDetectedSince = null;
        this._commandStartTime = null;
      }
    }

    return false;
  }

  isAutoDetectedBackground() {
    return this._autoDetectedBackground;
  }

  // Smart zombie detection - considering background tasks
  shouldMarkZombie(zombieThresholdMs) {
    // Never mark as zombie if:
    // 1. It's a tmux session (tmux manages its own lifecycle)
    // 2. It's marked as background task (manual)
    // 3. It's detected as long-running process (manual)
    // 4. It's auto-detected as background task
    // 5. It's currently running (not EXITED/ERROR)

    if (this._tmuxSessionName) {
      return { zombie: false, reason: 'tmux_session' };
    }

    if (this._isBackground) {
      const duration = this._backgroundSince ? (Date.now() - this._backgroundSince) / 1000 / 60 : 0;
      return { zombie: false, reason: 'background_task', backgroundMinutes: Math.round(duration) };
    }

    if (this._isLongRunning) {
      const duration = this._processStartTime ? (Date.now() - this._processStartTime) / 1000 / 60 : 0;
      return { zombie: false, reason: 'long_running', runningMinutes: Math.round(duration) };
    }

    if (this._autoDetectedBackground) {
      const duration = this._autoDetectedSince ? (Date.now() - this._autoDetectedSince) / 1000 / 60 : 0;
      return { zombie: false, reason: 'auto_background', autoMinutes: Math.round(duration), 
               command: this.currentCommand?.substring(0, 50) || 'unknown' };
    }

    if (this.state === SessionState.RUNNING || this.state === SessionState.IDLE) {
      return { zombie: false, reason: 'still_active' };
    }

    // Check if dead for too long
    const deadDuration = Date.now() - this.lastActivity;
    if (deadDuration > zombieThresholdMs) {
      return { zombie: true, reason: 'dead_too_long', deadMinutes: Math.round(deadDuration / 1000 / 60) };
    }

    return { zombie: false, reason: 'recently_dead' };
  }
}

/**
 * Session Manager with resource management
 */
export class SessionManager {
  constructor(config) {
    this.sessions = new Map();
    this.config = config;
    this.eventEmitter = new EventEmitter();
    this._shutdown = false;
    this._totalMemoryUsage = 0;
    this._gcCounter = 0;
    this._lastMemoryCheck = Date.now();

    // TMUX session lock map for concurrency control
    this._tmuxLocks = new Map();  // tmux_name -> { lockTime, lockHolder }
    this._tmuxStatusCache = new Map();  // tmux_name -> { timestamp, exists }

    // Cleanup expired sessions (includes zombie detection)
    this.cleanupTimer = setInterval(() => {
      if (!this._shutdown) {
        this.cleanupExpired();
        this.checkMemoryUsage();
        this._cleanupTmuxLocks();
      }
    }, DEFAULT_CONFIG.cleanupIntervalMs);

    this.cleanupTimer.unref?.();
  }

  // TMUX lock management for concurrency control
  async acquireTmuxLock(tmuxName) {
    const lockKey = `tmux_${tmuxName}`;
    const lockTimeout = DEFAULT_CONFIG.tmuxSessionLockTimeout || 10000;

    try {
      const lockData = this._tmuxLocks.get(lockKey);
      const now = Date.now();

      // Clean up expired lock
      if (lockData && (now - lockData.lockTime > lockTimeout)) {
        this._tmuxLocks.delete(lockKey);
        return true;
      }

      // Lock already acquired by someone
      if (lockData) {
        logger.debug('TMUX lock already acquired', { tmuxName, lockHolder: lockData.lockHolder });
        return false;
      }

      // Acquire lock
      this._tmuxLocks.set(lockKey, {
        lockTime: now,
        lockHolder: `session_${this._acquireTmuxLockHolder()}`,
        timeout: lockTimeout
      });

      logger.debug('TMUX lock acquired', { tmuxName });
      return true;
    } catch (error) {
      logger.warn('Failed to acquire TMUX lock', { tmuxName, error: error.message });
      return false;
    }
  }

  async releaseTmuxLock(tmuxName) {
    const lockKey = `tmux_${tmuxName}`;
    if (this._tmuxLocks.has(lockKey)) {
      this._tmuxLocks.delete(lockKey);
      logger.debug('TMUX lock released', { tmuxName });
    }
  }

  _acquireTmuxLockHolder() {
    return `${Math.random().toString(36).substr(2, 9)}`;
  }

  _cleanupTmuxLocks() {
    const now = Date.now();
    const lockTimeout = DEFAULT_CONFIG.tmuxSessionLockTimeout || 10000;

    for (const [key, lockData] of this._tmuxLocks.entries()) {
      if (now - lockData.lockTime > lockTimeout) {
        this._tmuxLocks.delete(key);
        logger.debug('TMUX lock cleanup - expired lock removed', { lockKey: key });
      }
    }
  }

  async checkSessionConflict(sessionName) {
    if (!sessionName) {
      return { conflict: false };
    }

    if (!/^[a-zA-Z0-9_]+$/.test(sessionName)) {
      return {
        conflict: true,
        name: sessionName,
        reason: 'Invalid session name format'
      };
    }

    for (const session of this.sessions.values()) {
      if (session.getTmuxSession() === sessionName) {
        return {
          conflict: true,
          name: sessionName,
          sessionId: session.id,
          reason: 'Session already exists'
        };
      }
    }

    return { conflict: false };
  }

  async verifyTmuxSession(sessionName) {
    if (!sessionName || typeof sessionName !== 'string') {
      return { exists: false, error: 'No session name provided' };
    }

    const safeName = sessionName.replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeName) {
      return { exists: false, error: 'Invalid session name' };
    }

    const cacheKey = `tmux_verify_${safeName}`;
    const cached = this._tmuxStatusCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp < 5000)) {
      return { exists: cached.exists, cached: true };
    }

    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);

      const { stdout } = await execPromise(
        `tmux has-session -t "${safeName}" 2>/dev/null && echo "exists"`,
        { timeout: 5000 }
      );

      const exists = stdout.trim() === 'exists';
      this._tmuxStatusCache.set(cacheKey, { exists, timestamp: now });
      return { exists };
    } catch (e) {
      this._tmuxStatusCache.set(cacheKey, { exists: false, timestamp: now });
      return { exists: false, error: e.message };
    }
  }

  createSession(sessionId, shell, args, env, cols, rows, cwd, options = {}) {
    if (this._shutdown) {
      throw new Error('SessionManager is shutting down');
    }

    const maxSessions = this.config?.terminal?.max_sessions || DEFAULT_CONFIG.maxSessions;
    if (this.sessions.size >= maxSessions) {
      throw new Error(`Maximum sessions (${maxSessions}) reached`);
    }

    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const session = new PTYSession(
      sessionId,
      shell,
      args,
      env,
      cols,
      rows,
      cwd,
      options
    );

    this.sessions.set(sessionId, session);
    this._totalMemoryUsage += session.getMemoryUsage();
  
    // Session event forwarding with weak references
    const onExit = (exitCode) => {
      this._totalMemoryUsage = Math.max(0, this._totalMemoryUsage - session.getMemoryUsage());
      this.eventEmitter.emit('session-exit', { sessionId, exitCode });
      this.sessions.delete(sessionId);
    };

    const onError = (error) => {
      this.eventEmitter.emit('session-error', { sessionId, error });
    };

    const onData = (data) => {
      this.eventEmitter.emit('session-data', { sessionId, data });
    };

    const onZombie = () => {
      this.eventEmitter.emit('session-zombie', { sessionId });
    };

    // Store handlers for cleanup
    session._externalHandlers = { onExit, onError, onData, onZombie };

    session.on('exit', onExit);
    session.on('error', onError);
    session.on('data', onData);
    session.on('zombie', onZombie);

    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    session.write(data);
    return data.length;
  }

  sendSignal(sessionId, signal) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    return session.sendSignal(signal);
  }

  read(sessionId, clear = true) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    return session.read(clear);
  }

  waitForCompletion(sessionId, timeout = 30000) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    return new Promise((resolve, reject) => {
      if (session.state === SessionState.IDLE || session.state === SessionState.EXITED) {
        resolve(session.read(false));
        return;
      }

      const timer = setTimeout(() => {
        session.off('command-complete', onComplete);
        session.off('exit', onExit);
        resolve(session.read(false));
      }, timeout);

      const onComplete = (result) => {
        clearTimeout(timer);
        session.off('exit', onExit);
        resolve(result.output);
      };

      const onExit = () => {
        clearTimeout(timer);
        session.off('command-complete', onComplete);
        resolve(session.read(false));
      };

      session.once('command-complete', onComplete);
      session.once('exit', onExit);
    });
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    session.resize(cols, rows);
  }

  kill(sessionId, force = false) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.kill(force);
    this.sessions.delete(sessionId);
    
    // Clean up session handlers
    session._handlersBound = false;
    session._killed = true;
  }

  listSessions() {
    return Array.from(this.sessions.values())
      .map(session => session.getInfo());
  }

  cleanupExpired() {
    const now = Date.now();
    const timeout = (this.config?.terminal?.timeout || DEFAULT_CONFIG.defaultTimeoutSeconds) * 1000;
    let cleaned = 0;
    let buffersCleared = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const shouldClean =
        session.state === SessionState.EXITED ||
        session.state === SessionState.ERROR ||
        session.state === SessionState.ZOMBIE ||
        (now - session.lastActivity > timeout);

      if (shouldClean) {
        logger.debug('Cleaning up session', { sessionId, state: session.state });
        session.kill();
        this.sessions.delete(sessionId);
        cleaned++;
        continue;
      }

      // ---- Idle buffer auto-clear: free memory if output not read recently ----
      // If session has > 64KB of output and hasn't been read in 5 minutes, clear it
      const IDLE_BUFFER_CLEAR_MS = 300000; // 5 minutes
      if (session._outputBytes > 65536 && (now - session._lastReadTime) > IDLE_BUFFER_CLEAR_MS) {
        const freedBytes = session._outputBytes;
        session._clearOutput();
        buffersCleared++;
        if (freedBytes > 1024 * 1024) { // Log only for > 1MB clears
          logger.debug('Idle buffer auto-cleared', {
            sessionId,
            freedBytes,
            idleMs: now - session._lastReadTime,
          });
        }
      }
    }

    if (cleaned > 0 || buffersCleared > 0) {
      logger.debug('Cleanup completed', { cleanedSessions: cleaned, buffersAutoCleared: buffersCleared });
    }
  }

  detectZombies() {
    const zombieThreshold = DEFAULT_CONFIG.zombieThresholdMs;
    let detected = 0;
    const details = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const decision = session.shouldMarkZombie(zombieThreshold);

      if (!decision.zombie && decision.reason !== 'still_active' && decision.reason !== 'recently_dead') {
        const logMsg = `Session ${sessionId} protected: ${decision.reason}`;
        if (decision.reason === 'auto_background') {
          logger.debug(logMsg, { command: decision.command || 'unknown' });
        } else {
          logger.debug(logMsg);
        }
      }

      if (decision.zombie) {
        session.markZombie();
        detected++;
        details.push({ sessionId, reason: decision.reason, deadMinutes: decision.deadMinutes });
      }
    }

    if (detected > 0) {
      logger.info('Zombie sessions detected', { count: detected, details });
      this._detectedZombies = this._detectedZombies ? this._detectedZombies.concat(details) : details;
    }

    return { detected, details };
  }

  checkMemoryUsage() {
    const now = Date.now();

    // Check memory every 5 minutes
    if (now - this._lastMemoryCheck < 300000) {
      return;
    }

    this._lastMemoryCheck = now;

    // Recalculate total memory
    let totalMem = 0;
    for (const session of this.sessions.values()) {
      totalMem += session.getMemoryUsage();

      // Check if individual session needs GC
      if (session.shouldTriggerGC()) {
        session.read(true);
        logger.debug('GC triggered - session buffer cleared', { sessionId: session.id });
      }
    }

    this._totalMemoryUsage = totalMem;
    this._gcCounter++;

    const memMB = Math.round(totalMem / 1024 / 1024);
    const thresholdMB = DEFAULT_CONFIG.gcThresholdMB;

    if (memMB > thresholdMB) {
      logger.warn('Total session memory exceeds threshold', {
        memoryMB: memMB,
        thresholdMB,
        sessions: this.sessions.size,
        gcRuns: this._gcCounter
      });

      // Aggressive cleanup
      for (const session of this.sessions.values()) {
        if (session.outputBufferSize > DEFAULT_CONFIG.maxOutputBufferSize / 2) {
          session.read(true);
        }
      }
    }
  }

  getResourceStats() {
    let totalMem = 0;
    const sessionStats = [];

    for (const session of this.sessions.values()) {
      const mem = session.getMemoryUsage();
      totalMem += mem;
      sessionStats.push({
        id: session.id,
        memory: mem,
        state: session.state,
        bufferSize: session.outputBufferSize
      });
    }

    return {
      totalSessions: this.sessions.size,
      totalMemoryBytes: totalMem,
      totalMemoryMB: Math.round(totalMem / 1024 / 1024 * 100) / 100,
      gcCounter: this._gcCounter,
      sessions: sessionStats,
      thresholdMB: DEFAULT_CONFIG.gcThresholdMB,
      maxSessions: this.config?.terminal?.max_sessions || DEFAULT_CONFIG.maxSessions
    };
  }

  /**
   * Kill all sessions (non-destructive, allows recovery)
   * Note: Does NOT set _shutdown flag - use shutdown() for full stop
   */
  killAll(force = false) {
    this.sessions.forEach(session => {
      session.kill(force);
    });
    this.sessions.clear();
    this._totalMemoryUsage = 0;

    if (this.eventEmitter) {
      this.eventEmitter.removeAllListeners();
      this.eventEmitter = new EventEmitter();
    }
  }

  /**
   * Full shutdown - sets _shutdown flag to prevent new sessions
   * After this, SessionManager cannot create new sessions
   */
  shutdown(force = false) {
    this._shutdown = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.killAll(force);
  }

  /**
   * Reset SessionManager to allow new session creation after killAll
   * Only use this if you want to continue using the SessionManager after killAll
   */
  reset() {
    this._shutdown = false;
    this.sessions = new Map();
    this.eventEmitter = new EventEmitter();
    this._totalMemoryUsage = 0;
    this._gcCounter = 0;
    this._lastMemoryCheck = Date.now();

    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        if (!this._shutdown) {
          this.cleanupExpired();
          this.checkMemoryUsage();
          this._cleanupTmuxLocks();
        }
      }, DEFAULT_CONFIG.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  getSessionsByOwner(ownerHttpSessionId) {
    if (!ownerHttpSessionId) return [];
    const result = [];
    for (const [id, session] of this.sessions.entries()) {
      if (session._ownerHttpSessionId === ownerHttpSessionId) {
        result.push(session);
      }
    }
    return result;
  }

  killByOwner(ownerHttpSessionId, force = false) {
    if (!ownerHttpSessionId) return 0;
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session._ownerHttpSessionId === ownerHttpSessionId) {
        session.kill(force);
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Check if SessionManager is available for new sessions
   */
  isAvailable() {
    return !this._shutdown;
  }

  count() {
    return this.sessions.size;
  }

  on(event, callback) {
    this.eventEmitter.on(event, callback);
  }

  off(event, callback) {
    this.eventEmitter.off(event, callback);
  }
}

export { generateSecureId };
